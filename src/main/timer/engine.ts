/**
 * TimerEngine —— 秒级精度的计时引擎
 *
 * 运行在主进程，通过 setInterval 驱动，
 * 避免渲染进程繁忙导致计时漂移。
 */

import type { TimerMode } from './types';
import { COUNTUP_MAX_SECONDS } from './types';

export interface TimerEngineState {
  mode: TimerMode;
  /** 目标时长（秒），countdown 模式使用 */
  targetSeconds: number;
  /** 已过去秒数 */
  elapsedSeconds: number;
}

export class TimerEngine {
  private state: TimerEngineState = {
    mode: 'stopped',
    targetSeconds: 0,
    elapsedSeconds: 0,
  };

  private intervalId: ReturnType<typeof setInterval> | null = null;

  /** 每 tick 回调：{ minutes, seconds, elapsedSeconds, mode } */
  private onTick: ((data: {
    minutes: number;
    seconds: number;
    elapsedSeconds: number;
    mode: TimerMode;
  }) => void) | null = null;

  /** 计时完成回调 */
  private onComplete: (() => void) | null = null;

  // ── public API ──

  setOnTick(cb: typeof this.onTick): void {
    this.onTick = cb;
  }

  setOnComplete(cb: typeof this.onComplete): void {
    this.onComplete = cb;
  }

  /** 开始倒计时 */
  startCountdown(targetSeconds: number): void {
    this.stopInterval();
    this.state = {
      mode: 'countdown',
      targetSeconds,
      elapsedSeconds: 0,
    };
    this.emit();
    this.startInterval();
  }

  /** 开始正计时 */
  startCountup(): void {
    this.stopInterval();
    this.state = {
      mode: 'countup',
      targetSeconds: 0,
      elapsedSeconds: 0,
    };
    this.emit();
    this.startInterval();
  }

  /** 暂停 */
  pause(): void {
    this.stopInterval();
    // mode 不变，外部通过 FSM 切换到 paused 状态
  }

  /** 恢复 */
  resume(): void {
    if (this.state.mode === 'stopped' || this.state.mode === 'suspended') return;
    this.startInterval();
  }

  /**
   * 停止并重置。
   * 紧接着状态切换时可静默执行，避免渲染层先收到一帧 00:00。
   */
  stop(emit = true): void {
    this.stopInterval();
    this.state = {
      mode: 'stopped',
      targetSeconds: 0,
      elapsedSeconds: 0,
    };
    if (emit) this.emit();
  }

  /** 获取当前显示值 */
  getDisplay(): { minutes: number; seconds: number } {
    if (this.state.mode === 'countdown') {
      const remaining = Math.max(0, this.state.targetSeconds - this.state.elapsedSeconds);
      return {
        minutes: Math.floor(remaining / 60),
        seconds: remaining % 60,
      };
    }
    if (this.state.mode === 'countup') {
      return {
        minutes: Math.floor(this.state.elapsedSeconds / 60),
        seconds: this.state.elapsedSeconds % 60,
      };
    }
    // stopped / suspended → 返回目标值
    return {
      minutes: Math.floor(this.state.targetSeconds / 60),
      seconds: this.state.targetSeconds % 60,
    };
  }

  getState(): Readonly<TimerEngineState> {
    return this.state;
  }

  // ── private ──

  private startInterval(): void {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => this.tick(), 1000);
  }

  private stopInterval(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private tick(): void {
    // 延时正计时到达 99:59 上限：停表但保持状态，等待手动点击休息
    if (
      this.state.mode === 'countup' &&
      this.state.elapsedSeconds >= COUNTUP_MAX_SECONDS
    ) {
      this.stopInterval();
      return;
    }

    this.state.elapsedSeconds++;

    if (this.state.mode === 'countdown') {
      const remaining = this.state.targetSeconds - this.state.elapsedSeconds;
      this.emit();
      if (remaining <= 0) {
        this.stopInterval();
        this.onComplete?.();
      }
    } else if (this.state.mode === 'countup') {
      this.emit();
    }
  }

  private emit(): void {
    const display = this.getDisplay();
    this.onTick?.({
      ...display,
      elapsedSeconds: this.state.elapsedSeconds,
      mode: this.state.mode,
    });
  }
}
