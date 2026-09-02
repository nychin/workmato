/**
 * TimerFSM —— 番茄钟状态机
 *
 * 管理状态流转 + 计时引擎调度 + 休息计数。
 * 运行在主进程。
 */

import { TimerEngine } from './engine';
import {
  TimerState,
  TimerDisplayState,
  ButtonAction,
  TransitionCause,
  STATE_CONFIG,
  DEFAULT_FOCUS_MINUTES,
  DEFAULT_SHORT_REST_MINUTES,
  LONG_REST_AFTER_SHORTS,
  LONG_REST_MULTIPLIER,
  COUNTUP_MAX_SECONDS,
} from './types';
import type { TimerSettings } from '../../shared/settings';

// ── 过渡注册表（P1） ──
// key = "from->to"；命中即挂起计时、等待渲染进程播完过渡动画回调。
// afterDone 决定过渡完成后起什么表（none = 目标状态本身不计时）。
type AfterTransition = 'startFocus' | 'startRest' | 'startCountup' | 'none';

interface TransitionDef {
  id: string;
  afterDone: AfterTransition;
}

const TRANSITION_TABLE: Record<string, TransitionDef> = {
  [`${TimerState.Idle}->${TimerState.Focus}`]: { id: 'idle_to_focus', afterDone: 'startFocus' },
  // focus→prolongation 过渡不暂停计时（afterDone=none，countup 在 handleTimerComplete 立即启动）
  [`${TimerState.Focus}->${TimerState.Prolongation}`]: { id: 'focus_to_prolongation', afterDone: 'none' },
  [`${TimerState.Prolongation}->${TimerState.WaitingRest}`]: { id: 'prolongation_to_waitingRest', afterDone: 'none' },
  [`${TimerState.Rest}->${TimerState.Idle}`]: { id: 'rest_to_idle', afterDone: 'none' },
  // 休息暂停时手动重置也播 rest_to_idle 过渡
  [`${TimerState.RestPaused}->${TimerState.Idle}`]: { id: 'rest_to_idle', afterDone: 'none' },
  // P3 鞭策：两种触发均播"进入鞭策专注"过渡，完成后起表
  [`${TimerState.FocusPaused}->${TimerState.RageFocus}`]: { id: 'enter_rage', afterDone: 'startFocus' },
  [`${TimerState.Idle}->${TimerState.RageFocus}`]: { id: 'enter_rage', afterDone: 'startFocus' },
};

/** 鞭策触发参数（P3，沟通文档定值） */
const RAGE_RESET_WINDOW_MS = 10000; // 方式一：10s 内重置 3 次
const RAGE_RESET_COUNT = 3;
const RAGE_ROCK_WINDOW_MS = 3000; // 方式二：3s 窗口
const RAGE_ROCK_ENTER = 3; // 闲置 3 连击进入
const RAGE_ROCK_EXIT = 10; // 10 连击退出

/** 过渡 watchdog：渲染进程异常未回调时强制起表，防计时卡死 */
const TRANSITION_WATCHDOG_MS = 8000;
/** 庆祝 watchdog：庆祝约 6.4s，12s 未回调强制恢复计时 */
const CELEBRATE_WATCHDOG_MS = 12000;

export class TimerFSM {
  private currentState: TimerState = TimerState.Idle;
  private engine: TimerEngine;
  private onStateChange: ((display: TimerDisplayState) => void) | null = null;
  private onTick: ((display: TimerDisplayState) => void) | null = null;
  private onFocusStarted: ((plannedSeconds: number) => void) | null = null;
  private onFocusEnded: ((focusSeconds: number, completed: boolean, finalize: boolean) => void) | null = null;

  // ── 小休计数（达到 configured long-rest interval 后下一次为长休） ──
  private restsSinceLong = 0;
  private previousState: TimerState = TimerState.Idle; // 庆祝前状态

  // ── 过渡锁（P1）：非 null 表示过渡动画播放中，计时挂起、输入锁定 ──
  private pendingTransition: { def: TransitionDef; from: TimerState; to: TimerState } | null = null;
  private transitionWatchdog: ReturnType<typeof setTimeout> | null = null;
  /** 庆祝 watchdog 句柄 */
  private celebrateWatchdog: ReturnType<typeof setTimeout> | null = null;

  // ── 鞭策模式（P3 彩蛋） ──
  // none=普通；oneShot=方式一（该次归零后自动退出）；persistent=方式二（10 连击/重启才退出）
  private rageMode: 'none' | 'oneShot' | 'persistent' = 'none';
  /** 重置时间戳（方式一滑动窗口计数） */
  private resetTimes: number[] = [];
  /** rock_button 点击时间戳（方式二进出共用滑动窗口） */
  private rockClickTimes: number[] = [];

  // ── 可配置时长（秒） ──
  private focusSeconds = DEFAULT_FOCUS_MINUTES * 60;
  private shortRestSeconds = DEFAULT_SHORT_REST_MINUTES * 60;
  private longRestSeconds = DEFAULT_SHORT_REST_MINUTES * LONG_REST_MULTIPLIER * 60;
  private longRestInterval = LONG_REST_AFTER_SHORTS;
  private restMode: TimerSettings['restMode'] = 'auto';
  private autoShortRestRatio = 0.2;
  private autoLongRestRatio = 0.6;
  private includeProlongationInAutoRest = false;
  private activeFocusPlannedSeconds = this.focusSeconds;
  private lastCompletedFocusSeconds = this.focusSeconds;
  private lastProlongationSeconds = 0;

  // ── 是否置顶 ──
  private isPinned = false;
  /** 延时上限彩蛋（die 表情）是否已广播：只触发一次，避免每次 tick 重装布局 */
  private easterEggShown = false;

  constructor() {
    this.engine = new TimerEngine();
    this.engine.setOnTick(() => {
      const display = this.buildDisplay();
      // 彩蛋触发：延时正计时到达上限（默认 99:59）时，主动广播一次状态变化，
      // 让渲染层重装布局把 02 层表情换成 die（同状态内变化不触发 onStateChange）
      if (
        this.currentState === TimerState.Prolongation &&
        this.engine.getState().mode === 'countup' &&
        this.engine.getState().elapsedSeconds >= COUNTUP_MAX_SECONDS &&
        !this.easterEggShown
      ) {
        this.easterEggShown = true;
        this.onStateChange?.(display);
      }
      this.onTick?.(display);
    });
    this.engine.setOnComplete(() => {
      this.handleTimerComplete();
    });
  }

  // ── 生命周期 ──

  setOnStateChange(cb: (display: TimerDisplayState) => void): void {
    this.onStateChange = cb;
  }

  setOnTick(cb: (display: TimerDisplayState) => void): void {
    this.onTick = cb;
  }

  setOnFocusStarted(cb: (plannedSeconds: number) => void): void {
    this.onFocusStarted = cb;
  }

  setOnFocusEnded(cb: (focusSeconds: number, completed: boolean, finalize: boolean) => void): void {
    this.onFocusEnded = cb;
  }

  /** 获取当前完整状态 */
  getDisplay(): TimerDisplayState {
    return this.buildDisplay();
  }

  /** 获取当前置顶状态，供主进程同步原生窗口属性。 */
  getIsPinned(): boolean {
    return this.isPinned;
  }

  /** 将原生窗口实际置顶状态同步回状态机。 */
  setPinned(pinned: boolean): void {
    this.isPinned = pinned;
  }

  // ── 按钮动作入口 ──

  dispatchAction(action: ButtonAction): void {
    // 过渡期间锁输入（置顶不受限——纯窗口属性，不影响计时）
    if (this.pendingTransition) {
      if (action === 'stem') this.handleStemToggle();
      else console.log(`[FSM] 过渡 ${this.pendingTransition.def.id} 播放中，忽略操作: ${action}`);
      return;
    }
    switch (action) {
      case 'start':   this.handleStart(); break;
      case 'pause':   this.handlePause(); break;
      case 'continue': this.handleContinue(); break;
      case 'reset':   this.handleReset(); break;
      case 'rest':    this.handleRest(); break;
      case 'stem':    this.handleStemToggle(); break;
      case 'rockButton': this.handleRockButton(); break;
      default: break;
    }
  }

  /** Global shortcut entry point. It never resets a timer or bypasses transition locks. */
  dispatchPrimaryShortcut(): void {
    if (this.pendingTransition) return;
    switch (this.currentState) {
      case TimerState.Idle:
      case TimerState.WaitingRest:
        this.handleStart();
        break;
      case TimerState.Focus:
      case TimerState.Rest:
        this.handlePause();
        break;
      case TimerState.FocusPaused:
      case TimerState.RestPaused:
        this.handleContinue();
        break;
      case TimerState.Prolongation:
        this.handleRest();
        break;
      default:
        break;
    }
  }

  // ── 鞭策彩蛋（P3） ──
  // 方式二进入：闲置状态 3s 内连点 3 次 rock_button → 持久鞭策
  // 方式二退出：任意状态 3s 内连按 10 次 rock_button（或重启——rageMode 仅存内存）

  private handleRockButton(): void {
    const now = Date.now();
    this.rockClickTimes = this.rockClickTimes.filter((t) => now - t < RAGE_ROCK_WINDOW_MS);
    this.rockClickTimes.push(now);
    // 退出判定优先（持久模式下任何状态都可触发）
    if (this.rageMode === 'persistent' && this.rockClickTimes.length >= RAGE_ROCK_EXIT) {
      this.rockClickTimes = [];
      this.rageMode = 'none';
      console.log('[FSM] 鞭策模式退出（rock_button 10 连击）');
      return;
    }
    if (
      this.rageMode === 'none' &&
      this.currentState === TimerState.Idle &&
      this.rockClickTimes.length >= RAGE_ROCK_ENTER
    ) {
      this.rockClickTimes = [];
      this.rageMode = 'persistent';
      console.log('[FSM] 鞭策模式进入（rock_button 3 连击，持久）');
      this.transitionTo(TimerState.RageFocus, 'button:rockButton');
      if (!this.pendingTransition) this.startFocusCountdown();
    }
  }

  /** 调试模式：强制切换状态（停表、清过渡锁、直接广播） */
  debugForceState(state: TimerState): void {
    console.log(`[FSM] 调试强制切换: ${this.currentState} → ${state}`);
    this.engine.stop(false);
    this.pendingTransition = null;
    if (this.transitionWatchdog) {
      clearTimeout(this.transitionWatchdog);
      this.transitionWatchdog = null;
    }
    this.currentState = state;
    this.onStateChange?.(this.buildDisplay());
  }

  /** 任务完成触发庆祝（仅 专注/延时/鞭策 状态响应；庆祝中再触发忽略） */
  dispatchCelebrate(): void {
    if (this.pendingTransition) return; // 过渡播放中不响应
    // 文档规则：只在专注、延时、鞭策状态触发
    if (
      this.currentState !== TimerState.Focus &&
      this.currentState !== TimerState.Prolongation &&
      this.currentState !== TimerState.RageFocus
    ) return;
    this.previousState = this.currentState;
    this.engine.pause(); // 记录计时并暂停，庆祝完全结束后 resume
    this.transitionTo(TimerState.Celebrating, 'task:complete');
    // watchdog：渲染进程异常未回调时强制恢复，防计时永久挂起
    this.celebrateWatchdog = setTimeout(() => {
      console.warn('[FSM] 庆祝超时未回调，watchdog 强制恢复');
      this.finishCelebrate();
    }, CELEBRATE_WATCHDOG_MS);
  }

  /** 庆祝完毕恢复（渲染进程播完全部庆祝动画后回调） */
  finishCelebrate(): void {
    if (this.currentState !== TimerState.Celebrating) return;
    if (this.celebrateWatchdog) {
      clearTimeout(this.celebrateWatchdog);
      this.celebrateWatchdog = null;
    }
    this.transitionTo(this.previousState, 'task:complete');
    this.engine.resume();
  }

  // ── 时长设置 ──

  setFocusDuration(minutes: number): void {
    this.focusSeconds = minutes * 60;
  }

  setShortRestDuration(minutes: number): void {
    this.shortRestSeconds = minutes * 60;
  }

  /** Applies future-cycle timer settings without changing a running countdown. */
  applySettings(settings: TimerSettings): void {
    this.focusSeconds = settings.focusMinutes * 60;
    this.restMode = settings.restMode;
    this.autoShortRestRatio = settings.autoShortRestRatio;
    this.autoLongRestRatio = settings.autoLongRestRatio;
    this.includeProlongationInAutoRest = settings.includeProlongationInAutoRest;
    this.shortRestSeconds = settings.shortRestMinutes * 60;
    this.longRestSeconds = settings.longRestMinutes * 60;
    this.longRestInterval = settings.longRestInterval;
    if (this.currentState === TimerState.Idle || this.currentState === TimerState.WaitingRest) {
      this.onStateChange?.(this.buildDisplay());
    }
  }

  /** 仅允许在两个等待状态修改当前阶段的分钟数。 */
  setWaitingDuration(minutes: number): boolean {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 99 || this.pendingTransition) {
      return false;
    }
    if (this.currentState === TimerState.Idle) {
      this.setFocusDuration(minutes);
    } else if (this.currentState === TimerState.WaitingRest) {
      if (this.restMode === 'auto') return false;
      if (this.isLongRestDue()) this.longRestSeconds = minutes * 60;
      else this.setShortRestDuration(minutes);
    } else {
      return false;
    }
    this.onStateChange?.(this.buildDisplay());
    return true;
  }

  getFocusDurationMinutes(): number {
    return Math.floor(this.focusSeconds / 60);
  }

  /** Whether the next waiting-rest countdown is a long rest. */
  isLongRestDue(): boolean {
    return this.restsSinceLong >= this.longRestInterval;
  }

  // ── private: 状态转换 ──

  private handleStart(): void {
    switch (this.currentState) {
      case TimerState.Idle:
        // 持久鞭策：闲置 start 再次进入鞭策专注（而非普通专注）
        if (this.rageMode === 'persistent') {
          this.transitionTo(TimerState.RageFocus, 'button:start');
        } else {
          // 闲置 → 专注（有过渡动画：起表推迟到过渡完成回调）
          this.transitionTo(TimerState.Focus, 'button:start');
        }
        if (!this.pendingTransition) this.startFocusCountdown();
        break;
      case TimerState.WaitingRest:
        // 先让倒计时拥有正确初始值，再切到休息状态。
        // 反过来会让渲染层先收到一次 Rest + 00:00，随后才收到真实休息时长，形成数字闪烁。
        this.engine.startCountdown(this.getRestDuration());
        this.transitionTo(TimerState.Rest, 'button:start');
        break;
      default: break;
    }
  }

  private handlePause(): void {
    switch (this.currentState) {
      case TimerState.Focus:
        this.engine.pause();
        this.transitionTo(TimerState.FocusPaused, 'button:pause');
        break;
      case TimerState.Rest:
        this.engine.pause();
        this.transitionTo(TimerState.RestPaused, 'button:pause');
        break;
      default: break;
    }
  }

  private handleContinue(): void {
    switch (this.currentState) {
      case TimerState.FocusPaused:
        this.engine.resume();
        this.transitionTo(TimerState.Focus, 'button:continue');
        break;
      case TimerState.RestPaused:
        this.engine.resume();
        this.transitionTo(TimerState.Rest, 'button:continue');
        break;
      default: break;
    }
  }

  private handleReset(): void {
    switch (this.currentState) {
      case TimerState.FocusPaused: {
        this.finishFocusSession(false);
        this.engine.stop(false);
        // 鞭策触发方式一：10s 内第 3 次重置专注 → 直入鞭策专注（不经过闲置）
        const now = Date.now();
        this.resetTimes = this.resetTimes.filter((t) => now - t < RAGE_RESET_WINDOW_MS);
        this.resetTimes.push(now);
        if (this.resetTimes.length >= RAGE_RESET_COUNT) {
          this.resetTimes = [];
          if (this.rageMode === 'none') this.rageMode = 'oneShot';
          console.log('[FSM] 鞭策模式进入（10s 内 3 次重置，单次）');
          this.transitionTo(TimerState.RageFocus, 'button:reset');
          if (!this.pendingTransition) this.startFocusCountdown();
        } else {
          this.transitionTo(TimerState.Idle, 'button:reset');
        }
        break;
      }
      case TimerState.RestPaused:
        // 重置 = 直接归零休息时间，视同休息完成，进入下一状态
        this.countCompletedRest();
        this.engine.stop(false);
        this.transitionTo(TimerState.Idle, 'button:reset');
        break;
      default: break;
    }
  }

  private handleRest(): void {
    if (this.currentState === TimerState.Prolongation) {
      const state = this.engine.getState();
      this.lastProlongationSeconds = state.mode === 'countup' ? Math.max(0, Math.floor(state.elapsedSeconds)) : 0;
      this.lastCompletedFocusSeconds = this.activeFocusPlannedSeconds;
      this.onFocusEnded?.(this.activeFocusPlannedSeconds + this.lastProlongationSeconds, true, true);
      this.engine.stop(false);
      this.transitionTo(TimerState.WaitingRest, 'button:rest');
    }
  }

  private handleStemToggle(): void {
    this.isPinned = !this.isPinned;
    // 通知渲染（stem 状态改变也会触发 display 更新）
    this.onStateChange?.(this.buildDisplay());
  }

  private handleTimerComplete(): void {
    switch (this.currentState) {
      case TimerState.Focus:
      case TimerState.RageFocus:
        // 方式一鞭策：该次倒计时归零自动退出（后续走普通状态机）；
        // 持久鞭策不清除（闲置 start 再次进入鞭策）
        if (this.currentState === TimerState.RageFocus && this.rageMode === 'oneShot') {
          this.rageMode = 'none';
          console.log('[FSM] 鞭策模式退出（单次鞭策归零）');
        }
        // 先持久化基础番茄作为检查点；延时结束时用相同记录 ID 覆盖总时长。
        this.onFocusEnded?.(this.activeFocusPlannedSeconds, true, false);
        // 专注倒计时归零 → 延时（过渡动画不暂停计时，立即开始正计时）
        this.transitionTo(TimerState.Prolongation, 'timer:complete');
        this.engine.startCountup();
        break;
      case TimerState.Rest:
        // 休息倒计时归零
        this.countCompletedRest();
        this.engine.stop(false);
        this.transitionTo(TimerState.Idle, 'timer:complete');
        break;
      default: break;
    }
  }

  // ── 过渡握手（P1） ──

  private transitionTo(newState: TimerState, cause: TransitionCause): void {
    if (this.currentState === newState) return;
    const from = this.currentState;
    console.log(`[FSM] ${from} → ${newState} (${cause})`);
    // 命中过渡注册表 → 挂起计时并置锁，等渲染进程回调 transition:done
    const def = TRANSITION_TABLE[`${from}->${newState}`] ?? null;
    this.pendingTransition = def ? { def, from, to: newState } : null;
    if (this.pendingTransition) {
      this.transitionWatchdog = setTimeout(() => {
        console.warn(`[FSM] 过渡 ${def.id} 超时未回调，watchdog 强制完成`);
        this.completeTransition(def.id);
      }, TRANSITION_WATCHDOG_MS);
    }
    this.currentState = newState;
    this.onStateChange?.(this.buildDisplay());
  }

  /** 渲染进程过渡动画播完回调（过期/重复回调安全忽略） */
  notifyTransitionDone(id: string): void {
    if (!this.pendingTransition || this.pendingTransition.def.id !== id) {
      console.log(`[FSM] 忽略过期过渡回调: ${id}`);
      return;
    }
    this.completeTransition(id);
  }

  /** 过渡完成：按 afterDone 起表（engine 起表即广播 tick，显示自动同步） */
  private completeTransition(id: string): void {
    const pending = this.pendingTransition;
    if (!pending || pending.def.id !== id) return;
    this.pendingTransition = null;
    if (this.transitionWatchdog) {
      clearTimeout(this.transitionWatchdog);
      this.transitionWatchdog = null;
    }
    switch (pending.def.afterDone) {
      case 'startFocus':
        this.startFocusCountdown();
        break;
      case 'startRest':
        this.engine.startCountdown(this.getRestDuration());
        break;
      case 'startCountup':
        this.engine.startCountup();
        break;
      case 'none':
        // 目标状态不计时，显示为静态初始时长（过渡期间已正确显示），无需广播
        break;
    }
  }

  // ── private: 休息时长计算 ──

  /** 记录一次休息完成：长休后计数归零，否则累加小休次数 */
  private countCompletedRest(): void {
    const wasLong = this.restsSinceLong >= this.longRestInterval;
    this.restsSinceLong = wasLong ? 0 : this.restsSinceLong + 1;
  }

  private getRestDuration(): number {
    const automaticFocusBase = this.lastCompletedFocusSeconds
      + (this.includeProlongationInAutoRest ? this.lastProlongationSeconds : 0);
    const shortRest = this.restMode === 'auto'
      ? Math.max(1, Math.round(automaticFocusBase * this.autoShortRestRatio))
      : this.shortRestSeconds;
    const longRest = this.restMode === 'auto'
      ? Math.max(1, Math.round(automaticFocusBase * this.autoLongRestRatio))
      : this.longRestSeconds;
    return this.restsSinceLong >= this.longRestInterval ? longRest : shortRest;
  }

  private startFocusCountdown(): void {
    this.engine.startCountdown(this.focusSeconds);
    this.activeFocusPlannedSeconds = this.focusSeconds;
    this.lastProlongationSeconds = 0;
    this.onFocusStarted?.(this.focusSeconds);
  }

  private finishFocusSession(completed: boolean): void {
    const state = this.engine.getState();
    if (state.mode !== 'countdown') return;
    this.onFocusEnded?.(state.elapsedSeconds, completed, true);
  }

  // ── private: 构建 Display ──

  private buildDisplay(): TimerDisplayState {
    const config = STATE_CONFIG[this.currentState];
    const engineDisplay = this.engine.getDisplay();

    // 停止/挂起状态、以及过渡期间（engine 尚未起表）：显示预定初始时长
    let { minutes, seconds } = engineDisplay;
    const showPlanned =
      config.timerMode === 'stopped' ||
      config.timerMode === 'suspended' ||
      this.pendingTransition !== null;
    if (showPlanned) {
      if (this.currentState === TimerState.Idle) {
        minutes = Math.floor(this.focusSeconds / 60);
        seconds = this.focusSeconds % 60;
      } else if (this.currentState === TimerState.WaitingRest) {
        const restDuration = this.getRestDuration();
        minutes = Math.floor(restDuration / 60);
        seconds = restDuration % 60;
      } else if (
        this.currentState === TimerState.Focus ||
        this.currentState === TimerState.RageFocus
      ) {
        // idle→focus / 进入鞭策 过渡期间：显示专注初始时长
        minutes = Math.floor(this.focusSeconds / 60);
        seconds = this.focusSeconds % 60;
      } else if (this.currentState === TimerState.Prolongation) {
        // focus→prolongation 过渡期间：正计时从 00:00 起跳
        minutes = 0;
        seconds = 0;
      }
    }

    return {
      state: this.currentState,
      timerMode: config.timerMode,
      minutes,
      seconds,
      background: config.background,
      expression:
        // 彩蛋：仅当真正处于 countup 正计时并到达上限（默认 99:59）后，02 层表情切换为 die。
        // 必须带 mode==='countup' 判断，避免 focus→prolongation 过渡瞬间
        // engine 仍停留在 countdown 模式、elapsedSeconds 还是倒计时累计值而误触发。
        this.currentState === TimerState.Prolongation &&
        this.engine.getState().mode === 'countup' &&
        this.engine.getState().elapsedSeconds >= COUNTUP_MAX_SECONDS
          ? 'die'
          : config.expression,
      button: config.button,
      isPinned: this.isPinned,
      transition: this.pendingTransition
        ? {
            id: this.pendingTransition.def.id,
            from: this.pendingTransition.from,
            to: this.pendingTransition.to,
          }
        : null,
    };
  }
}
