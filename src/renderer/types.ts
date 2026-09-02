/**
 * 渲染进程共享类型
 */

/** 过渡动画信息（P1 握手协议，主进程随状态广播） */
export interface TransitionInfo {
  id: string;
  from: string;
  to: string;
}

/** 主进程广播的计时显示状态 */
export interface TimerDisplayState {
  state: string;
  timerMode: string;
  minutes: number;
  seconds: number;
  background: string;
  expression: string;
  button: string;
  isPinned: boolean;
  /** 非 null 表示本次切换附带过渡动画（主进程计时已挂起） */
  transition: TransitionInfo | null;
}
