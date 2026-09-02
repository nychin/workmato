/**
 * window.tomatoAPI 类型声明
 */
import type { TimerDisplayState, TransitionInfo } from './types';
import type { TaskFlowAPI } from '../shared/taskflow';
import type { AppSettings, SoundAsset, StatisticsDashboard, TaskFlowPreferences } from '../shared/settings';

export interface TomatoAPI {
  setHitmap: (buffer: Uint8Array) => void;
  dragStart: () => void;
  dragEnd: () => void;
  moveWindow: (dx: number, dy: number) => void;
  sendButtonAction: (action: string) => void;
  openTaskFlow: () => void;
  toggleSettings: () => void;
  setWaitingDuration: (minutes: number) => void;
  onPinnedTaskTitle: (callback: (title: string) => void) => void;
  onSettingsToggle: (callback: () => void) => void;
  /** 过渡动画播完回调（P1 握手协议） */
  transitionDone: (id: string) => void;
  /** 庆祝动画播完回调（P2） */
  celebrateDone: () => void;
  /** TEMP: 庆祝调试触发（任务管理器落地后移除） */
  debugCelebrate: () => void;
  /** 调试模式：强制切换状态机 */
  debugSwitchState: (state: string) => void;
  /** P5 动画后台面板 */
  openAnimLab: () => void;
  closeAnimLab: () => void;
  animLabPreview: (data: { id: string; params: Record<string, number> }) => void;
  onAnimLabPreview: (cb: (data: { id: string; params: Record<string, number> }) => void) => void;
  onTimerState: (callback: (state: TimerDisplayState) => void) => void;
  onTimerTick: (callback: (state: TimerDisplayState) => void) => void;
  ready: () => void;
  initialFrameReady: () => void;
}

declare global {
  interface Window {
    tomatoAPI: TomatoAPI;
    taskFlowAPI: TaskFlowAPI & {
      onFocusCard: (callback: (cardId: string) => void) => void;
      onAlwaysOnTop: (callback: (enabled: boolean) => void) => void;
      onSettingsUpdated: (callback: (settings: AppSettings) => void) => void;
      onDataReloaded: (callback: () => void) => void;
    };
    settingsAPI: {
      open: () => void;
      close: () => void;
      getAppVersion: () => Promise<string>;
      load: () => Promise<AppSettings>;
      importCustomSound: () => Promise<{ id: string; label: string } | null>;
      getCustomSoundUrl: (asset: SoundAsset) => Promise<string | null>;
      save: (settings: AppSettings) => Promise<AppSettings>;
      reset: () => Promise<AppSettings>;
      getTaskFlowPreferences: () => Promise<TaskFlowPreferences>;
      getStatisticsDashboard: () => Promise<StatisticsDashboard>;
      clearStatistics: () => Promise<void>;
      clearArchivedTaskFlow: () => Promise<void>;
      exportUserData: () => Promise<string | null>;
      importUserData: () => Promise<boolean>;
      onUpdated: (callback: (settings: AppSettings) => void) => void;
    };
  }
}

export {};
