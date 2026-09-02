/**
 * Electron 主进程入口
 *
 * 职责：窗口管理、托盘、IPC、点击穿透轮询、TimerFSM
 */
import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  screen,
  ipcMain,
  nativeImage,
  globalShortcut,
  dialog,
} from 'electron';
import * as path from 'path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { TimerFSM } from './timer/fsm';
import { TimerDisplayState, TimerState } from './timer/types';
import { TaskFlowRepository } from './taskflow/repository';
import { TaskFlowWindowController } from './taskflow/window';
import { SettingsRepository } from './settings/repository';
import { StatisticsRepository } from './statistics/repository';
import { FocusSessionTracker } from './statistics/tracker';
import { AppSettings, createDefaultSettings, FocusRecord, getTaskFlowPreferences } from '../shared/settings';
import { setLocale, t } from '../shared/i18n';
import type { TaskFlowData } from '../shared/taskflow';

const isDevelopment = process.env.APP_DEV === '1';
// 主番茄钟的透明窗口依赖 GPU 合成。仅保留显式诊断开关，正常启动默认启用 GPU。
const disableHardwareAcceleration = process.env.APP_DISABLE_GPU === '1';

// 开发环境不读取正式版数据目录。旧版以管理员权限创建的 userData 目录可能
// 让普通用户的 Electron 无法写入，从而在主进程初始化前直接退出。
if (isDevelopment) {
  app.setPath('userData', path.join(app.getPath('temp'), 'tomato-clock-dev'));
}

// Windows 上重复双击安装包时，只保留一个工作番茄进程。
// 第二次启动会通知首个进程将已有面板唤回前台后自行退出。
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

// 必须在 app ready 之前关闭；运行中的 Electron 窗口无法动态切换该状态。
if (disableHardwareAcceleration) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
}

// 防止 stdout/stderr 管道断开（例如启动终端被关闭）时，console 写入抛出
// EPIPE 未捕获异常导致主进程崩溃。这里吞掉该错误，不影响任何功能逻辑。
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

// ── 常量 ──
const CANVAS_W = 491;
const CANVAS_H = 407;
const POLL_INTERVAL_MS = 33;

// ── 状态 ──
let mainWindow: BrowserWindow | null = null;
let labWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let settingsWindowReady = false;
let settingsWindowOpenRequested = false;
let isQuitting = false;
let tray: Tray | null = null;
let hitmapBuffer: Buffer | null = null;
let pollingTimer: ReturnType<typeof setInterval> | null = null;
let isDragging = false;
let dragCursorOffset: { x: number; y: number } | null = null;
let lastIgnoreState = false;
let mainWindowFrameReady = false;
let mainWindowShown = false;
let foregroundRequestId = 0;
let showRequestedBySecondInstance = false;

// ── 计时状态机与任务流程模块 ──
const fsm = new TimerFSM();
const taskFlowRepository = new TaskFlowRepository();
const settingsRepository = new SettingsRepository();
const statisticsRepository = new StatisticsRepository();
const focusTracker = new FocusSessionTracker();
let taskFlowWindow: TaskFlowWindowController | null = null;
let pinnedTaskTitle = '';
let taskFlowData: TaskFlowData | null = null;
let appSettings: AppSettings = createDefaultSettings();

/** 解析 tomato.ico 路径（生产=dist/renderer/icon，开发=static/icon） */
function getIconPath(): string {
  const fs = require('fs');
  const prodPath = path.join(__dirname, '../renderer/icon/tomato.ico');
  return fs.existsSync(prodPath)
    ? prodPath
    : path.join(__dirname, '../../static/icon/tomato.ico');
}

function customSoundDirectory(): string {
  return path.join(app.getPath('userData'), 'custom-sounds');
}

async function importCustomSound(): Promise<{ id: string; label: string } | null> {
  const result = await dialog.showOpenDialog({
    title: t('main.dialog.importSound'),
    properties: ['openFile'],
    filters: [{ name: t('main.dialog.audioFiles'), extensions: ['mp3', 'wav', 'ogg', 'm4a'] }],
  });
  const source = result.filePaths[0];
  if (result.canceled || !source) return null;
  const extension = path.extname(source).toLowerCase();
  if (!['.mp3', '.wav', '.ogg', '.m4a'].includes(extension)) return null;
  const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extension}`;
  await fs.mkdir(customSoundDirectory(), { recursive: true });
  await fs.copyFile(source, path.join(customSoundDirectory(), fileName));
  return { id: `custom:${fileName}`, label: path.basename(source, extension) };
}

async function customSoundUrl(asset: unknown): Promise<string | null> {
  if (typeof asset !== 'string' || !/^custom:[a-zA-Z0-9_-]+\.(mp3|wav|ogg|m4a)$/i.test(asset)) return null;
  const filePath = path.join(customSoundDirectory(), asset.slice('custom:'.length));
  try {
    await fs.access(filePath);
    return pathToFileURL(filePath).href;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════
// 窗口
// ═══════════════════════════════════════════

function createWindow(): void {
  const panelScale = appSettings.tomatoPanelScale;
  mainWindow = new BrowserWindow({
    width: CANVAS_W * panelScale,
    height: CANVAS_H * panelScale,
    transparent: true,
    frame: false,
    alwaysOnTop: false,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#00000000',
    icon: getIconPath(),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 只使用番茄钟渲染器内的画布缩放；不要让 Chromium 的页面缩放影响同来源的其它窗口。
      zoomFactor: 1,
      backgroundThrottling: false,
      // 允许 file:// 协议的 ES Module 加载（本地桌面应用安全可控）
      webSecurity: false,
    },
  });
  // 清除旧版“双倍尺寸”留下的同源网页缩放；番茄钟尺寸改由自身画布处理。
  mainWindow.webContents.setZoomFactor(1);
  // ── 模式判断：优先由环境变量显式控制（APP_DEV=1 → dev server；否则 → 本地打包产物）。
  //    不再依赖"dist/renderer/index.html 是否存在"来推断，避免误删产物导致模式漂移。
  const htmlPath = path.join(__dirname, '../renderer/index.html');
  const fs = require('fs');
  const isDev = isDevelopment || !fs.existsSync(htmlPath);

  if (isDev) {
    console.log('[main] Loading dev URL: http://localhost:5173');
    mainWindow.loadURL('http://localhost:5173');
    // 不自动打开 DevTools（避免多出一个 electron 后台窗口）。需要时按 F12 手动打开。
  } else {
    console.log(`[main] Loading file: ${htmlPath}`);
    mainWindow.loadFile(htmlPath);
  }

  // ── 加载错误处理 ──
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[main] Load failed (${errorCode}): ${errorDescription} | ${validatedURL}`);
  });
  mainWindow.once('ready-to-show', () => showMainWindow());
  // Transparent frameless windows do not reliably emit ready-to-show on every
  // Windows graphics stack. Once the document has loaded, reveal the same
  // already-created window as a fallback.
  mainWindow.webContents.once('did-finish-load', () => {
    // Chromium 会按来源恢复历史网页缩放，必须在导航完成后再归一一次。
    // 番茄钟的尺寸由渲染器画布缩放，不依赖此页面缩放。
    mainWindow?.webContents.setZoomFactor(1);
    setTimeout(showMainWindow, 150);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    mainWindowFrameReady = false;
    mainWindowShown = false;
    stopPolling();
  });
}

// ═══════════════════════════════════════════
// P5 动画后台面板窗口
// ═══════════════════════════════════════════

function showMainWindow(activate = false): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const needsNativeShow = !mainWindow.isVisible();
  mainWindowShown = true;
  lastIgnoreState = false;
  mainWindow.setIgnoreMouseEvents(false);
  mainWindow.setOpacity(1);
  if (activate) {
    bringMainWindowToFront();
  } else if (needsNativeShow) {
    mainWindow.showInactive();
  }
}

function revealExistingMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    showRequestedBySecondInstance = true;
    return;
  }
  showMainWindow(true);
}

/**
 * Windows 可能拒绝后台进程仅靠 focus() 抢到前台。
 * 临时使用浮动层抬升窗口，激活完成后恢复用户原有的置顶状态。
 */
function bringMainWindowToFront(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const window = mainWindow;
  const requestId = ++foregroundRequestId;
  const wasAlwaysOnTop = fsm.getIsPinned();
  window.show();
  window.setAlwaysOnTop(true, 'floating');
  window.moveTop();
  window.focus();
  window.moveTop();
  setTimeout(() => {
    if (requestId !== foregroundRequestId || window.isDestroyed()) return;
    window.setAlwaysOnTop(wasAlwaysOnTop, wasAlwaysOnTop ? 'screen-saver' : 'normal');
    if (wasAlwaysOnTop) window.moveTop();
  }, 180);
}

function hideMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindowShown) return;
  mainWindowShown = false;
  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  mainWindow.setOpacity(0);
}

function applyMainWindowScale(scale: number): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const width = CANVAS_W * scale;
  const height = CANVAS_H * scale;
  const current = mainWindow.getBounds();
  const workArea = screen.getDisplayMatching(current).workArea;
  const x = Math.max(workArea.x, Math.min(current.x, workArea.x + workArea.width - width));
  const y = Math.max(workArea.y, Math.min(current.y, workArea.y + workArea.height - height));
  mainWindow.setBounds({ x: Math.round(x), y: Math.round(y), width, height });
  lastIgnoreState = false;
  mainWindow.setIgnoreMouseEvents(false);
}

function createLabWindow(): void {
  if (labWindow) {
    labWindow.focus();
    return;
  }
  labWindow = new BrowserWindow({
    width: 700,
    height: 500,
    frame: true,
    alwaysOnTop: false,
    resizable: true,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });
  const labHtml = path.join(__dirname, '../renderer/animation-lab/index.html');
  labWindow.loadFile(labHtml);
  labWindow.on('closed', () => { labWindow = null; });
}

function positionSettingsWindow(): void {
  if (!settingsWindow || settingsWindow.isDestroyed() || !mainWindow || mainWindow.isDestroyed()) return;
  const gap = 12;
  const anchor = mainWindow.getBounds();
  const settingsBounds = settingsWindow.getBounds();
  const workArea = screen.getDisplayMatching(anchor).workArea;
  const rightX = anchor.x + anchor.width + gap;
  const leftX = anchor.x - settingsBounds.width - gap;
  const x = rightX + settingsBounds.width <= workArea.x + workArea.width
    ? rightX
    : leftX >= workArea.x ? leftX : Math.max(workArea.x, Math.min(rightX, workArea.x + workArea.width - settingsBounds.width));
  const centeredY = anchor.y + Math.round((anchor.height - settingsBounds.height) / 2);
  const y = Math.max(workArea.y, Math.min(centeredY, workArea.y + workArea.height - settingsBounds.height));
  settingsWindow.setPosition(Math.round(x), Math.round(y));
}

function showSettingsWindowIfReady(): void {
  if (!settingsWindow || settingsWindow.isDestroyed() || !settingsWindowReady || !settingsWindowOpenRequested) return;
  positionSettingsWindow();
  settingsWindow.show();
  settingsWindow.focus();
}

function createSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) return;
  settingsWindowReady = false;
  const window = new BrowserWindow({
    width: 720,
    height: 590,
    minWidth: 640,
    minHeight: 500,
    frame: false,
    show: false,
    backgroundColor: '#FFFDFC',
    icon: getIconPath(),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.webContents.setZoomFactor(1);
  settingsWindow = window;
  positionSettingsWindow();
  if (process.env.APP_DEV === '1') {
    void window.loadURL('http://localhost:5173/settings.html');
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/settings.html'));
  }

  const markReady = (): void => {
    if (settingsWindow !== window) return;
    settingsWindowReady = true;
    showSettingsWindowIfReady();
  };
  // did-finish-load 不等待体积较大的中文字体完全解析，安装版首次打开更及时。
  window.webContents.once('did-finish-load', () => {
    // 设置页与番茄钟共享开发服务器来源，防止继承旧版 200% 网页缩放。
    window.webContents.setZoomFactor(1);
    markReady();
  });
  window.once('ready-to-show', markReady);
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[settings] Load failed (${errorCode}): ${errorDescription} | ${validatedURL}`);
  });
  window.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    settingsWindowOpenRequested = false;
    window.hide();
  });
  window.on('closed', () => {
    if (settingsWindow === window) {
      settingsWindow = null;
      settingsWindowReady = false;
    }
  });
}

function openSettingsWindow(): void {
  settingsWindowOpenRequested = true;
  createSettingsWindow();
  showSettingsWindowIfReady();
}

function hideSettingsWindow(): void {
  settingsWindowOpenRequested = false;
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.hide();
}

// ═══════════════════════════════════════════
// 托盘
// ═══════════════════════════════════════════

function createTray(): void {
  // 托盘图标使用内嵌多尺寸的 tomato.ico（Windows 自动选用 16×16）
  const icon = nativeImage.createFromPath(getIconPath());

  tray = new Tray(icon);
  tray.setToolTip(t('main.appName'));
  tray.setContextMenu(buildTrayMenu());

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindowShown) hideMainWindow();
      else showMainWindow(true);
    }
  });
}

function buildTrayMenu(): Electron.Menu {
  return Menu.buildFromTemplate([
    {
      label: t('main.tray.show'),
      click: () => showMainWindow(true),
    },
    {
      label: t('main.tray.openTaskFlow'),
      click: () => taskFlowWindow?.open(),
    },
    { type: 'separator' },
    {
      label: t('main.tray.quit'),
      click: () => app.quit(),
    },
  ]);
}

// ═══════════════════════════════════════════
// 穿透轮询
// ═══════════════════════════════════════════

function startPolling(): void {
  if (pollingTimer) return;
  pollingTimer = setInterval(checkHit, POLL_INTERVAL_MS);
}

function stopPolling(): void {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}

function checkHit(): void {
  if (!mainWindow || !mainWindowShown || !hitmapBuffer || isDragging) return;

  const cursorPoint = screen.getCursorScreenPoint();
  const bounds = mainWindow.getBounds();

  const panelScale = appSettings.tomatoPanelScale;
  const relX = Math.floor((cursorPoint.x - bounds.x) / panelScale);
  const relY = Math.floor((cursorPoint.y - bounds.y) / panelScale);

  let shouldIgnore = true;
  if (relX >= 0 && relX < CANVAS_W && relY >= 0 && relY < CANVAS_H) {
    const idx = relY * CANVAS_W + relX;
    shouldIgnore = hitmapBuffer[idx] === 0;
  }

  if (shouldIgnore !== lastIgnoreState) {
    lastIgnoreState = shouldIgnore;
    if (shouldIgnore) {
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
    } else {
      mainWindow.setIgnoreMouseEvents(false);
    }
  }
}

// ═══════════════════════════════════════════
// 广播（主→渲染）
// ═══════════════════════════════════════════

function sendToRenderer(channel: string, data: unknown): void {
  mainWindow?.webContents.send(channel, data);
}

function toElectronAccelerator(shortcut: string): string {
  return shortcut.replace(/^Ctrl\+/i, 'CommandOrControl+');
}

function toggleMainWindow(): void {
  if (!mainWindow) return;
  // 被其它应用遮挡时窗口依然是“已显示”状态；此时快捷键应优先唤回前台，
  // 只有工作番茄当前已获得焦点才执行隐藏。
  if (mainWindowShown && mainWindow.isFocused()) hideMainWindow();
  else showMainWindow(true);
}

function registerGlobalShortcuts(): void {
  globalShortcut.unregisterAll();
  const registrations: Array<['toggleMainWindow' | 'toggleTimer', () => void]> = [
    ['toggleMainWindow', toggleMainWindow],
    ['toggleTimer', () => fsm.dispatchPrimaryShortcut()],
  ];
  for (const [action, handler] of registrations) {
    const shortcut = appSettings.shortcuts[action];
    if (!shortcut) continue;
    try {
      if (!globalShortcut.register(toElectronAccelerator(shortcut), handler)) {
        console.warn(`[settings] Global shortcut unavailable: ${shortcut}`);
      }
    } catch (error) {
      console.warn(`[settings] Invalid global shortcut ${shortcut}:`, error);
    }
  }
}

function applySettings(settings: AppSettings): void {
  const panelScaleChanged = appSettings.tomatoPanelScale !== settings.tomatoPanelScale;
  const languageChanged = appSettings.language !== settings.language;
  appSettings = settings;
  if (languageChanged) {
    setLocale(settings.language);
    if (tray && !tray.isDestroyed()) {
      tray.setToolTip(t('main.appName'));
      tray.setContextMenu(buildTrayMenu());
    }
    // 界面语言切换后，重新注入对应语言的“说明”引导（任务流程窗口已就绪时）。
    if (taskFlowWindow && taskFlowData) {
      void taskFlowRepository.load(app.getVersion(), settings.language)
        .then((data) => {
          taskFlowData = data;
          syncPinnedTaskTitle(data);
          taskFlowWindow?.reloadData();
        })
        .catch((error) => console.error('[taskflow] Failed to reload bundled guide on language change:', error));
    }
  }
  // 仅在显示尺寸选项真正变化时重设番茄钟窗口边界。其它设置保存不应触发
  // BrowserWindow.setBounds，否则 Windows 可能重新计算相邻设置窗口的位置。
  if (panelScaleChanged) applyMainWindowScale(settings.tomatoPanelScale);
  fsm.applySettings(settings.timer);
  applyLaunchAtLogin(settings.launchAtLogin);
  registerGlobalShortcuts();
  sendToRenderer('settings:updated', settings);
  taskFlowWindow?.sendSettings(settings);
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('settings:updated', settings);
  }
}

function applyLaunchAtLogin(enabled: boolean): void {
  // 兼容旧便携版与当前安装版：便携版优先使用原始 exe，安装版使用 process.execPath。
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
    });
  } catch (error) {
    console.warn('[settings] Failed to update launch-at-login:', error);
  }
}

function currentFocusTask(): { taskCardId: string | null; taskTitle: string | null; projectId: string | null; projectTitle: string | null } {
  const card = taskFlowData?.cards.find((item) => item.id === taskFlowData?.pinnedCardId) ?? null;
  const project = card ? taskFlowData?.projects.find((item) => item.id === card.projectId) ?? null : null;
  return {
    taskCardId: card?.id ?? null,
    taskTitle: card?.title ?? null,
    projectId: project?.id ?? null,
    projectTitle: project?.title ?? null,
  };
}

function syncPinnedTaskTitle(data: TaskFlowData): void {
  pinnedTaskTitle = data.cards.find((card) => card.id === data.pinnedCardId)?.title ?? '';
  sendToRenderer('taskflow:pinned-title', { title: pinnedTaskTitle });
}

interface BackupBundle {
  version: 1;
  createdAt: string;
  settings: AppSettings;
  taskFlow: TaskFlowData;
  focusRecords: FocusRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function createBackupBundle(): Promise<BackupBundle> {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    settings: appSettings,
    taskFlow: await taskFlowRepository.load(),
    focusRecords: await statisticsRepository.listRecords(),
  };
}

async function writeAutomaticBackup(): Promise<void> {
  const bundle = await createBackupBundle();
  const directory = app.getPath('userData');
  const filePath = path.join(directory, `backup-${Date.now()}.json`);
  const temporaryPath = `${filePath}.tmp`;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(temporaryPath, JSON.stringify(bundle, null, 2), 'utf8');
  await fs.rename(temporaryPath, filePath);
}

function parseBackupBundle(candidate: unknown): BackupBundle {
  if (!isRecord(candidate) || candidate.version !== 1 || !isRecord(candidate.settings) || !isRecord(candidate.taskFlow) || !Array.isArray(candidate.focusRecords)) {
    throw new Error(t('main.error.backupInvalid'));
  }
  return candidate as unknown as BackupBundle;
}

// ═══════════════════════════════════════════
// IPC
// ═══════════════════════════════════════════

function registerIpc(): void {
  // ── 命中表 ──
  ipcMain.on('hitmap:set', (_event, data: { buffer: number[] }) => {
    hitmapBuffer = Buffer.from(data.buffer);
    lastIgnoreState = !lastIgnoreState;
    if (!pollingTimer) startPolling();
  });

  // ── 拖拽 ──
ipcMain.on('drag:start', () => {
  isDragging = true;
  if (mainWindow) {
    const cursor = screen.getCursorScreenPoint();
    const bounds = mainWindow.getBounds();
    // Both values use Electron's display coordinate space, unlike renderer
    // MouseEvent.screenX which can change scale when crossing monitors.
    dragCursorOffset = { x: cursor.x - bounds.x, y: cursor.y - bounds.y };
    mainWindow.setIgnoreMouseEvents(false);
  }
});

ipcMain.on('drag:end', () => {
  isDragging = false;
  dragCursorOffset = null;
  lastIgnoreState = false;
});

  ipcMain.on(
  'window:move',
  () => {
    if (mainWindow && dragCursorOffset) {
      const cursor = screen.getCursorScreenPoint();
      mainWindow.setPosition(
        Math.round(cursor.x - dragCursorOffset.x),
        Math.round(cursor.y - dragCursorOffset.y),
      );
    }
  }
);

  // ── 按钮事件（渲染→主→FSM） ──
  ipcMain.on('button:action', (_event, action: string) => {
    fsm.dispatchAction(action as any);

    if (action === 'stem' && mainWindow && !mainWindow.isDestroyed()) {
      const shouldPin = fsm.getIsPinned();
      mainWindow.setAlwaysOnTop(shouldPin, shouldPin ? 'screen-saver' : 'normal');
      if (shouldPin) mainWindow.moveTop();
      if (mainWindow.isAlwaysOnTop() !== shouldPin) {
        fsm.setPinned(mainWindow.isAlwaysOnTop());
      }
    }

    // 窗口和任务管理器入口等非计时动作在主进程处理。
    if (action === 'close') {
      app.quit();
    } else if (action === 'minimize') {
      hideMainWindow();
    } else if (action === 'snail') {
      openSettingsWindow();
    }
  });

  ipcMain.on('taskflow:open', () => taskFlowWindow?.toggle());
  // The tomato-clock snail button uses the legacy settings:toggle channel.
  // Keep it as an alias so both window entry points open the same settings window.
  ipcMain.on('settings:toggle', () => openSettingsWindow());
  ipcMain.on('settings:open', () => openSettingsWindow());
  ipcMain.on('settings:close', () => hideSettingsWindow());
  ipcMain.handle('app:get-version', () => app.getVersion());
  ipcMain.handle('settings:load', () => appSettings);
  ipcMain.handle('sound:import-custom', () => importCustomSound());
  ipcMain.handle('sound:get-custom-url', (_event, asset: unknown) => customSoundUrl(asset));
  ipcMain.handle('settings:save', async (_event, candidate: unknown) => {
    const saved = await settingsRepository.save(candidate);
    applySettings(saved);
    return saved;
  });
  ipcMain.handle('settings:reset', async () => {
    await writeAutomaticBackup();
    const saved = await settingsRepository.reset();
    applySettings(saved);
    return saved;
  });
  ipcMain.handle('settings:get-taskflow-preferences', () => getTaskFlowPreferences(appSettings));
  ipcMain.handle('statistics:dashboard', () => statisticsRepository.getDashboard());
  ipcMain.handle('statistics:clear', async () => {
    await writeAutomaticBackup();
    await statisticsRepository.clear();
  });
  ipcMain.handle('taskflow:clear-archived', async () => {
    await writeAutomaticBackup();
    const current = await taskFlowRepository.load();
    const archivedIds = new Set(current.projects.filter((project) => project.archived).map((project) => project.id));
    const projects = current.projects.filter((project) => !archivedIds.has(project.id));
    const cards = current.cards.filter((card) => !archivedIds.has(card.projectId));
    const cardIds = new Set(cards.map((card) => card.id));
    const next: TaskFlowData = {
      ...current,
      projects,
      cards,
      groups: current.groups.filter((group) => cards.some((card) => card.groupId === group.id)),
      edges: current.edges.filter((edge) => cardIds.has(edge.sourceId) && cardIds.has(edge.targetId)),
      pinnedCardId: current.pinnedCardId && cardIds.has(current.pinnedCardId) ? current.pinnedCardId : null,
      activeProjectId: current.activeProjectId && projects.some((project) => project.id === current.activeProjectId)
        ? current.activeProjectId
        : projects[0]?.id ?? null,
    };
    await taskFlowRepository.save(next);
    taskFlowData = next;
    syncPinnedTaskTitle(next);
    taskFlowWindow?.reloadData();
  });
  ipcMain.handle('data:export', async () => {
    const parent = settingsWindow ?? mainWindow;
    const options = {
      title: t('main.dialog.exportData'),
      defaultPath: `tomato-clock-user-data-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: t('main.dialog.userDataFilter'), extensions: ['json'] }],
    };
    const result = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    const temporaryPath = `${result.filePath}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify(await createBackupBundle(), null, 2), 'utf8');
    await fs.rename(temporaryPath, result.filePath);
    return result.filePath;
  });
  ipcMain.handle('data:import', async () => {
    const parent = settingsWindow ?? mainWindow;
    const options = {
      title: t('main.dialog.importData'),
      properties: ['openFile' as const],
      filters: [{ name: t('main.dialog.userDataFilter'), extensions: ['json'] }],
    };
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return false;
    const bundle = parseBackupBundle(JSON.parse(await fs.readFile(result.filePaths[0], 'utf8')) as unknown);
    const previous = await createBackupBundle();
    await writeAutomaticBackup();
    try {
      await taskFlowRepository.save(bundle.taskFlow);
      await statisticsRepository.replaceRecords(bundle.focusRecords);
      const saved = await settingsRepository.save(bundle.settings);
      taskFlowData = await taskFlowRepository.load();
      syncPinnedTaskTitle(taskFlowData);
      applySettings(saved);
      taskFlowWindow?.reloadData();
      return true;
    } catch (error) {
      await taskFlowRepository.save(previous.taskFlow);
      await statisticsRepository.replaceRecords(previous.focusRecords);
      taskFlowData = previous.taskFlow;
      syncPinnedTaskTitle(previous.taskFlow);
      applySettings(await settingsRepository.save(previous.settings));
      taskFlowWindow?.reloadData();
      throw error;
    }
  });

  ipcMain.on('timer:setWaitingDuration', (_event, minutes: unknown) => {
    const state = fsm.getDisplay().state;
    const isLongRestDue = state === TimerState.WaitingRest && fsm.isLongRestDue();
    if (typeof minutes !== 'number' || !fsm.setWaitingDuration(minutes)) {
      sendToRenderer('timer:state', fsm.getDisplay());
      return;
    }
    if (state === TimerState.Idle) appSettings.timer.focusMinutes = minutes;
    if (state === TimerState.WaitingRest && appSettings.timer.restMode === 'manual') {
      if (isLongRestDue) appSettings.timer.longRestMinutes = minutes;
      else appSettings.timer.shortRestMinutes = minutes;
    }
    void settingsRepository.save(appSettings)
      .then(applySettings)
      .catch((error) => console.error('[settings] Failed to persist timer input:', error));
  });

  // ── 过渡动画播完回调（渲染→主，P1 握手协议） ──
  ipcMain.on('transition:done', (_event, id: string) => {
    fsm.notifyTransitionDone(id);
  });

  // ── 庆祝动画播完回调（P2） ──
  ipcMain.on('celebrate:done', () => {
    fsm.finishCelebrate();
  });

  // ── TEMP: P2 庆祝调试触发（任务管理器落地后移除，改由任务完成事件触发） ──
  ipcMain.on('debug:celebrate', () => {
    fsm.dispatchCelebrate();
  });

  // ── 调试模式：强制切换状态机 ──
  ipcMain.on('debug:switchState', (_event, state: string) => {
    fsm.debugForceState(state as TimerState);
  });

  // ── P5 动画后台面板 ──
  ipcMain.on('animlab:open', () => {
    createLabWindow();
  });
  ipcMain.on('animlab:close', () => {
    labWindow?.close();
  });
  // 预览请求：lab → main → tomato 渲染进程
  ipcMain.on('animlab:preview', (_event, data) => {
    sendToRenderer('animlab:preview', data);
  });

  // ── 渲染就绪 → 发送初始状态 ──
  ipcMain.on('renderer:ready', () => {
    sendToRenderer('timer:state', fsm.getDisplay());
    sendToRenderer('taskflow:pinned-title', { title: pinnedTaskTitle });
    sendToRenderer('settings:updated', appSettings);
  });
  ipcMain.on('renderer:initial-frame-ready', () => {
    mainWindowFrameReady = true;
    showMainWindow();
  });

  // ── 初始化 FSM 回调 → 广播状态 ──
  fsm.setOnStateChange((display: TimerDisplayState) => {
    sendToRenderer('timer:state', display);
  });

  fsm.setOnTick((display: TimerDisplayState) => {
    sendToRenderer('timer:tick', display);
  });
}

// ═══════════════════════════════════════════
// 生命周期
// ═══════════════════════════════════════════

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  registerIpc();
  applySettings(await settingsRepository.load());
  taskFlowWindow = new TaskFlowWindowController({
    repository: taskFlowRepository,
    timerFSM: fsm,
    onPinnedTitleChange: (title) => {
      pinnedTaskTitle = title;
      // 先广播稳定数据契约；蜗牛告示牌渲染接入后可直接监听该事件。
      sendToRenderer('taskflow:pinned-title', { title: pinnedTaskTitle });
    },
    onDataChange: (data) => {
      taskFlowData = data;
      syncPinnedTaskTitle(data);
    },
  });
  taskFlowData = await taskFlowRepository.load(app.getVersion(), appSettings.language);
  const loadedTaskFlowData = taskFlowData;
  syncPinnedTaskTitle(loadedTaskFlowData);
  fsm.setOnFocusStarted((plannedSeconds) => focusTracker.begin(plannedSeconds, currentFocusTask()));
  fsm.setOnFocusEnded((focusSeconds, completed, finalize) => {
    const record = focusTracker.finish(focusSeconds, completed, finalize);
    if (record && record.focusSeconds > 0) {
      void statisticsRepository.record(record).catch((error) => console.error('[statistics] Failed to save focus record:', error));
    }
  });
  createWindow();
  createTray();
  if (showRequestedBySecondInstance) showMainWindow(true);
  // 主面板启动完成后在后台预热设置页，避免第一次点击时才初始化整个渲染进程。
  setTimeout(() => {
    if (!isQuitting) createSettingsWindow();
  }, 800);
}).catch((error) => {
  console.error('[main] Failed to initialize application:', error);
  dialog.showErrorBox(t('main.error.startFailed'), t('main.error.startFailedDetail', { message: error instanceof Error ? error.message : String(error) }));
  app.quit();
});

if (hasSingleInstanceLock) {
  app.on('second-instance', () => {
    revealExistingMainWindow();
  });
}

app.on('window-all-closed', () => {
  // Windows 保持托盘
});

app.on('before-quit', () => {
  isQuitting = true;
  stopPolling();
  globalShortcut.unregisterAll();
});

app.on('activate', () => {
  if (!mainWindow) {
    createWindow();
  } else {
    showMainWindow();
  }
});
