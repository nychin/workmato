/**
 * Electron 预加载脚本
 *
 * 通过 contextBridge 暴露安全 API 给渲染进程
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { TimerDisplayState, ButtonAction } from '../main/timer/types';
import type { TaskFlowAPI, TaskFlowData } from '../shared/taskflow';
import type {
  AppSettings,
  SoundAsset,
  StatisticsDashboard,
  TaskFlowPreferences,
} from '../shared/settings';

export interface TomatoAPI {
  // ── 命中表 + 拖拽 ──
  setHitmap: (buffer: Uint8Array) => void;
  dragStart: () => void;
  dragEnd: () => void;
  moveWindow: (dx: number, dy: number) => void;

  // ── 按钮与时间设置事件 ──
  sendButtonAction: (action: ButtonAction) => void;
  openTaskFlow: () => void;
  toggleSettings: () => void;
  setWaitingDuration: (minutes: number) => void;
  onPinnedTaskTitle: (callback: (title: string) => void) => void;
  onSettingsToggle: (callback: () => void) => void;

  // ── 过渡动画播完回调（P1 握手协议） ──
  transitionDone: (id: string) => void;

  // ── 庆祝（P2）：播完回调 + 调试触发（调试触发在任务管理器落地后移除） ──
  celebrateDone: () => void;
  debugCelebrate: () => void;
  /** 调试模式：强制切换状态机 */
  debugSwitchState: (state: string) => void;
  /** P5 动画后台面板 */
  openAnimLab: () => void;
  closeAnimLab: () => void;
  animLabPreview: (data: { id: string; params: Record<string, number> }) => void;
  onAnimLabPreview: (cb: (data: { id: string; params: Record<string, number> }) => void) => void;

  // ── 计时事件监听 ──
  onTimerState: (callback: (state: TimerDisplayState) => void) => void;
  onTimerTick: (callback: (state: TimerDisplayState) => void) => void;

  // ── 就绪 ──
  ready: () => void;
  initialFrameReady: () => void;
}

export interface SettingsAPI {
  open: () => void;
  close: () => void;
  getAppVersion: () => Promise<string>;
  openKofiSupport: () => Promise<void>;
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
}

const api: TomatoAPI = {
  setHitmap: (buffer: Uint8Array) => {
    ipcRenderer.send('hitmap:set', { buffer: Array.from(buffer) });
  },

  dragStart: () => ipcRenderer.send('drag:start'),
  dragEnd: () => ipcRenderer.send('drag:end'),
  moveWindow: (dx: number, dy: number) =>
    ipcRenderer.send('window:move', { dx, dy }),

  sendButtonAction: (action: ButtonAction) =>
    ipcRenderer.send('button:action', action),
  openTaskFlow: () => ipcRenderer.send('taskflow:open'),
  toggleSettings: () => ipcRenderer.send('settings:toggle'),
  setWaitingDuration: (minutes: number) =>
    ipcRenderer.send('timer:setWaitingDuration', minutes),
  onPinnedTaskTitle: (callback) => {
    ipcRenderer.on('taskflow:pinned-title', (_event, data: { title: string }) => callback(data.title));
  },
  onSettingsToggle: (callback) => {
    ipcRenderer.on('settings:toggle', () => callback());
  },

  transitionDone: (id: string) => ipcRenderer.send('transition:done', id),

  celebrateDone: () => ipcRenderer.send('celebrate:done'),
  debugCelebrate: () => ipcRenderer.send('debug:celebrate'),
  debugSwitchState: (state: string) => ipcRenderer.send('debug:switchState', state),

  openAnimLab: () => ipcRenderer.send('animlab:open'),
  closeAnimLab: () => ipcRenderer.send('animlab:close'),
  animLabPreview: (data) => ipcRenderer.send('animlab:preview', data),
  onAnimLabPreview: (cb) => {
    ipcRenderer.on('animlab:preview', (_event, data) => cb(data));
  },

  onTimerState: (callback: (state: TimerDisplayState) => void) => {
    ipcRenderer.on('timer:state', (_event, state: TimerDisplayState) => {
      callback(state);
    });
  },

  onTimerTick: (callback: (state: TimerDisplayState) => void) => {
    ipcRenderer.on('timer:tick', (_event, state: TimerDisplayState) => {
      callback(state);
    });
  },

  ready: () => ipcRenderer.send('renderer:ready'),
  initialFrameReady: () => ipcRenderer.send('renderer:initial-frame-ready'),
};

const taskFlowAPI: TaskFlowAPI & {
  onFocusCard: (callback: (cardId: string) => void) => void;
  onAlwaysOnTop: (callback: (enabled: boolean) => void) => void;
  onSettingsUpdated: (callback: (settings: AppSettings) => void) => void;
  onDataReloaded: (callback: () => void) => void;
} = {
  load: () => ipcRenderer.invoke('taskflow:load') as Promise<TaskFlowData>,
  save: (data: TaskFlowData) => ipcRenderer.invoke('taskflow:save', data),
  completeCard: (cardId: string, completed: boolean) => ipcRenderer.invoke('taskflow:complete-card', cardId, completed),
  closeWindow: () => ipcRenderer.send('taskflow:close-window'),
  minimizeWindow: () => ipcRenderer.send('taskflow:minimize-window'),
  maximizeWindow: () => ipcRenderer.send('taskflow:maximize-window'),
  toggleHalfScreen: () => ipcRenderer.invoke('taskflow:toggle-half-screen') as Promise<boolean>,
  toggleAlwaysOnTop: () => ipcRenderer.invoke('taskflow:toggle-always-on-top') as Promise<boolean>,
  getAlwaysOnTop: () => ipcRenderer.invoke('taskflow:get-always-on-top') as Promise<boolean>,
  onAlwaysOnTop: (callback) => {
    ipcRenderer.on('taskflow:always-on-top', (_event, enabled: boolean) => callback(enabled));
  },
  onFocusCard: (callback) => {
    ipcRenderer.on('taskflow:focus-card', (_event, cardId: string) => callback(cardId));
  },
  onSettingsUpdated: (callback: (settings: AppSettings) => void) => {
    ipcRenderer.on('settings:updated', (_event, settings: AppSettings) => callback(settings));
  },
  onDataReloaded: (callback: () => void) => {
    ipcRenderer.on('taskflow:data-reloaded', () => callback());
  },
};

const settingsAPI: SettingsAPI = {
  open: () => ipcRenderer.send('settings:open'),
  close: () => ipcRenderer.send('settings:close'),
  getAppVersion: () => ipcRenderer.invoke('app:get-version') as Promise<string>,
  openKofiSupport: () => ipcRenderer.invoke('support:open-kofi') as Promise<void>,
  load: () => ipcRenderer.invoke('settings:load') as Promise<AppSettings>,
  importCustomSound: () => ipcRenderer.invoke('sound:import-custom') as Promise<{ id: string; label: string } | null>,
  getCustomSoundUrl: (asset) => ipcRenderer.invoke('sound:get-custom-url', asset) as Promise<string | null>,
  save: (settings) => ipcRenderer.invoke('settings:save', settings) as Promise<AppSettings>,
  reset: () => ipcRenderer.invoke('settings:reset') as Promise<AppSettings>,
  getTaskFlowPreferences: () => ipcRenderer.invoke('settings:get-taskflow-preferences') as Promise<TaskFlowPreferences>,
  getStatisticsDashboard: () => ipcRenderer.invoke('statistics:dashboard') as Promise<StatisticsDashboard>,
  clearStatistics: () => ipcRenderer.invoke('statistics:clear') as Promise<void>,
  clearArchivedTaskFlow: () => ipcRenderer.invoke('taskflow:clear-archived') as Promise<void>,
  exportUserData: () => ipcRenderer.invoke('data:export') as Promise<string | null>,
  importUserData: () => ipcRenderer.invoke('data:import') as Promise<boolean>,
  onUpdated: (callback) => {
    ipcRenderer.on('settings:updated', (_event, settings: AppSettings) => callback(settings));
  },
};

contextBridge.exposeInMainWorld('tomatoAPI', api);
contextBridge.exposeInMainWorld('taskFlowAPI', taskFlowAPI);
contextBridge.exposeInMainWorld('settingsAPI', settingsAPI);
