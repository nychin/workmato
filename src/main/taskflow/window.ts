import { BrowserWindow, ipcMain, screen, type Rectangle } from 'electron';
import path from 'node:path';
import type { TaskFlowData } from '../../shared/taskflow';
import type { AppSettings } from '../../shared/settings';
import type { TimerFSM } from '../timer/fsm';
import { TimerState } from '../timer/types';
import { TaskFlowRepository } from './repository';

function getTaskFlowIconPath(): string {
  const fs = require('node:fs');
  const productionPath = path.join(__dirname, '../../renderer/icon/taskflow.ico');
  return fs.existsSync(productionPath)
    ? productionPath
    : path.join(__dirname, '../../../static/icon/taskflow.ico');
}

interface TaskFlowWindowOptions {
  repository: TaskFlowRepository;
  timerFSM: TimerFSM;
  onPinnedTitleChange: (title: string) => void;
  onDataChange: (data: TaskFlowData) => void;
}

/**
 * 任务窗口控制器负责 Electron 生命周期和 IPC，不参与任务业务编辑。
 * 保持单实例窗口，避免同一数据被多个渲染进程并发覆盖。
 */
export class TaskFlowWindowController {
  private window: BrowserWindow | null = null;
  private readonly repository: TaskFlowRepository;
  private readonly timerFSM: TimerFSM;
  private readonly onPinnedTitleChange: (title: string) => void;
  private readonly onDataChange: (data: TaskFlowData) => void;
  private boundsBeforeHalfScreen: Rectangle | null = null;
  private halfScreened = false;

  constructor(options: TaskFlowWindowOptions) {
    this.repository = options.repository;
    this.timerFSM = options.timerFSM;
    this.onPinnedTitleChange = options.onPinnedTitleChange;
    this.onDataChange = options.onDataChange;
    this.registerIPC();
  }

  open(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.show();
      this.window.focus();
      return;
    }

    this.createWindow();
  }

  /** 告示牌开关：已显示则最小化，已最小化/隐藏则恢复显示。 */
  toggle(): void {
    if (this.window && !this.window.isDestroyed()) {
      if (this.window.isMinimized()) {
        this.window.restore();
        this.window.show();
        this.window.focus();
      } else if (this.window.isVisible()) {
        this.window.minimize();
      } else {
        this.window.show();
        this.window.focus();
      }
      return;
    }
    this.createWindow();
  }

  private createWindow(): void {

    const display = screen.getPrimaryDisplay().workArea;
    const width = Math.min(1500, Math.max(960, display.width - 80));
    const height = Math.min(800, Math.max(600, display.height - 80));

    this.window = new BrowserWindow({
      width,
      height,
      icon: getTaskFlowIconPath(),
      minWidth: 960,
      minHeight: 320,
      show: false,
      frame: false,
      backgroundColor: '#FFFFFF',
      webPreferences: {
        preload: path.join(__dirname, '../../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.window.webContents.setZoomFactor(1);

    // 保留旧 Transform 画布作为运行时回退路径，无需改数据或重新构建。
    const legacyCanvasTransform = process.env.APP_LEGACY_CANVAS_TRANSFORM === '1';
    const canvasQuery = legacyCanvasTransform ? '?canvasTransform=legacy' : '';
    // dev 模式（APP_DEV=1）走 vite dev server；生产模式加载本地打包产物
    if (process.env.APP_DEV === '1') {
      this.window.loadURL(`http://localhost:5173/taskflow.html${canvasQuery}`);
    } else {
      this.window.loadFile(path.join(__dirname, '../../renderer/taskflow.html'), legacyCanvasTransform
        ? { query: { canvasTransform: 'legacy' } }
        : undefined);
    }
    this.window.webContents.once('did-finish-load', () => {
      // 清除旧版按同源保存的页面缩放，避免受到番茄钟历史缩放设置影响。
      this.window?.webContents.setZoomFactor(1);
    });
    this.window.once('ready-to-show', () => this.window?.show());
    this.window.on('closed', () => {
      this.window = null;
    });
  }

  focusPinnedCard(cardId: string): void {
    this.open();
    this.window?.webContents.once('did-finish-load', () => {
      this.window?.webContents.send('taskflow:focus-card', cardId);
    });
    if (this.window && !this.window.webContents.isLoading()) {
      this.window.webContents.send('taskflow:focus-card', cardId);
    }
  }

  private registerIPC(): void {
    ipcMain.handle('taskflow:load', () => this.repository.load());

    ipcMain.handle('taskflow:save', async (_event, data: TaskFlowData) => {
      await this.repository.save(data);
      const pinnedCard = data.cards.find((card) => card.id === data.pinnedCardId);
      this.onPinnedTitleChange(pinnedCard?.title ?? '');
      this.onDataChange(data);
    });

    ipcMain.handle('taskflow:complete-card', async (_event, _cardId: string, completed: boolean) => {
      if (!completed) return;
      const state = this.timerFSM.getDisplay().state;
      if (
        state === TimerState.Focus ||
        state === TimerState.Prolongation ||
        state === TimerState.RageFocus
      ) {
        this.timerFSM.dispatchCelebrate();
      }
    });

    ipcMain.on('taskflow:close-window', () => this.window?.close());
    ipcMain.on('taskflow:minimize-window', () => this.window?.minimize());
    ipcMain.on('taskflow:maximize-window', () => {
      if (!this.window) return;
      this.halfScreened = false;
      this.boundsBeforeHalfScreen = null;
      if (this.window.isMaximized()) this.window.unmaximize();
      else this.window.maximize();
    });
    ipcMain.handle('taskflow:toggle-half-screen', () => {
      if (!this.window) return false;
      if (this.halfScreened && this.boundsBeforeHalfScreen) {
        this.window.setBounds(this.boundsBeforeHalfScreen);
        this.boundsBeforeHalfScreen = null;
        this.halfScreened = false;
        return false;
      }
      if (this.window.isMaximized()) this.window.unmaximize();
      const currentBounds = this.window.getBounds();
      const workArea = screen.getDisplayMatching(currentBounds).workArea;
      this.boundsBeforeHalfScreen = currentBounds;
      const top = workArea.y + Math.floor(workArea.height / 2);
      const halfScreenBounds = {
        x: workArea.x,
        y: top,
        width: workArea.width,
        height: workArea.y + workArea.height - top,
      };
      this.halfScreened = true;
      this.window.setBounds(halfScreenBounds);
      return true;
    });
    ipcMain.handle('taskflow:toggle-always-on-top', () => {
      if (!this.window) return false;
      const next = !this.window.isAlwaysOnTop();
      this.window.setAlwaysOnTop(next, next ? 'floating' : undefined);
      return this.window.isAlwaysOnTop();
    });
    ipcMain.handle('taskflow:get-always-on-top', () => this.window?.isAlwaysOnTop() ?? false);
  }

  sendSettings(settings: AppSettings): void {
    this.window?.webContents.send('settings:updated', settings);
  }

  reloadData(): void {
    this.window?.webContents.send('taskflow:data-reloaded');
  }
}
