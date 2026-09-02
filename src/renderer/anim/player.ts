/**
 * Timeline 播放器 —— 运行时实例管理
 *
 * 职责：
 * - play() 把 TimelineDef 编译为一个独立 Playback 实例（同一动画可并发多实例）
 * - Playback 生命周期：pause / resume / cancel / finishAfterLoop
 * - cancelAll()：状态切换等场景下一键清场（等价于旧 epoch 机制的"立即停止"）
 *
 * 关键语义（与 M3 呼吸动画的 epoch 机制对应关系）：
 * - cancel()          立即停止，属性停留在当前值（还原由调用方/布局系统负责）
 *                     —— 对应旧 stopKind()
 * - finishAfterLoop() 当前循环跑到周期末尾后自然结束，值回到周期起始态
 *                     —— 对应旧"优雅暂停"（epoch 递增让下一轮递归自退）
 * - withdrawFinish()  撤销优雅停止请求，循环继续运行
 *                     —— 快速 暂停→恢复 时"顺着播"的基础能力
 * - ensureLoop()      具名循环的幂等启动：活跃（含优雅停止途中）则撤销停止、
 *                     相位连续复用；否则执行 def 工厂全新启动
 * - loop 选项          true=无限循环；N=共播放 N 次；缺省=播放一次
 * - startDelay 选项    首次播放前等待 ms（只生效一次，循环周期内不重复）
 * - 事件               时间轴首次经过 at 触发一次；循环时每轮重新武装
 */
import { addTick } from '../anime';
import { ActionRegistry, TargetRegistry } from './targets';
import {
  CompiledTimeline,
  TimelineDef,
  compileTimeline,
  evaluateTimeline,
} from './timeline';

export interface PlaybackResult {
  cancelled: boolean;
}

export interface PlayOptions {
  /** true=无限循环；数字=共播放 N 次；缺省播放一次 */
  loop?: boolean | number;
  /** 首次播放前的等待 ms（循环不重复此延迟） */
  startDelay?: number;
}

export interface Playback {
  readonly name: string;
  /** 结束 Promise（cancel 也会 resolve，以 cancelled 区分），永不应有未处理拒绝 */
  readonly finished: Promise<PlaybackResult>;
  readonly done: boolean;
  pause(): void;
  resume(): void;
  cancel(): void;
  finishAfterLoop(): void;
  /**
   * 撤销优雅停止请求（finishAfterLoop 的逆操作）：循环继续运行。
   * 已结束的实例调用无效并返回 false。
   * 一般通过 TimelinePlayer.ensureLoop 间接使用，不建议直接调用。
   */
  withdrawFinish(): boolean;
}

class PlaybackImpl implements Playback {
  readonly name: string;
  readonly finished: Promise<PlaybackResult>;
  done = false;

  private resolveFinished!: (r: PlaybackResult) => void;
  private elapsed: number;
  private paused = false;
  private cancelled = false;
  private stopAtLoopEnd = false;
  private loopsDone = 0;
  /** 本轮已触发的事件下标（循环时每轮清空重新武装） */
  private fired = new Set<number>();

  constructor(
    private compiled: CompiledTimeline,
    private opts: PlayOptions,
    private actions: ActionRegistry | undefined,
    private onDispose: () => void
  ) {
    this.name = compiled.name;
    this.elapsed = -(opts.startDelay ?? 0);
    this.finished = new Promise((res) => {
      this.resolveFinished = res;
    });
    if (compiled.events.length > 0 && !actions) {
      console.warn(
        `[anim:player] "${this.name}" 含 ${compiled.events.length} 个事件但未提供 ActionRegistry，事件将被忽略`
      );
    }
    addTick(this.tick);
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  cancel(): void {
    if (this.done) return;
    this.cancelled = true;
    this.settle({ cancelled: true });
  }

  finishAfterLoop(): void {
    this.stopAtLoopEnd = true;
  }

  withdrawFinish(): boolean {
    if (this.done) return false;
    this.stopAtLoopEnd = false;
    return true;
  }

  /** 是否再循环一轮（loop: N 表示共播放 N 次） */
  private shouldLoop(): boolean {
    const { loop } = this.opts;
    if (loop === true) return true;
    if (typeof loop === 'number') return this.loopsDone < loop - 1;
    return false;
  }

  private tick = (dt: number): boolean => {
    if (this.cancelled) return false; // settle 已在 cancel() 内完成，此处摘除帧回调
    if (this.paused) return true;
    this.elapsed += dt;
    if (this.elapsed < 0) return true; // startDelay 等待期，不写任何属性

    const dur = this.compiled.duration;
    if (this.elapsed >= dur) {
      if (this.shouldLoop() && !this.stopAtLoopEnd) {
        // 循环回绕：先补触发周期尾部事件（不丢事件），再进入下一轮
        this.fireEventsUpTo(dur);
        this.loopsDone++;
        this.elapsed -= dur;
        this.fired.clear();
      } else {
        // 结束：钉在末帧求值，保证终态确定
        evaluateTimeline(this.compiled, dur);
        this.fireEventsUpTo(dur);
        this.settle({ cancelled: false });
        return false;
      }
    }
    evaluateTimeline(this.compiled, this.elapsed);
    this.fireEventsUpTo(this.elapsed);
    return true;
  };

  private fireEventsUpTo(t: number): void {
    const events = this.compiled.events;
    for (let i = 0; i < events.length; i++) {
      if (events[i].at <= t && !this.fired.has(i)) {
        this.fired.add(i);
        this.actions?.run(events[i].action, events[i].args);
      }
    }
  }

  private settle(result: PlaybackResult): void {
    this.done = true;
    this.resolveFinished(result);
    this.onDispose();
  }
}

export class TimelinePlayer {
  private active = new Set<PlaybackImpl>();
  /** 具名循环注册表：ensureLoop 幂等复用的依据；实例 settle 时自动清除 */
  private namedLoops = new Map<string, PlaybackImpl>();

  constructor(
    private targets: TargetRegistry,
    private actions?: ActionRegistry
  ) {}

  /**
   * 播放一条 Timeline。
   * 数据非法时 compileTimeline 抛错（尽早暴露）；目标缺失仅告警丢轨。
   */
  play(def: TimelineDef, opts: PlayOptions = {}): Playback {
    return this.playInternal(def, opts);
  }

  /**
   * 具名循环的幂等启动 —— "顺着播"语义：
   *
   * 同名循环仍活跃（包括 finishAfterLoop 优雅停止途中）：
   *   撤销其停止请求并原样返回，动画相位连续、画面无跳变；
   *   def 工厂不会执行（即精灵装配等副作用只在全新启动时发生）。
   * 同名循环不存在或已结束：执行工厂构建定义并启动新实例。
   *
   * 典型场景：快速 暂停→恢复 时循环不应从头重播，而是接着当前相位继续。
   * 注意：复用时忽略新的 opts/def，沿用原实例配置；参数已变化的循环
   *       应由调用方先 cancel 再 ensureLoop（参考 breathing.startPulse）。
   */
  ensureLoop(
    key: string,
    defOrFactory: TimelineDef | (() => TimelineDef),
    opts: PlayOptions = {}
  ): { playback: Playback; reused: boolean } {
    const existing = this.namedLoops.get(key);
    if (existing && !existing.done) {
      existing.withdrawFinish();
      return { playback: existing, reused: true };
    }
    const def = typeof defOrFactory === 'function' ? defOrFactory() : defOrFactory;
    return { playback: this.playInternal(def, opts, key), reused: false };
  }

  /** 立即取消所有进行中的播放（状态切换清场用；具名循环一并清除） */
  cancelAll(): void {
    for (const p of Array.from(this.active)) p.cancel();
  }

  get activeCount(): number {
    return this.active.size;
  }

  private playInternal(
    def: TimelineDef,
    opts: PlayOptions,
    loopKey?: string
  ): PlaybackImpl {
    const compiled = compileTimeline(def, this.targets);
    let playback!: PlaybackImpl;
    playback = new PlaybackImpl(compiled, opts, this.actions, () => {
      this.active.delete(playback);
      if (loopKey && this.namedLoops.get(loopKey) === playback) {
        this.namedLoops.delete(loopKey);
      }
    });
    this.active.add(playback);
    if (loopKey) this.namedLoops.set(loopKey, playback);
    return playback;
  }
}
