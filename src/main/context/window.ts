import type { AppSettings } from '../../shared/settings';
import { BrowserWindow, ipcMain, screen, type IpcMainInvokeEvent, type Rectangle } from 'electron';
import path from 'node:path';
import { ContextRepository } from './repository';
import type { ContextCommand, ContextData, ContextWindowState } from '../../shared/context';
import { CONTEXT_LAYOUT, CONTEXT_WINDOW_SIZE, CONTEXT_PASSTHROUGH_RECT, contextRectContains } from '../../shared/context';
import { getFocusedWorkArea, prepareFocusDisplay, disposeFocusDisplay } from './focus-display';

/** 独立窗口控制器；矩形命中与主番茄钟一样由主进程轮询，透明区域不挡鼠标。 */
export class ContextWindowController {
  private panel: BrowserWindow | null = null;
  private capture: BrowserWindow | null = null;
  private state: ContextWindowState = { expanded: false, pinned: false, passthrough: false };
  private outsideSince = 0;
  private ignored = false;
  private captureOpening = false;
  private disposed = false;
  private panelReady = false;
  private captureReady = false;
  private captureRequested = false;
  private captureFade: ReturnType<typeof setInterval> | null = null;
  private panelOpacity = 1;
  private panelFade: ReturnType<typeof setInterval> | null = null;
  private drag: { window: BrowserWindow; offsetX: number; offsetY: number } | null = null;
  private timer: ReturnType<typeof setInterval>;
  private expiryTimer: ReturnType<typeof setInterval>;

  constructor(private readonly repository: ContextRepository) {
    const authorized = (event: IpcMainInvokeEvent): void => {
      if (event.sender !== this.panel?.webContents && event.sender !== this.capture?.webContents) throw new Error('Invalid context sender');
    };
    ipcMain.handle('context:load', async (event) => {
      authorized(event);
      this.publishState();
      const data = await this.repository.load();
      this.updatePanelOpacity(data.opacity);
      return data;
    });
    ipcMain.handle('context:change', async (event, command: ContextCommand) => {
      authorized(event);
      const data = await this.repository.change(command);
      this.publishData(data);
      return data;
    });
    ipcMain.on('context:pin', (event) => {
      if (event.sender !== this.panel?.webContents) return;
      this.state.pinned = !this.state.pinned;
      this.state.expanded = true;
      this.publishState();
      this.keepAboveFullscreen(this.panel);
    });
    ipcMain.on('context:ready', (event) => {
      if (event.sender === this.capture?.webContents && !this.captureReady && !this.disposed) {
        this.captureReady = true;
        if (this.captureRequested) this.showCapture();
        return;
      }
      if (event.sender !== this.panel?.webContents || this.panelReady || this.disposed) return;
      this.panelReady = true;
      this.showPanel();
    });
    ipcMain.on('context:passthrough', (event, enabled: unknown) => {
      if (event.sender === this.panel?.webContents && typeof enabled === 'boolean') this.setPassthrough(enabled);
    });
    ipcMain.on('context:close-capture', (event) => {
      if (event.sender === this.capture?.webContents) this.capture.hide();
    });
    ipcMain.on('context:drag-start', (event) => {
      const window = event.sender === this.panel?.webContents ? this.panel
        : event.sender === this.capture?.webContents ? this.capture : null;
      if (!window || !window.isVisible() || (window === this.panel && this.state.passthrough)) return;
      // 与主番茄钟拖拽一致：主进程使用 Electron 屏幕坐标，跨屏不依赖渲染器缩放。
      const cursor = screen.getCursorScreenPoint();
      const bounds = window.getBounds();
      this.drag = { window, offsetX: cursor.x - bounds.x, offsetY: cursor.y - bounds.y };
      if (window === this.panel) {
        this.ignored = false;
        window.setIgnoreMouseEvents(false);
      }
    });
    ipcMain.on('context:drag-move', (event) => {
      if (!this.drag || event.sender !== this.drag.window.webContents) return;
      const cursor = screen.getCursorScreenPoint();
      this.drag.window.setPosition(Math.round(cursor.x - this.drag.offsetX), Math.round(cursor.y - this.drag.offsetY));
    });
    ipcMain.on('context:drag-end', (event) => {
      if (event.sender === this.drag?.window.webContents) this.endDrag();
    });
    this.timer = setInterval(() => this.checkPointer(), 33);
    this.expiryTimer = setInterval(() => {
      void this.repository.load().then((data) => this.publishData(data)).catch((error) => console.error('[context] Archive failed:', error));
    }, 10000);
  }

  private createWindow(capture: boolean, area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea): BrowserWindow {
    const width = capture ? 440 : CONTEXT_WINDOW_SIZE.width;
    const height = capture ? 150 : CONTEXT_WINDOW_SIZE.height;
    const window = new BrowserWindow({
      width, height,
      x: capture ? area.x + Math.round((area.width - width) / 2) : area.x + area.width - width - 24,
      y: capture ? area.y + Math.round((area.height - height) / 2) : area.y + 40,
      frame: false, transparent: true, resizable: false, maximizable: false,
      alwaysOnTop: true, skipTaskbar: true, show: false, hasShadow: false,
      opacity: 0,
      webPreferences: { preload: path.join(__dirname, '../../preload/index.js'), contextIsolation: true, nodeIntegration: false },
    });
    window.setAlwaysOnTop(true, 'screen-saver');
    window.webContents.setZoomFactor(1);
    // 全屏应用重新激活时可能覆盖同属 topmost 的窗口；恢复层级但不抢输入焦点。
    const restoreTop = () => {
      setImmediate(() => this.keepAboveFullscreen(window));
    };
    window.on('show', restoreTop);
    window.on('focus', restoreTop);
    window.on('blur', restoreTop);
    const cancelDrag = () => { if (this.drag?.window === window) this.endDrag(); };
    window.on('blur', cancelDrag);
    window.on('hide', cancelDrag);
    window.on('closed', cancelDrag);
    const query: Record<string, string> = capture ? { mode: 'capture' } : {};
    if (process.env.APP_DEV === '1') void window.loadURL(`http://localhost:5173/context.html${capture ? '?mode=capture' : ''}`);
    else void window.loadFile(path.join(__dirname, '../../renderer/context.html'), { query });
    // 两种窗口均等待渲染器首帧就绪，从原生透明度 0 开始显示。
    return window;
  }

  sendSettings(settings: AppSettings): void {
    for (const window of [this.panel, this.capture]) {
      if (window && !window.isDestroyed()) window.webContents.send('settings:updated', settings);
    }
  }

  open(): void {
    if (!this.panel || this.panel.isDestroyed()) {
      this.ignored = false;
      this.panelReady = false;
      this.panel = this.createWindow(false);
      this.panel.on('closed', () => { this.panel = null; });
    } else if (this.panelReady) this.showPanel();
  }

  toggle(): void {
    if (this.panel?.isVisible()) this.panel.hide();
    else { this.setPassthrough(false); this.open(); }
  }

  prepareCapture(): void {
    if (this.disposed) return;
    prepareFocusDisplay();
    if (!this.capture || this.capture.isDestroyed()) {
      this.captureReady = false;
      this.capture = this.createWindow(true);
      this.capture.on('closed', () => { this.capture = null; });
    }
  }

  async openCapture(): Promise<void> {
    if (this.captureOpening || this.disposed) return;
    this.captureOpening = true;
    let area: Rectangle;
    try { area = await getFocusedWorkArea(); }
    finally { this.captureOpening = false; }
    if (this.disposed) return;
    this.captureRequested = true;
    if (!this.capture || this.capture.isDestroyed()) {
      this.captureReady = false;
      this.capture = this.createWindow(true, area);
      this.capture.on('closed', () => { this.capture = null; });
      return;
    }
    const [width, height] = this.capture.getSize();
    this.capture.setPosition(area.x + Math.round((area.width - width) / 2), area.y + Math.round((area.height - height) / 2));
    if (this.captureReady) this.showCapture();
  }

  setPassthrough(enabled: boolean): void {
    if (enabled && this.drag?.window === this.panel) this.endDrag();
    this.state.passthrough = enabled;
    if (enabled) this.state.expanded = true;
    this.outsideSince = 0;
    this.publishState();
    this.checkPointer();
  }

  private publishState(): void { this.panel?.webContents.send('context:state', this.state); }

  private publishData(data: ContextData): void {
    this.updatePanelOpacity(data.opacity);
    this.panel?.webContents.send('context:data', data);
    this.capture?.webContents.send('context:data', data);
  }

  private checkPointer(): void {
    if (!this.panel || !this.panel.isVisible()) return;
    if (this.drag?.window === this.panel) return;
    const bounds = this.panel.getBounds();
    const cursor = screen.getCursorScreenPoint();
    const x = cursor.x - bounds.x;
    const y = cursor.y - bounds.y;
    const icon = contextRectContains(CONTEXT_LAYOUT.icon, x, y);
    const body = this.state.expanded && contextRectContains(CONTEXT_LAYOUT.panel, x, y);
    const inside = icon || body;
    if (!this.state.passthrough) {
      if (inside) {
        this.outsideSince = 0;
        if (!this.state.expanded) { this.state.expanded = true; this.publishState(); }
      } else if (!this.state.pinned && this.state.expanded) {
        if (!this.outsideSince) this.outsideSince = Date.now();
        if (Date.now() - this.outsideSince >= 200) { this.state.expanded = false; this.publishState(); }
      }
    }
    // 穿透时只保留恢复开关的矩形命中，其余区域继续交给后方应用。
    const ignored = this.state.passthrough ? !contextRectContains(CONTEXT_PASSTHROUGH_RECT, x, y) : !inside;
    if (this.ignored !== ignored) {
      this.ignored = ignored;
      // checkPointer 已负责恢复命中，无需转发下方文本框的鼠标移动。
      this.panel.setIgnoreMouseEvents(ignored, { forward: false });
    }
  }

  private keepAboveFullscreen(window: BrowserWindow | null): void {
    if (this.disposed || !window || window.isDestroyed() || !window.isVisible()) return;
    window.setAlwaysOnTop(true, 'screen-saver');
    window.moveTop();
  }

  private endDrag(): void {
    const window = this.drag?.window ?? null;
    this.drag = null;
    this.outsideSince = 0;
    this.keepAboveFullscreen(window);
  }

  private updatePanelOpacity(opacity: number): void {
    this.panelOpacity = opacity;
    if (this.panelReady && !this.panelFade) this.panel?.setOpacity(opacity);
  }

  private showPanel(): void {
    if (!this.panel || this.panel.isVisible()) return;
    if (this.panelFade) clearInterval(this.panelFade);
    this.panel.setOpacity(0);
    this.panel.showInactive();
    this.publishState();
    const started = Date.now();
    this.panelFade = setInterval(() => {
      const progress = Math.min(1, (Date.now() - started) / 180);
      if (this.panel && !this.panel.isDestroyed()) this.panel.setOpacity(this.panelOpacity * progress);
      if (progress === 1 || !this.panel || this.panel.isDestroyed()) {
        if (this.panelFade) clearInterval(this.panelFade);
        this.panelFade = null;
      }
    }, 16);
  }

  private showCapture(): void {
    this.captureRequested = false;
    const window = this.capture;
    if (!window || window.isDestroyed()) return;
    if (!window.isVisible()) {
      if (this.captureFade) clearInterval(this.captureFade);
      window.setOpacity(0);
      window.show();
      const started = Date.now();
      this.captureFade = setInterval(() => {
        const progress = Math.min(1, (Date.now() - started) / 100);
        if (!window.isDestroyed() && window.isVisible()) window.setOpacity(progress);
        if (progress === 1 || window.isDestroyed() || !window.isVisible()) {
          if (this.captureFade) clearInterval(this.captureFade);
          this.captureFade = null;
        }
      }, 16);
    }
    window.focus();
    window.webContents.send('context:capture');
  }

  dispose(): void { this.disposed = true; disposeFocusDisplay(); this.endDrag(); if (this.captureFade) clearInterval(this.captureFade); if (this.panelFade) clearInterval(this.panelFade); clearInterval(this.timer); clearInterval(this.expiryTimer); }
  flush(): Promise<void> { return this.repository.flush(); }
}
