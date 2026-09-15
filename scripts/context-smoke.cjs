// 独立 Electron 冒烟测试：使用临时数据，不启动或修改用户的番茄钟实例。
const { app, BrowserWindow, screen, ipcMain } = require('electron');
const { DEFAULT_SETTINGS } = require('../dist/shared/settings.js');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ContextRepository } = require('../dist/main/context/repository.js');
const { ContextWindowController } = require('../dist/main/context/window.js');
const { CONTEXT_PASSTHROUGH_RECT } = require('../dist/shared/context.js');
const output = path.resolve(__dirname, '../.context-smoke');
app.setPath('userData', path.join(output, 'electron'));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  let settings = { ...DEFAULT_SETTINGS, language: 'en-US' };
  ipcMain.handle('settings:load', () => settings);
  await fs.mkdir(output, { recursive: true });
  const directory = await fs.mkdtemp(path.join(output, 'data-'));
  const repository = new ContextRepository(directory);
  await repository.change({ type: 'add', text: '下一步：整理思路\n把当前任务拆成三个小步骤。' });
  const controller = new ContextWindowController(repository);
  try {
    controller.open();
    const panel = BrowserWindow.getAllWindows()[0];
    panel.once('show', () => assert.equal(panel.getOpacity(), 0, 'first native frame is transparent before fade-in'));
    const errors = [];
    panel.webContents.on('console-message', (event) => { if (event.level === 'error') { errors.push(event.message); console.error('[renderer]', event.message); } });
    await new Promise((resolve) => panel.webContents.once('did-finish-load', resolve));
    await delay(200);
    const run = async (code) => {
      try { return await panel.webContents.executeJavaScript(code, true); }
      catch (error) { console.error('Failed renderer check:', code, errors); throw error; }
    };
    const nativeCursor = screen.getCursorScreenPoint;
    assert.equal(await run("document.title"), 'Temporary notes', 'initial saved language loads');
    settings = { ...settings, language: 'zh-CN' };
    controller.sendSettings(settings);
    await delay(80);
    assert.equal(await run("document.querySelector('#add').title"), '新增记录');
    const bounds = panel.getBounds();
    let pointer = { x: bounds.x + 4, y: bounds.y + 4 };
    screen.getCursorScreenPoint = () => pointer;
    await delay(80);
    assert.equal(await run("document.querySelector('#app').classList.contains('expanded')"), true);
    pointer = { x: bounds.x - 30, y: bounds.y - 30 };
    await delay(100);
    assert.equal(await run("document.querySelector('#app').classList.contains('expanded')"), true);
    await delay(220);
    assert.equal(await run("document.querySelector('#app').classList.contains('expanded')"), false);
    screen.getCursorScreenPoint = nativeCursor;
    await run("window.contextAPI.togglePin()");
    await delay(250);
    assert.equal(await run("document.querySelector('#app').classList.contains('expanded')"), true);
    assert.deepEqual(await run("[document.querySelector('#panel').offsetWidth, document.querySelector('#panel').offsetHeight]"), [433, 225]);
    assert.equal(await run("document.querySelector('#tomato img').naturalWidth > 0"), true);
    async function dragWindow(window, x, y) {
      const before = window.getBounds();
      const savedCursor = screen.getCursorScreenPoint;
      let dragPointer = { x: before.x + x, y: before.y + y };
      screen.getCursorScreenPoint = () => dragPointer;
      try {
        window.focus();
        await delay(80);
        window.webContents.sendInputEvent({ type: 'mouseMove', x, y });
        window.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        await delay(60);
        assert.ok(controller.drag, 'pointer down starts native drag');
        dragPointer = { x: before.x + x + 60, y: before.y + y + 45 };
        window.webContents.sendInputEvent({ type: 'mouseMove', x: x + 60, y: y + 45, modifiers: ['leftButtonDown'] });
        await delay(100);
        window.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
        await delay(100);
        const after = window.getBounds();
        assert.equal(after.x, before.x + 60);
        assert.equal(after.y, before.y + 45);
      } finally { screen.getCursorScreenPoint = savedCursor; }
    }
    await dragWindow(panel, 18, 18);
    assert.equal(await run("document.querySelector('#tomato').getAttribute('aria-pressed')"), 'true', 'drag must not toggle pin');
    const pinBounds = panel.getBounds();
    screen.getCursorScreenPoint = () => ({ x: pinBounds.x + 18, y: pinBounds.y + 18 });
    try {
      await delay(80);
      for (const pinned of [false, true]) {
        panel.webContents.sendInputEvent({ type: 'mouseMove', x: 18, y: 18 });
        panel.webContents.sendInputEvent({ type: 'mouseDown', x: 18, y: 18, button: 'left', clickCount: 1 });
        await delay(50);
        assert.equal(await run("document.querySelector('#tomato').classList.contains('pressing')"), true);
        panel.webContents.sendInputEvent({ type: 'mouseUp', x: 18, y: 18, button: 'left', clickCount: 1 });
        await delay(180);
        assert.equal(await run("document.querySelector('#tomato').getAttribute('aria-pressed')"), String(pinned));
        assert.equal(await run("document.querySelector('#tomato').classList.contains('pressing')"), false);
        assert.ok(await run("new DOMMatrix(getComputedStyle(document.querySelector('#tomato img')).transform).a >= 1"), 'release restores scale in both modes');
      }
      assert.equal(await run("getComputedStyle(document.querySelector('#tomato img')).width"), '39px');
    } finally { screen.getCursorScreenPoint = nativeCursor; }
    await run(`window.contextAPI.change(${JSON.stringify({ type: 'scratch', text: '临时参考\n会议时间：下午 3 点' })})`);
    await run("document.querySelector('.freshness').click()");
    await delay(100);
    assert.equal((await repository.load()).notes[0].preserved, true);
    await fs.writeFile(path.join(output, 'panel.png'), (await panel.webContents.capturePage()).toPNG());
    await run("window.contextAPI.change({type:'opacity',value:0.6})");
    assert.ok(Math.abs(panel.getOpacity() - 0.6) < 0.02);
    await run("window.contextAPI.setPassthrough(true)");
    await delay(80);
    assert.equal(await run("document.querySelector('#passthrough').getAttribute('aria-pressed')"), 'true');
    const switchRect = await run("(() => { const r = document.querySelector('#passthrough').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()");
    assert.deepEqual(switchRect, CONTEXT_PASSTHROUGH_RECT, 'native recovery hit rectangle matches rendered button');
    await fs.writeFile(path.join(output, 'passthrough.png'), (await panel.webContents.capturePage()).toPNG());
    const passBounds = panel.getBounds();
    let passPointer = { x: passBounds.x + 150, y: passBounds.y + 100 };
    screen.getCursorScreenPoint = () => passPointer;
    try {
      await delay(80);
      assert.equal(controller.ignored, true, 'editor area passes through');
      passPointer = { x: passBounds.x + switchRect.x + 5, y: passBounds.y + switchRect.y + 5 };
      await delay(80);
      assert.equal(controller.ignored, false, 'recovery switch remains clickable');
      panel.webContents.sendInputEvent({ type: 'mouseMove', x: switchRect.x + 5, y: switchRect.y + 5 });
      panel.webContents.sendInputEvent({ type: 'mouseDown', x: switchRect.x + 5, y: switchRect.y + 5, button: 'left', clickCount: 1 });
      panel.webContents.sendInputEvent({ type: 'mouseUp', x: switchRect.x + 5, y: switchRect.y + 5, button: 'left', clickCount: 1 });
      await delay(80);
      assert.equal(await run("document.querySelector('#passthrough').getAttribute('aria-pressed')"), 'false', 'clicking the switch restores interaction');
    } finally { screen.getCursorScreenPoint = nativeCursor; }
    await run("window.contextAPI.setPassthrough(true)");
    controller.toggle();
    assert.equal(panel.isVisible(), false);
    controller.toggle();
    await delay(80);
    assert.equal(await run("document.querySelector('#passthrough').getAttribute('aria-pressed')"), 'false');
    await controller.openCapture();
    const capture = BrowserWindow.getAllWindows().find((window) => window !== panel);
    await new Promise((resolve) => capture.webContents.once('did-finish-load', resolve));
    await delay(200);
    assert.equal(await capture.webContents.executeJavaScript("document.activeElement.id"), 'capture-text');
    await capture.webContents.executeJavaScript("document.querySelector('#capture-text').value='草稿 draft';document.querySelector('#capture-text').setSelectionRange(1,3)");
    for (const [language, title, save] of [['en-US', 'Temporary notes', 'Save'], ['ja-JP', '一時メモ', '保存'], ['zh-CN', '临时便签', '保存']]) {
      settings = { ...settings, language };
      controller.sendSettings(settings);
      await delay(100);
      assert.equal(await run('document.title'), title);
      assert.equal(await capture.webContents.executeJavaScript("document.querySelector('#capture-save').textContent"), save);
      assert.deepEqual(await capture.webContents.executeJavaScript("(() => {const input=document.querySelector('#capture-text');return [input.value,input.selectionStart,input.selectionEnd,document.activeElement.id,document.documentElement.lang]})()"), ['草稿 draft', 1, 3, 'capture-text', language]);
      await fs.writeFile(path.join(output, `capture-${language}.png`), (await capture.webContents.capturePage()).toPNG());
    }
    await dragWindow(capture, 220, 10);
    assert.equal(await capture.webContents.executeJavaScript("document.activeElement.id"), 'capture-text');
    await fs.writeFile(path.join(output, 'capture.png'), (await capture.webContents.capturePage()).toPNG());
    await capture.webContents.executeJavaScript("document.querySelector('#capture-text').value='速记测试';document.querySelector('#capture-save').click()", true);
    await delay(250);
    assert.equal(capture.isVisible(), false);
    assert.ok((await repository.load()).notes.some((note) => note.text === '速记测试'));
    await run("document.querySelector('#add').click()");
    await delay(150);
    await run("const field=document.querySelector('#note-text');field.value='连续输入';field.dispatchEvent(new Event('input'));field.value='连续输入完成';field.dispatchEvent(new Event('input'));");
    await delay(150);
    assert.ok((await repository.load()).notes.some((note) => note.text === '连续输入完成'));
    const beforeDelete = (await repository.load()).notes.length;
    // 编辑区 Delete 只交给文本框，不能删除整条记录。
    await run("document.querySelector('#note-text').focus()");
    panel.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Delete' });
    panel.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Delete' });
    await delay(100);
    assert.equal((await repository.load()).notes.length, beforeDelete);
    await run("document.querySelector('.note-row.selected .note-label').focus();document.querySelector('.note-row.selected .note-label').click()");
    panel.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Delete' });
    panel.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Delete' });
    await delay(150);
    assert.equal((await repository.load()).notes.length, beforeDelete - 1);
    assert.equal(await run("document.activeElement.classList.contains('note-label')"), true, 'list retains focus after deleting');
    // 长列表截图用于检查字重、可见宽度和滚动边缘渐隐。
    await run("Promise.all(Array.from({length: 14}, (_, i) => window.contextAPI.change({type: 'add', text: '整理下一步计划 ' + (i + 1)})))");
    await run("document.fonts.ready.then(() => { document.querySelector('#notes').scrollTop = 48; })");
    await delay(80);
    await fs.writeFile(path.join(output, 'list.png'), (await panel.webContents.capturePage()).toPNG());
    assert.deepEqual(errors, []);
    console.log(`Context smoke passed; screenshot: ${path.join(output, 'panel.png')}`);
  } finally {
    controller.dispose();
    await controller.flush();
  }
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });

