/**
 * 番茄钟公共类型 —— 主进程与渲染进程共享
 */

// ── 状态枚举 ──
export enum TimerState {
  Idle = 'idle',
  Focus = 'focus',
  FocusPaused = 'focusPaused',
  Prolongation = 'prolongation',
  WaitingRest = 'waitingRest',
  Rest = 'rest',
  RestPaused = 'restPaused',
  Celebrating = 'celebrating',
  /** 鞭策专注（P3 彩蛋）：rage 表情、无暂停/重置、25% 脉冲 */
  RageFocus = 'rageFocus',
}

// ── 计时模式 ──
export type TimerMode = 'stopped' | 'countdown' | 'countup' | 'suspended';

// ── 按钮动作（渲染→主） ──
export type ButtonAction =
  | 'start'
  | 'pause'
  | 'continue'
  | 'reset'
  | 'rest'
  | 'close'
  | 'minimize'
  | 'snail'
  | 'stem'
  | 'rockButton';

// ── 过渡动画（P1 握手协议） ──
/**
 * 状态切换附带的过渡动画信息。
 * 渲染进程收到带 transition 的状态后播放对应过渡动画，
 * 播完回调 transition:done，主进程此时才启动新状态计时。
 * （需求规则：过渡期间计时暂停，过渡完全结束后新状态计时才开始）
 */
export interface TransitionInfo {
  /** 过渡动画 id（渲染侧过渡注册表的 key，如 'idle_to_focus'） */
  id: string;
  from: TimerState;
  to: TimerState;
}

// ── 状态→渲染的完整视图数据 ──
export interface TimerDisplayState {
  state: TimerState;
  timerMode: TimerMode;
  minutes: number;
  seconds: number;
  background: 'sun' | 'sun+cloud' | 'night' | 'keep';
  expression: 'idie' | 'focus' | 'prolongation' | 'rest' | 'happy' | 'rage' | 'die';
  button: 'start' | 'pause' | 'reset' | 'rest' | 'none';
  isPinned: boolean;
  /** 非 null 表示本次切换附带过渡动画（计时已挂起，等待渲染回调） */
  transition: TransitionInfo | null;
}

// ── 状态机配置表 ──
export interface StateConfig {
  timerMode: TimerMode;
  background: 'sun' | 'sun+cloud' | 'night' | 'keep';
  expression: 'idie' | 'focus' | 'prolongation' | 'rest' | 'happy' | 'rage' | 'die';
  button: 'start' | 'pause' | 'reset' | 'rest' | 'none';
}

// ── 状态转换事件 ──
export type TransitionCause =
  | 'button:start'
  | 'button:pause'
  | 'button:continue'
  | 'button:reset'
  | 'button:rest'
  | 'button:rockButton'
  | 'timer:complete'
  | 'task:complete';

// ── 默认时长 ──
export const DEFAULT_FOCUS_MINUTES = 30;
export const DEFAULT_SHORT_REST_MINUTES = 5;
export const LONG_REST_AFTER_SHORTS = 3; // 每完成3次小休后，下一次为长休
export const LONG_REST_MULTIPLIER = 3; // 长休 = 小休 × 3
export const COUNTUP_MAX_SECONDS = 99 * 60 + 59; // 延时正计时显示上限 99:59

// ── 状态→配置 映射表 ──
export const STATE_CONFIG: Record<TimerState, StateConfig> = {
  [TimerState.Idle]: {
    timerMode: 'stopped',
    background: 'sun',
    expression: 'idie',
    button: 'start',
  },
  [TimerState.Focus]: {
    timerMode: 'countdown',
    background: 'sun',
    expression: 'focus',
    button: 'pause',
  },
  [TimerState.FocusPaused]: {
    timerMode: 'stopped',
    background: 'sun',
    expression: 'idie',
    button: 'reset',
  },
  [TimerState.Prolongation]: {
    timerMode: 'countup',
    background: 'sun+cloud',
    expression: 'prolongation',
    button: 'rest',
  },
  [TimerState.WaitingRest]: {
    timerMode: 'stopped',
    background: 'night',
    expression: 'rest',
    button: 'start',
  },
  [TimerState.Rest]: {
    timerMode: 'countdown',
    background: 'night',
    expression: 'rest',
    button: 'pause',
  },
  [TimerState.RestPaused]: {
    timerMode: 'stopped',
    background: 'night',
    expression: 'rest',
    button: 'reset',
  },
  [TimerState.Celebrating]: {
    timerMode: 'suspended',
    background: 'keep',
    expression: 'happy',
    button: 'none',
  },
  [TimerState.RageFocus]: {
    timerMode: 'countdown',
    background: 'sun',
    expression: 'rage',
    button: 'none', // 鞭策：无暂停/重置按钮，只能等倒计时结束
  },
};
