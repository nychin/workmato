const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { getTimerDay } = require('../dist/shared/timer-day.js');
const { createDefaultSettings } = require('../dist/shared/settings.js');
const { normalizeSettings } = require('../dist/main/settings/repository.js');
const { TimerFSM } = require('../dist/main/timer/fsm.js');
const { TimerState } = require('../dist/main/timer/types.js');
const { TimerDailyRepository } = require('../dist/main/timer/daily-repository.js');

function clock(t, time) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(time).getTime() });
  return (next) => t.mock.timers.setTime(new Date(next).getTime());
}
function machine(t, resetTime = '00:00') {
  const fsm = new TimerFSM();
  fsm.applySettings({ ...createDefaultSettings().timer, resetTime });
  t.after(() => {
    fsm.engine.stop(false);
    clearTimeout(fsm.transitionWatchdog);
    clearTimeout(fsm.celebrateWatchdog);
  });
  return fsm;
}
function finishFocus(fsm) {
  fsm.currentState = TimerState.Focus;
  fsm.handleTimerComplete();
  fsm.notifyTransitionDone('focus_to_prolongation');
}

test('reset time defaults, validation and local calendar boundaries', () => {
  assert.equal(normalizeSettings({}).timer.resetTime, '00:00');
  for (const invalid of ['24:00', '04:60', '4:00', null]) assert.equal(normalizeSettings({ timer: { resetTime: invalid } }).timer.resetTime, '00:00');
  assert.equal(normalizeSettings({ timer: { resetTime: '04:30' } }).timer.resetTime, '04:30');
  assert.equal(getTimerDay(new Date(2026, 0, 1, 0, 0), '04:30'), '2025-12-31');
  assert.equal(getTimerDay(new Date(2026, 8, 15, 4, 29, 59), '04:30'), '2026-09-14');
  assert.equal(getTimerDay(new Date(2026, 8, 15, 4, 30), '04:30'), '2026-09-15');
});

test('one completed focus adds one mark; prolongation and a cancelled focus do not add another', (t) => {
  clock(t, '2026-09-14T12:00:00');
  const fsm = machine(t);
  finishFocus(fsm);
  assert.equal(fsm.getDisplay().dailyPomodoroCount, 1);
  fsm.handleRest();
  fsm.notifyTransitionDone('prolongation_to_waitingRest');
  assert.equal(fsm.getDisplay().dailyPomodoroCount, 1);
  fsm.currentState = TimerState.FocusPaused;
  fsm.handleReset();
  assert.equal(fsm.getDisplay().dailyPomodoroCount, 1);
});

test('crossing configured reset clears both counters, keeps active timer, and publishes during idle', (t) => {
  const setTime = clock(t, '2026-09-15T04:29:00');
  const fsm = machine(t, '04:30');
  fsm.restoreDailyProgress({ version: 1, day: '2026-09-14', pomodoroCount: 8, restsSinceLong: 3 });
  assert.equal(fsm.isLongRestDue(), true);
  fsm.currentState = TimerState.Focus;
  fsm.engine.startCountdown(1800);
  fsm.engine.state.elapsedSeconds = 125;
  setTime('2026-09-15T04:30:00');
  let published;
  fsm.setOnTick((display) => { published = display; });
  fsm.refreshDailyCycle();
  assert.equal(published.dailyPomodoroCount, 0);
  assert.equal(fsm.isLongRestDue(), false);
  assert.equal(fsm.engine.getState().elapsedSeconds, 125);
  assert.equal(fsm.getDisplay().state, TimerState.Focus);
  finishFocus(fsm);
  assert.equal(fsm.getDisplay().dailyPomodoroCount, 1);
  fsm.currentState = TimerState.Idle;
  setTime('2026-09-16T04:30:00');
  fsm.refreshDailyCycle();
  assert.equal(published.dailyPomodoroCount, 0);
});

test('long rest crossing midnight does not increment the new day; new short rests retain normal cadence', (t) => {
  const setTime = clock(t, '2026-09-14T23:59:00');
  const fsm = machine(t);
  fsm.restoreDailyProgress({ version: 1, day: '2026-09-14', pomodoroCount: 4, restsSinceLong: 3 });
  fsm.currentState = TimerState.WaitingRest;
  fsm.handleStart();
  assert.equal(fsm.activeRestWasLong, true);
  setTime('2026-09-15T00:01:00');
  fsm.refreshDailyCycle();
  fsm.countCompletedRest();
  assert.equal(fsm.restsSinceLong, 0);
  for (let i = 0; i < 3; i++) { fsm.startRestCountdown(); fsm.countCompletedRest(); }
  assert.equal(fsm.isLongRestDue(), true);
  fsm.startRestCountdown();
  fsm.countCompletedRest();
  assert.equal(fsm.restsSinceLong, 0);
});

test('daily progress survives restart and expires across closed-app reset boundaries', async (t) => {
  const setTime = clock(t, '2026-09-14T12:00:00');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tomato-daily-'));
  try {
    const repo = new TimerDailyRepository(directory);
    const progress = { version: 1, day: '2026-09-14', pomodoroCount: 13, restsSinceLong: 2 };
    await repo.save(progress);
    await repo.flush();
    const loaded = await new TimerDailyRepository(directory).load();
    assert.deepEqual(loaded, progress);
    const fsm = machine(t);
    fsm.restoreDailyProgress(loaded);
    assert.equal(fsm.getDisplay().dailyPomodoroCount, 13);
    assert.equal(fsm.restsSinceLong, 2);
    setTime('2026-09-16T10:00:00');
    fsm.restoreDailyProgress(loaded);
    assert.equal(fsm.getDisplay().dailyPomodoroCount, 0);
    assert.equal(fsm.restsSinceLong, 0);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
