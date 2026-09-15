// 使用构建后的真实页面和隔离数据，检查逐层划线与计时设置。
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createDefaultSettings } = require('../dist/shared/settings.js');
const { SettingsRepository } = require('../dist/main/settings/repository.js');
const { TimerFSM } = require('../dist/main/timer/fsm.js');
const output = path.resolve(__dirname, '../.context-smoke/timer');
app.setPath('userData', path.join(output, 'electron'));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  const directory = await fs.mkdtemp(path.join(output, 'settings-'));
  const repository = new SettingsRepository({ dataDirectory: directory });
  const defaults = createDefaultSettings();
  defaults.sound.enabled = false;
  let settings = await repository.save(defaults);
  ipcMain.handle('settings:load', () => settings);
  ipcMain.handle('app:get-version', () => 'smoke');
  ipcMain.handle('statistics:dashboard', () => ({ day: { focusSeconds: 0, pomodoroCount: 0 }, week: { focusSeconds: 0, pomodoroCount: 0 }, month: { focusSeconds: 0, pomodoroCount: 0 }, rankings: [], projectRankings: [] }));
  ipcMain.handle('settings:save', async (_event, candidate) => { settings = await repository.save(candidate); return settings; });
  const errors = [];
  function createWindow(width, height) {
    const window = new BrowserWindow({ width, height, frame: false, transparent: true, show: false,
      webPreferences: { preload: path.resolve(__dirname, '../dist/preload/index.js'), contextIsolation: true, nodeIntegration: false } });
    window.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
    return window;
  }
  const timer = createWindow(491, 407);
  const display = new TimerFSM().getDisplay();
  const ready = new Promise((resolve) => ipcMain.once('renderer:ready', () => {
    timer.webContents.send('timer:state', display);
    timer.webContents.send('settings:updated', settings);
    resolve();
  }));
  await timer.loadFile(path.resolve(__dirname, '../dist/renderer/index.html'));
  timer.showInactive();
  await Promise.race([ready, delay(15000).then(() => { throw new Error('Timer renderer did not become ready'); })]);
  await delay(180);
  const captures = [];
  for (let count = 0; count <= 11; count++) {
    timer.webContents.send('timer:tick', { ...display, dailyPomodoroCount: count });
    await delay(50);
    const crop = await timer.webContents.capturePage({ x: 140, y: 282, width: 44, height: 21 });
    captures.push(crop.toBitmap());
    if (count > 0 && count <= 10) assert.notDeepEqual(captures[count], captures[count - 1], `mark ${count} adds a visible layer`);
    if (count === 10) await fs.writeFile(path.join(output, 'ten-marks.png'), (await timer.webContents.capturePage()).toPNG());
  }
  assert.deepEqual(captures[11], captures[10], 'wall tally caps at ten');
  timer.webContents.send('timer:tick', { ...display, dailyPomodoroCount: 0 });
  await delay(60);
  assert.deepEqual((await timer.webContents.capturePage({ x: 140, y: 282, width: 44, height: 21 })).toBitmap(), captures[0], 'reset removes every mark');

  const settingsWindow = createWindow(860, 760);
  await settingsWindow.loadFile(path.resolve(__dirname, '../dist/renderer/settings.html'));
  settingsWindow.showInactive();
  await delay(180);
  await settingsWindow.webContents.executeJavaScript("document.querySelector('[data-panel=timer]').click()", true);
  assert.equal(await settingsWindow.webContents.executeJavaScript("document.querySelector('#timer-reset-time').value"), '00:00');
  await settingsWindow.webContents.executeJavaScript("const field = document.querySelector('#timer-reset-time');field.value = '04:30';field.dispatchEvent(new Event('change', {bubbles:true}));", true);
  await delay(160);
  assert.equal((await repository.load()).timer.resetTime, '04:30');
  await settingsWindow.webContents.executeJavaScript("document.querySelector('#timer-reset-time').scrollIntoView({block:'center'});document.fonts.ready");
  await fs.writeFile(path.join(output, 'reset-setting.png'), (await settingsWindow.webContents.capturePage()).toPNG());
  assert.deepEqual(errors, []);
  console.log(`Timer UI smoke passed; screenshots: ${output}`);
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
