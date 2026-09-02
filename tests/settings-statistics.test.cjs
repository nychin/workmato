const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { SettingsRepository } = require('../dist/main/settings/repository.js');
const { StatisticsRepository } = require('../dist/main/statistics/repository.js');
const { FocusSessionTracker } = require('../dist/main/statistics/tracker.js');

test('settings normalize invalid imported values and persist valid settings', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tomato-settings-test-'));
  try {
    const repository = new SettingsRepository({ dataDirectory: directory });
    const saved = await repository.save({
      version: 999,
      timer: { focusMinutes: 40, restMode: 'manual', autoShortRestPercent: 25, autoLongRestMultiplier: 4, includeProlongationInAutoRest: true, shortRestMinutes: 8, longRestMinutes: 25, longRestInterval: 4 },
      shortcuts: { toggleMainWindow: 'Ctrl+P', toggleTimer: null },
      enterSwap: true,
      wheelCtrlSwap: true,
      tomatoPanelDoubleSize: true,
      launchAtLogin: true,
      sound: { enabled: false, volume: 83, events: { focusStart: 'happy' } },
      taskFlowTheme: { coral: '#010203', leaf: 'bad-color' },
    });
    assert.equal(saved.timer.focusMinutes, 40);
    assert.equal(saved.timer.restMode, 'manual');
    assert.equal(saved.timer.autoShortRestRatio, 0.3);
    assert.equal(saved.timer.autoLongRestRatio, 1);
    assert.equal(saved.timer.includeProlongationInAutoRest, true);
    assert.equal(saved.timer.longRestInterval, 4);
    assert.equal(saved.enterSwap, true);
    assert.equal(saved.wheelCtrlSwap, true);
    assert.equal(saved.tomatoPanelScale, 2);
    assert.equal(saved.launchAtLogin, true);
    assert.equal(saved.sound.volume, 83);
    assert.equal(saved.sound.events.focusStart, 'happy');
    assert.equal(saved.taskFlowTheme.coral, '#010203');
    assert.equal(saved.taskFlowTheme.leaf, '#79B64D');
    assert.deepEqual(await repository.load(), saved);

    const legacy = await repository.save({ timer: { focusMinutes: 25 } });
    assert.equal(legacy.wheelCtrlSwap, false);
    assert.equal(legacy.tomatoPanelScale, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('prolongation updates the same focus record instead of adding a pomodoro', async () => {
  const tracker = new FocusSessionTracker();
  tracker.begin(1800, { taskCardId: 'card-1', taskTitle: 'Write tests', projectId: null, projectTitle: null });
  const checkpoint = tracker.finish(1800, true, false);
  const finalized = tracker.finish(2100, true, true);
  assert.ok(checkpoint);
  assert.ok(finalized);
  assert.equal(finalized.id, checkpoint.id);
  assert.equal(finalized.focusSeconds, 2100);
  assert.equal(tracker.finish(2200, true, true), null);
});

test('statistics persists records and aggregates local day week month values', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tomato-statistics-test-'));
  try {
    const repository = new StatisticsRepository({ dataDirectory: directory });
    await repository.record({
      id: 'focus-1', startedAt: '2026-08-12T01:00:00.000Z', completedAt: '2026-08-12T01:30:00.000Z', localDate: '2026-08-12',
      taskCardId: 'card-1', taskTitle: 'Write tests', projectId: 'project-1', projectTitle: 'Tomato', focusSeconds: 1800, plannedSeconds: 1800, completed: true,
    });
    await repository.record({
      id: 'focus-2', startedAt: '2026-08-11T01:00:00.000Z', completedAt: '2026-08-11T01:10:00.000Z', localDate: '2026-08-11',
      taskCardId: null, taskTitle: null, projectId: null, projectTitle: null, focusSeconds: 600, plannedSeconds: 1800, completed: false,
    });
    const dashboard = await repository.getDashboard(new Date('2026-08-12T09:00:00+08:00'));
    assert.deepEqual(dashboard.day, { focusSeconds: 1800, pomodoroCount: 1 });
    assert.deepEqual(dashboard.week, { focusSeconds: 2400, pomodoroCount: 1 });
    assert.equal(dashboard.rankings[0].taskTitle, 'Write tests');
    const restored = new StatisticsRepository({ dataDirectory: directory });
    assert.equal((await restored.listRecords()).length, 2);
    await restored.clear();
    assert.equal((await restored.listRecords()).length, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
