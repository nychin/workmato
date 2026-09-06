import type { AppLanguage, AppSettings, ShortcutAction, SoundAsset, SoundEvent, StatisticsDashboard } from '../shared/settings';
import { getLocale, setLocale, t, type DictKey } from '../shared/i18n';

type Panel = 'timer' | 'shortcuts' | 'statistics' | 'system' | 'other';

const shortcutLabels: Record<ShortcutAction, DictKey> = {
  toggleMainWindow: 'settings.shortcut.toggleMainWindow',
  toggleTimer: 'settings.shortcut.toggleTimer',
  toggleTaskFlow: 'settings.shortcut.toggleTaskFlow',
  taskflowNewProject: 'settings.shortcut.taskflowNewProject',
  taskflowAddCard: 'settings.shortcut.taskflowAddCard',
  taskflowUndo: 'settings.shortcut.taskflowUndo',
  taskflowRedo: 'settings.shortcut.taskflowRedo',
  openSettings: 'settings.shortcut.openSettings',
  taskflowToggleSidebar: 'settings.shortcut.taskflowToggleSidebar',
  taskflowAddNote: 'settings.shortcut.taskflowAddNote',
  taskflowPlaceTask: 'settings.shortcut.taskflowPlaceTask',
  taskflowDetachCard: 'settings.shortcut.taskflowDetachCard',
  taskflowGroup: 'settings.shortcut.taskflowGroup',
  taskflowToggleNPanel: 'settings.shortcut.taskflowToggleNPanel',
};
const globalShortcutActions: ShortcutAction[] = ['toggleMainWindow', 'toggleTimer', 'toggleTaskFlow'];
const appShortcutActions: ShortcutAction[] = [
  'taskflowNewProject', 'taskflowAddCard', 'taskflowUndo', 'taskflowRedo',
  'openSettings', 'taskflowToggleSidebar', 'taskflowAddNote', 'taskflowPlaceTask',
  'taskflowDetachCard', 'taskflowGroup', 'taskflowToggleNPanel',
];
// 语言名以各自语言书写，不随界面语言翻译。
const languageOptions = [
  ['zh-CN', '中文'],
  ['en-US', 'English'],
  ['ja-JP', '日本語'],
] as const;

const panelElement = document.querySelector<HTMLElement>('#settings-panel')!;
const scrollbarElement = document.querySelector<HTMLElement>('#settings-scrollbar')!;
const scrollbarThumbElement = document.querySelector<HTMLElement>('#settings-scrollbar-thumb')!;
const statusElement = document.querySelector<HTMLElement>('#settings-status')!;
const supportModal = document.querySelector<HTMLElement>('#support-modal')!;
const versionElement = document.querySelector<HTMLElement>('#settings-version')!;
let activePanel: Panel = 'statistics';
let settings: AppSettings;
// 当前真正生效的语言。注意不能用 settings.language 判断“是否变化”：
// persist() 在 onUpdated 广播到达前就会把 settings 改写为新语言，导致对比失效。
let activeLanguage: AppLanguage = 'zh-CN';
let recordingShortcut: ShortcutAction | null = null;
let pendingShortcutValue: string | null = null;
let expandedProjectRankings = new Set<string>();
let statisticsDashboard: StatisticsDashboard | null = null;
const soundEventLabels: Record<SoundEvent, DictKey> = {
  focusStart: 'settings.sound.focusStart', prolongation: 'settings.sound.prolongation', restStart: 'settings.sound.restStart', restEnd: 'settings.sound.restEnd', taskComplete: 'settings.sound.taskComplete',
};
const builtInSoundOptions: Array<{ id: Exclude<SoundAsset, `custom:${string}` | null>; label: string }> = [
  { id: 'focus_start', label: 'focus_start.wav' },
  { id: 'focus_start_02', label: 'focus_start_02.mp3' },
  { id: 'focus_start_03', label: 'focus_start_03.mp3' },
  { id: 'prolongation', label: 'prolongation.mp3' },
  { id: 'prolongation_02', label: 'prolongation_02.mp3' },
  { id: 'rest_start', label: 'rest_start.mp3' },
  { id: 'rest_end', label: 'rest_end.mp3' },
  { id: 'happy', label: 'happy.mp3' },
  { id: 'rage', label: 'rage.mp3' },
];
const customSoundLabels = new Map<string, string>();
let scrollbarDragStart: { clientY: number; scrollTop: number } | null = null;

/** 把当前语言应用到静态 DOM（标题、导航、aria 标签）。 */
function applyLocaleToDocument(): void {
  document.title = t('settings.appTitle');
  document.documentElement.lang = getLocale();
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((element) => {
    element.textContent = t(element.dataset.i18n as DictKey);
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((element) => {
    element.setAttribute('aria-label', t(element.dataset.i18nAria as DictKey));
  });
  document.querySelectorAll<HTMLImageElement>('[data-i18n-alt]').forEach((element) => {
    element.alt = t(element.dataset.i18nAlt as DictKey);
  });
}

/** 切换生效语言：更新词典、静态 DOM，并记录 activeLanguage。 */
function applyLocale(language: AppLanguage): void {
  if (language === activeLanguage) return;
  setLocale(language);
  activeLanguage = language;
  applyLocaleToDocument();
}

function syncSettingsScrollbar(): void {
  const { clientHeight, scrollHeight, scrollTop } = panelElement;
  const trackHeight = scrollbarElement.clientHeight;
  const canScroll = scrollHeight > clientHeight + 1 && trackHeight > 0;
  scrollbarElement.hidden = !canScroll;
  if (!canScroll) return;

  const thumbHeight = Math.max(34, Math.round(trackHeight * (clientHeight / scrollHeight)));
  const maxThumbOffset = Math.max(0, trackHeight - thumbHeight);
  const maxScrollTop = Math.max(1, scrollHeight - clientHeight);
  const thumbOffset = Math.round(maxThumbOffset * (scrollTop / maxScrollTop));
  scrollbarThumbElement.style.height = `${thumbHeight}px`;
  scrollbarThumbElement.style.transform = `translateY(${thumbOffset}px)`;
}

function scheduleSettingsScrollbarSync(): void {
  requestAnimationFrame(syncSettingsScrollbar);
}

function setStatus(message = '', error = false): void {
  statusElement.textContent = message;
  statusElement.classList.toggle('is-error', error);
}

function openSupportModal(): void {
  supportModal.hidden = false;
}

function closeSupportModal(): void {
  supportModal.hidden = true;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]!));
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return t('settings.duration.hm', { h: hours, m: minutes });
}

function getAutoRest(): { short: string; long: string } {
  const shortSeconds = Math.round(settings.timer.focusMinutes * 60 * settings.timer.autoShortRestRatio);
  const longSeconds = Math.round(settings.timer.focusMinutes * 60 * settings.timer.autoLongRestRatio);
  const format = (seconds: number): string => t('settings.duration.ms', { m: Math.floor(seconds / 60), s: Math.round(seconds % 60) });
  return { short: format(shortSeconds), long: format(longSeconds) };
}

function formatRatio(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1);
}

function ratioStepper(id: string, value: number, label: string): string {
  return `<div class="ratio-stepper">
    <input id="${id}" type="number" min="0.1" max="3" step="0.1" value="${formatRatio(value)}" />
    <div class="ratio-stepper__controls">
      <button type="button" data-ratio-step="${id}" data-step-delta="-0.1" aria-label="${t('settings.aria.decrease', { label })}">−</button>
      <button type="button" data-ratio-step="${id}" data-step-delta="0.1" aria-label="${t('settings.aria.increase', { label })}">＋</button>
    </div>
  </div>`;
}

function integerStepper(id: string, value: number, label: string, min: number, max: number): string {
  return `<div class="ratio-stepper">
    <input id="${id}" type="number" min="${min}" max="${max}" step="1" value="${value}" />
    <div class="ratio-stepper__controls">
      <button type="button" data-integer-step="${id}" data-step-delta="-1" aria-label="${t('settings.aria.decrease', { label })}">−</button>
      <button type="button" data-integer-step="${id}" data-step-delta="1" aria-label="${t('settings.aria.increase', { label })}">＋</button>
    </div>
  </div>`;
}

function assetRange(id: string, value: number, min: number, max: number, label: string, markers = false): string {
  const progress = Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
  return `<div class="asset-range${markers ? ' asset-range--with-markers' : ''}" style="--range-progress:${progress}%">
    <div class="asset-range__rail" aria-hidden="true"><span class="asset-range__fill"></span></div>
    <img class="asset-range__thumb" src="./settings-slider/progress-thumb.png" alt="" aria-hidden="true" />
    <input id="${id}" class="asset-range__input" type="range" min="${min}" max="${max}" step="${id === 'tomato-panel-scale' ? 5 : 1}" value="${value}" aria-label="${label}" />
    ${markers ? `<span class="asset-range__marker asset-range__marker--50" aria-hidden="true"></span>
      <span class="asset-range__marker asset-range__marker--100" aria-hidden="true"></span>
      <span class="asset-range__marker asset-range__marker--200" aria-hidden="true"></span>
      <button class="asset-range__marker-hit asset-range__marker-hit--50" data-panel-scale="50" type="button" aria-label="${t('settings.aria.setValue', { value: 50 })}"></button>
      <button class="asset-range__marker-hit asset-range__marker-hit--100" data-panel-scale="100" type="button" aria-label="${t('settings.aria.setValue', { value: 100 })}"></button>
      <button class="asset-range__marker-hit asset-range__marker-hit--200" data-panel-scale="200" type="button" aria-label="${t('settings.aria.setValue', { value: 200 })}"></button>` : ''}
  </div>`;
}

async function persist(message = ''): Promise<void> {
  try {
    settings = await window.settingsAPI.save(settings);
    // 先应用语言再渲染，避免保存广播到达前出现一帧旧语言界面。
    applyLocale(settings.language);
    setStatus(message || t('status.saved'));
    render();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : t('status.saveFailed'), true);
  }
}

function timerPanel(): string {
  const auto = getAutoRest();
  const isAuto = settings.timer.restMode === 'auto';
  return `
    <h1 class="panel-title">${t('settings.timer.title')}</h1>
    <section class="settings-card">
      <div class="setting-row">
        <label class="setting-row__label" for="focus-minutes">${t('settings.timer.focusMinutes')}<span class="setting-row__hint">${t('settings.timer.focusMinutesHint')}</span></label>
        <input id="focus-minutes" type="number" min="1" max="99" value="${settings.timer.focusMinutes}" />
      </div>
    </section>
    <section class="settings-card timer-rest-card">
      <h3>${t('settings.timer.breakLength')}</h3>
      <div class="rest-mode-row">
        <div class="segmented" role="group" aria-label="${t('settings.timer.ariaBreakScheme')}">
          <button data-rest-mode="auto" class="${isAuto ? 'is-active' : ''}">${t('settings.timer.auto')}</button>
          <button data-rest-mode="manual" class="${!isAuto ? 'is-active' : ''}">${t('settings.timer.manual')}</button>
        </div>
        ${isAuto ? '<label class="check-row rest-calculation-check"><input id="include-prolongation-in-auto-rest" type="checkbox" ' + (settings.timer.includeProlongationInAutoRest ? 'checked' : '') + ' />' + t('settings.timer.includeProlongation') + '</label>' : ''}
      </div>
      ${isAuto ? `<div class="setting-row">
        <label class="setting-row__label setting-row__label--emphasis" for="auto-short-rest-ratio">${t('settings.timer.shortBreakRatio')}<span class="setting-row__hint">${t('settings.timer.shortBreakRatioHint')}</span></label>
        ${ratioStepper('auto-short-rest-ratio', settings.timer.autoShortRestRatio, t('settings.timer.shortBreakRatio'))}
      </div>` : ''}
      <div class="setting-row">
        <span class="setting-row__label setting-row__label--emphasis">${t('settings.timer.shortBreakLength')}<span class="setting-row__hint">${t('settings.timer.autoRatioHint', { ratio: formatRatio(settings.timer.autoShortRestRatio) })}</span></span>
        ${isAuto ? `<input value="${auto.short}" disabled />` : `<input id="short-rest-minutes" type="number" min="1" max="99" value="${settings.timer.shortRestMinutes}" />`}
      </div>
      ${isAuto ? `<div class="setting-row">
        <label class="setting-row__label setting-row__label--emphasis" for="auto-long-rest-ratio">${t('settings.timer.longBreakRatio')}<span class="setting-row__hint">${t('settings.timer.longBreakRatioHint')}</span></label>
        ${ratioStepper('auto-long-rest-ratio', settings.timer.autoLongRestRatio, t('settings.timer.longBreakRatio'))}
      </div>` : ''}
      <div class="setting-row">
        <span class="setting-row__label setting-row__label--emphasis">${t('settings.timer.longBreakLength')}<span class="setting-row__hint">${t('settings.timer.autoRatioHint', { ratio: formatRatio(settings.timer.autoLongRestRatio) })}</span></span>
        ${isAuto ? `<input value="${auto.long}" disabled />` : `<input id="long-rest-minutes" type="number" min="1" max="180" value="${settings.timer.longRestMinutes}" />`}
      </div>
      <div class="setting-row">
        <label class="setting-row__label setting-row__label--emphasis" for="long-rest-interval">${t('settings.timer.longBreakInterval')}<span class="setting-row__hint">${t('settings.timer.longBreakIntervalHint')}</span></label>
        ${integerStepper('long-rest-interval', settings.timer.longRestInterval, t('settings.timer.longBreakInterval'), 1, 12)}
      </div>
    </section>`;
}

function shortcutRow(action: ShortcutAction): string {
  return `
    <div class="shortcut-row ${recordingShortcut === action ? 'is-recording' : ''}" data-shortcut-row="${action}">
      <span class="shortcut-name">${t(shortcutLabels[action])}</span>
      <span class="shortcut-value">${recordingShortcut === action ? escapeHtml(pendingShortcutValue ?? t('settings.shortcuts.pressKeys')) : escapeHtml(settings.shortcuts[action] ?? t('settings.shortcuts.notSet'))}</span>
      <button class="shortcut-button" data-shortcut-edit="${action}">${recordingShortcut === action ? t('common.cancel') : t('settings.shortcuts.edit')}</button>
      <button class="shortcut-button shortcut-button--confirm" data-shortcut-confirm="${action}">${t('common.ok')}</button>
      <button class="shortcut-button shortcut-button--clear" data-shortcut-clear="${action}">${t('settings.shortcuts.clear')}</button>
    </div>`;
}

function shortcutsPanel(): string {
  const globalRows = globalShortcutActions.map(shortcutRow).join('');
  const appRows = appShortcutActions.map(shortcutRow).join('');
  return `
    <h1 class="panel-title">${t('settings.shortcuts.title')}</h1>
    <section class="settings-card">
      <label class="check-row"><input id="enter-swap" type="checkbox" ${settings.enterSwap ? 'checked' : ''} />${t('settings.shortcuts.enterSwap')}</label>
      <label class="check-row"><input id="wheel-ctrl-swap" type="checkbox" ${settings.wheelCtrlSwap ? 'checked' : ''} />${t('settings.shortcuts.wheelCtrlSwap')}</label>
    </section>
    <section class="settings-card">
      <h3>${t('settings.shortcuts.global')}</h3>
      <div class="shortcut-list">${globalRows}</div>
    </section>
    <section class="settings-card">
      <h3>${t('settings.shortcuts.app')}</h3>
      <div class="shortcut-list">${appRows}</div>
    </section>`;
}

function statisticsPanel(dashboard?: StatisticsDashboard): string {
  if (!dashboard) return `<h1 class="panel-title">${t('settings.stats.title')}</h1><p class="empty-message">${t('settings.stats.loading')}</p>`;
  const tile = (label: string, data: StatisticsDashboard['day']) => `
    <div class="summary-column">
      <span class="summary-column__label">${label}</span>
      <div class="summary-tile">
        <strong class="summary-tile__time">${formatDuration(data.focusSeconds)}</strong>
        <span class="summary-tile__count"><img src="./tomato_UI_asset/01_button_number/count.png" alt="" /> ×${data.pomodoroCount}</span>
      </div>
    </div>`;
  const rankings = dashboard.projectRankings.length ? dashboard.projectRankings.map((project) => {
    const expanded = expandedProjectRankings.has(project.id);
    const tasks = expanded ? `<div class="project-ranking__tasks">${project.tasks.map((task) => `
      <div class="project-ranking__task"><span>${escapeHtml(task.taskTitle)}</span><span>${formatDuration(task.focusSeconds)} · ${t('settings.stats.count', { n: task.pomodoroCount })}</span></div>`).join('')}</div>` : '';
    return `<div class="project-ranking ${expanded ? 'is-expanded' : ''}" data-project-ranking="${escapeHtml(project.id)}">
      <button class="project-ranking__summary" data-project-ranking-toggle="${escapeHtml(project.id)}" aria-expanded="${expanded}">
        <span class="project-ranking__chevron" aria-hidden="true"></span>
        <strong>${escapeHtml(project.projectTitle)}</strong>
        <span>${formatDuration(project.focusSeconds)} · ${t('settings.stats.count', { n: project.pomodoroCount })}</span>
      </button>${tasks}
    </div>`;
  }).join('') : `<p class="empty-message">${t('settings.stats.empty')}</p>`;
  return `
    <h1 class="panel-title">${t('settings.stats.title')}</h1>
    <section class="settings-card"><div class="summary-grid">${tile(t('settings.stats.today'), dashboard.day)}${tile(t('settings.stats.week'), dashboard.week)}${tile(t('settings.stats.month'), dashboard.month)}</div></section>
    <section class="settings-card"><h3>${t('settings.stats.ranking')}</h3><div class="project-ranking-list">${rankings}</div></section>`;
}

function systemPanel(): string {
  const themeLabels: Record<keyof AppSettings['taskFlowTheme'], DictKey> = { coral: 'settings.theme.coral', leaf: 'settings.theme.leaf', amber: 'settings.theme.amber', ink: 'settings.theme.ink', sand: 'settings.theme.sand', paper: 'settings.theme.paper', complete: 'settings.theme.complete' };
  const themeKeys = Object.keys(themeLabels) as Array<keyof AppSettings['taskFlowTheme']>;
  const themeFields = themeKeys.map((key) => `<div class="theme-field"><label for="theme-${key}">${t(themeLabels[key])}</label><input id="theme-${key}" data-theme-key="${key}" type="color" value="${settings.taskFlowTheme[key]}" /></div>`).join('');
  const languageSelect = languageOptions.map(([value, label]) => `<option value="${value}" ${settings.language === value ? 'selected' : ''}>${label}</option>`).join('');
  const soundRows = (Object.keys(soundEventLabels) as SoundEvent[]).map((event) => {
    const selected = settings.sound.events[event];
    const customOption = selected?.startsWith('custom:')
      ? `<option value="${escapeHtml(selected)}" selected>${escapeHtml(customSoundLabels.get(selected) ?? t('settings.system.customSound'))}</option>`
      : '';
    return `<div class="sound-event-row">
      <label for="sound-event-${event}">${t(soundEventLabels[event])}</label>
      <select id="sound-event-${event}" data-sound-event="${event}"><option value="" ${selected === null ? 'selected' : ''}>${t('settings.system.mute')}</option>${builtInSoundOptions.map((option) => `<option value="${option.id}" ${selected === option.id ? 'selected' : ''}>${option.label}</option>`).join('')}${customOption}</select>
      <button class="button-secondary" data-import-sound-event="${event}">${t('settings.system.import')}</button>
    </div>`;
  }).join('');
  const panelScalePercent = Number.isFinite(settings.tomatoPanelScale)
    ? Math.min(200, Math.max(50, Math.round(settings.tomatoPanelScale * 100)))
    : 100;
  const panelProgress = ((panelScalePercent - 50) / 150) * 100;
  return `
    <h1 class="panel-title">${t('settings.system.title')}</h1>
    <section class="settings-card system-general-card">
      <div class="setting-row">
        <label class="setting-row__label setting-row__label--emphasis" for="language">${t('settings.system.language')}</label>
        <select id="language">${languageSelect}</select>
      </div>
      <label class="check-row system-general-card__option"><input id="launch-at-login" type="checkbox" ${settings.launchAtLogin ? 'checked' : ''} />${t('settings.system.launchAtLogin')}</label>
      <div class="panel-scale-control system-general-card__option">
        <div class="panel-scale-control__head"><span>${t('settings.system.panelScale')}</span><output id="tomato-panel-scale-value">${panelScalePercent}%</output></div>
        ${assetRange('tomato-panel-scale', panelScalePercent, 50, 200, t('settings.system.panelScale'), true)}
      </div>
    </section>
    <section class="settings-card">
      <h3>${t('settings.system.sounds')}</h3>
      <label class="check-row"><input id="sound-enabled" type="checkbox" ${settings.sound.enabled ? 'checked' : ''} />${t('settings.system.enableSounds')}</label>
      <div class="setting-row" style="margin-top:16px"><label class="setting-row__label" for="sound-volume">${t('settings.system.volume')}<span class="setting-row__hint">${settings.sound.volume}%</span></label>${assetRange('sound-volume', settings.sound.volume, 0, 100, t('settings.system.volume'))}</div>
      <div class="sound-event-list">${soundRows}</div>
    </section>
    <section class="settings-card">
      <h3>${t('settings.system.personalization')}</h3>
      <div class="theme-grid">${themeFields}</div>
      <div class="setting-actions"><button class="button-secondary" data-reset-theme>${t('settings.system.resetColors')}</button><button class="button-primary" data-save-theme>${t('settings.system.saveColors')}</button></div>
    </section>`;
}

function otherPanel(): string {
  return `
    <h1 class="panel-title">${t('settings.other.title')}</h1>
    <section class="settings-card"><div class="danger-list">
      <div class="danger-row"><div><strong>${t('settings.other.export')}</strong><span>${t('settings.other.exportDesc')}</span></div><button class="button-secondary" data-export-user-data>${t('settings.other.exportAction')}</button></div>
      <div class="danger-row"><div><strong>${t('settings.other.import')}</strong><span>${t('settings.other.importDesc')}</span></div><button class="button-secondary" data-import-user-data>${t('settings.other.importAction')}</button></div>
      <div class="danger-row"><div><strong>${t('settings.other.clearStats')}</strong><span>${t('settings.other.clearStatsDesc')}</span></div><button class="button-danger" data-clear-statistics>${t('settings.other.clearStatsAction')}</button></div>
      <div class="danger-row"><div><strong>${t('settings.other.clearArchived')}</strong><span>${t('settings.other.clearArchivedDesc')}</span></div><button class="button-danger" data-clear-archived>${t('settings.other.clearArchivedAction')}</button></div>
      <div class="danger-row"><div><strong>${t('settings.other.reset')}</strong><span>${t('settings.other.resetDesc')}</span></div><button class="button-danger" data-reset-settings>${t('settings.other.resetAction')}</button></div>
    </div></section>
    <section class="settings-card"><div class="danger-list">
      <div class="danger-row"><div><strong>${t('settings.other.support')}</strong><span>${t('settings.other.supportDesc')}</span></div><button class="button-secondary" data-open-support>${t('settings.other.tip')}</button></div>
    </div></section>`;
}

async function renderStatistics(): Promise<void> {
  panelElement.innerHTML = statisticsPanel(statisticsDashboard ?? undefined);
  scheduleSettingsScrollbarSync();
  try {
    const dashboard = await window.settingsAPI.getStatisticsDashboard();
    statisticsDashboard = dashboard;
    if (activePanel === 'statistics') {
      panelElement.innerHTML = statisticsPanel(dashboard);
      scheduleSettingsScrollbarSync();
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : t('settings.stats.loadFailed'), true);
  }
}

function render(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-panel]').forEach((button) => button.classList.toggle('is-active', button.dataset.panel === activePanel));
  if (activePanel === 'statistics') {
    void renderStatistics();
    return;
  }
  panelElement.innerHTML = activePanel === 'timer' ? timerPanel()
    : activePanel === 'shortcuts' ? shortcutsPanel()
      : activePanel === 'system' ? systemPanel() : otherPanel();
  scheduleSettingsScrollbarSync();
}

function updateNumber(id: string, key: keyof AppSettings['timer'], min: number, max: number): void {
  const input = document.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) return;
  const value = Number(input.value);
  if (!Number.isInteger(value) || value < min || value > max) {
    setStatus(t('status.error.integerRange', { min, max }), true);
    return;
  }
  settings.timer[key] = value as never;
  void persist();
}

function updateDecimal(id: string, key: keyof AppSettings['timer'], min: number, max: number): void {
  const input = document.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) return;
  const value = Number(input.value);
  if (!Number.isFinite(value) || value < min || value > max) {
    setStatus(t('status.error.numberRange', { min, max }), true);
    return;
  }
  settings.timer[key] = value as never;
  void persist();
}

function shortcutText(event: KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return null;
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  let key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  if (key === ' ') key = 'Space';
  if (key === 'Comma') key = ',';
  return [...parts, key].join('+');
}

function hasShortcutConflict(action: ShortcutAction, value: string): boolean {
  return (Object.keys(settings.shortcuts) as ShortcutAction[]).some((key) => key !== action && settings.shortcuts[key]?.toLowerCase() === value.toLowerCase());
}

document.querySelector('#settings-nav')!.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-panel]');
  if (!button) return;
  activePanel = button.dataset.panel as Panel;
  recordingShortcut = null;
  pendingShortcutValue = null;
  setStatus();
  render();
});

panelElement.addEventListener('change', (event) => {
  const target = event.target as HTMLInputElement | HTMLSelectElement;
  if (target.id === 'focus-minutes') updateNumber('focus-minutes', 'focusMinutes', 1, 99);
  if (target.id === 'auto-short-rest-ratio') updateDecimal('auto-short-rest-ratio', 'autoShortRestRatio', 0.1, 3);
  if (target.id === 'auto-long-rest-ratio') updateDecimal('auto-long-rest-ratio', 'autoLongRestRatio', 0.1, 3);
  if (target instanceof HTMLInputElement && target.id === 'include-prolongation-in-auto-rest') { settings.timer.includeProlongationInAutoRest = target.checked; void persist(); }
  if (target.id === 'short-rest-minutes') updateNumber('short-rest-minutes', 'shortRestMinutes', 1, 99);
  if (target.id === 'long-rest-minutes') updateNumber('long-rest-minutes', 'longRestMinutes', 1, 180);
  if (target.id === 'long-rest-interval') updateNumber('long-rest-interval', 'longRestInterval', 1, 12);
  if (target instanceof HTMLInputElement && target.id === 'enter-swap') { settings.enterSwap = target.checked; void persist(); }
  if (target instanceof HTMLInputElement && target.id === 'wheel-ctrl-swap') { settings.wheelCtrlSwap = target.checked; void persist(); }
  if (target instanceof HTMLInputElement && target.id === 'tomato-panel-scale') { void persist(); }
  if (target instanceof HTMLInputElement && target.id === 'launch-at-login') { settings.launchAtLogin = target.checked; void persist(); }
  if (target.id === 'language') { settings.language = target.value as AppSettings['language']; void persist(); }
  if (target instanceof HTMLInputElement && target.id === 'sound-enabled') { settings.sound.enabled = target.checked; void persist(); }
  if (target.id === 'sound-volume') { void persist(); }
  if (target instanceof HTMLSelectElement && target.dataset.soundEvent) {
    settings.sound.events[target.dataset.soundEvent as SoundEvent] = (target.value || null) as SoundAsset;
    void persist();
  }
  if (target.dataset.themeKey) settings.taskFlowTheme[target.dataset.themeKey as keyof AppSettings['taskFlowTheme']] = target.value.toUpperCase();
});

panelElement.addEventListener('input', (event) => {
  const target = event.target as HTMLInputElement;
  if (!target.matches('.asset-range__input')) return;
  const min = Number(target.min);
  const max = Number(target.max);
  const value = Number(target.value);
  const progress = Number.isFinite(value) && max > min ? ((value - min) / (max - min)) * 100 : 0;
  const range = target.closest<HTMLElement>('.asset-range');
  range?.style.setProperty('--range-progress', `${progress}%`);
  if (target.id === 'tomato-panel-scale') {
    settings.tomatoPanelScale = value / 100;
    const output = document.querySelector<HTMLOutputElement>('#tomato-panel-scale-value');
    if (output) output.textContent = `${value}%`;
  }
  if (target.id === 'sound-volume') settings.sound.volume = value;
});

panelElement.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const panelScale = Number(target.closest<HTMLElement>('[data-panel-scale]')?.dataset.panelScale);
  if ([50, 100, 200].includes(panelScale)) {
    settings.tomatoPanelScale = panelScale / 100;
    void persist();
    return;
  }
  const rankingToggle = target.closest<HTMLElement>('[data-project-ranking-toggle]');
  if (rankingToggle) {
    const projectId = rankingToggle.dataset.projectRankingToggle!;
    if (expandedProjectRankings.has(projectId)) expandedProjectRankings.delete(projectId);
    else expandedProjectRankings.add(projectId);
    if (statisticsDashboard) {
      panelElement.innerHTML = statisticsPanel(statisticsDashboard);
      scheduleSettingsScrollbarSync();
    }
    return;
  }
  const ratioInputId = target.closest<HTMLElement>('[data-ratio-step]')?.dataset.ratioStep;
  if (ratioInputId === 'auto-short-rest-ratio' || ratioInputId === 'auto-long-rest-ratio') {
    const key = ratioInputId === 'auto-short-rest-ratio' ? 'autoShortRestRatio' : 'autoLongRestRatio';
    const delta = Number(target.closest<HTMLElement>('[data-step-delta]')?.dataset.stepDelta ?? 0);
    settings.timer[key] = Math.max(0.1, Math.min(3, Math.round((settings.timer[key] + delta) * 10) / 10));
    void persist();
    return;
  }
  const integerInputId = target.closest<HTMLElement>('[data-integer-step]')?.dataset.integerStep;
  if (integerInputId === 'long-rest-interval') {
    const delta = Number(target.closest<HTMLElement>('[data-step-delta]')?.dataset.stepDelta ?? 0);
    settings.timer.longRestInterval = Math.max(1, Math.min(12, settings.timer.longRestInterval + delta));
    void persist();
    return;
  }
  const restMode = target.closest<HTMLElement>('[data-rest-mode]')?.dataset.restMode;
  if (restMode === 'auto' || restMode === 'manual') { settings.timer.restMode = restMode; void persist(); return; }
  const importSoundEvent = target.closest<HTMLElement>('[data-import-sound-event]')?.dataset.importSoundEvent as SoundEvent | undefined;
  if (importSoundEvent) {
    void window.settingsAPI.importCustomSound().then((sound) => {
      if (!sound) return;
      customSoundLabels.set(sound.id, sound.label);
      settings.sound.events[importSoundEvent] = sound.id as SoundAsset;
      void persist(t('settings.system.importedAndApplied', { event: t(soundEventLabels[importSoundEvent]) }));
    });
    return;
  }
  const edit = target.closest<HTMLElement>('[data-shortcut-edit]')?.dataset.shortcutEdit as ShortcutAction | undefined;
  if (edit) {
    const cancelling = recordingShortcut === edit;
    recordingShortcut = cancelling ? null : edit;
    pendingShortcutValue = null;
    setStatus(recordingShortcut ? t('settings.shortcuts.pressNew') : '');
    render();
    return;
  }
  const clear = target.closest<HTMLElement>('[data-shortcut-clear]')?.dataset.shortcutClear as ShortcutAction | undefined;
  if (clear) { settings.shortcuts[clear] = null; recordingShortcut = null; pendingShortcutValue = null; void persist(t('settings.shortcuts.cleared')); return; }
  const confirm = target.closest<HTMLElement>('[data-shortcut-confirm]')?.dataset.shortcutConfirm as ShortcutAction | undefined;
  if (confirm) {
    if (recordingShortcut === confirm && pendingShortcutValue) settings.shortcuts[confirm] = pendingShortcutValue;
    recordingShortcut = null;
    pendingShortcutValue = null;
    void persist(t('settings.shortcuts.confirmed'));
    return;
  }
  if (target.closest('[data-reset-theme]')) { settings.taskFlowTheme = { coral: '#F15D3E', leaf: '#79B64D', amber: '#FFC454', ink: '#273560', sand: '#DBCFBD', paper: '#FFFFFF', complete: '#CD7078' }; render(); return; }
  if (target.closest('[data-save-theme]')) { void persist(t('settings.system.colorsSaved')); return; }
  if (target.closest('[data-export-user-data]')) { void window.settingsAPI.exportUserData().then((filePath) => setStatus(filePath ? t('settings.other.exportedTo', { path: filePath }) : t('settings.other.exportCancelled'))); return; }
  if (target.closest('[data-import-user-data]')) { if (window.confirm(t('settings.other.confirmImport'))) void window.settingsAPI.importUserData().then((done) => { setStatus(done ? t('settings.other.imported') : t('settings.other.importCancelled')); if (done) void reloadSettings(); }); return; }
  if (target.closest('[data-open-support]')) {
    if (activeLanguage === 'zh-CN') openSupportModal();
    else void window.settingsAPI.openKofiSupport();
    return;
  }
  if (target.closest('[data-clear-statistics]')) { if (window.confirm(t('settings.other.confirmClearStats'))) void window.settingsAPI.clearStatistics().then(() => { setStatus(t('settings.other.statsCleared')); }); return; }
  if (target.closest('[data-clear-archived]')) { if (window.confirm(t('settings.other.confirmClearArchived'))) void window.settingsAPI.clearArchivedTaskFlow().then(() => setStatus(t('settings.other.archivedCleared'))); return; }
  if (target.closest('[data-reset-settings]')) { if (window.confirm(t('settings.other.confirmReset'))) void window.settingsAPI.reset().then((next) => { settings = next; applyLocale(settings.language); setStatus(t('settings.other.resetDone')); render(); }); }
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    if (!supportModal.hidden) {
      closeSupportModal();
      return;
    }
    window.settingsAPI.close();
    return;
  }
  if (recordingShortcut) {
    event.preventDefault();
    const value = shortcutText(event);
    if (!value) return;
    if (hasShortcutConflict(recordingShortcut, value)) { setStatus(t('settings.shortcuts.conflict'), true); return; }
    pendingShortcutValue = value;
    setStatus(t('settings.shortcuts.recorded'));
    render();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key === ',') { event.preventDefault(); }
});

document.querySelector<HTMLButtonElement>('#settings-close')!.addEventListener('click', () => window.settingsAPI.close());
panelElement.addEventListener('scroll', syncSettingsScrollbar, { passive: true });
scrollbarElement.addEventListener('pointerdown', (event) => {
  const target = event.target as HTMLElement;
  if (target === scrollbarThumbElement) {
    scrollbarDragStart = { clientY: event.clientY, scrollTop: panelElement.scrollTop };
    scrollbarThumbElement.setPointerCapture(event.pointerId);
    event.preventDefault();
    return;
  }
  const track = scrollbarElement.getBoundingClientRect();
  const thumb = scrollbarThumbElement.getBoundingClientRect();
  const maxScrollTop = Math.max(0, panelElement.scrollHeight - panelElement.clientHeight);
  const maxThumbOffset = Math.max(1, track.height - thumb.height);
  const requestedOffset = Math.max(0, Math.min(maxThumbOffset, event.clientY - track.top - thumb.height / 2));
  panelElement.scrollTop = (requestedOffset / maxThumbOffset) * maxScrollTop;
});
scrollbarThumbElement.addEventListener('pointermove', (event) => {
  if (!scrollbarDragStart) return;
  const trackHeight = scrollbarElement.clientHeight;
  const thumbHeight = scrollbarThumbElement.getBoundingClientRect().height;
  const maxThumbOffset = Math.max(1, trackHeight - thumbHeight);
  const maxScrollTop = Math.max(0, panelElement.scrollHeight - panelElement.clientHeight);
  panelElement.scrollTop = Math.max(0, Math.min(maxScrollTop, scrollbarDragStart.scrollTop + (event.clientY - scrollbarDragStart.clientY) * (maxScrollTop / maxThumbOffset)));
});
const stopScrollbarDrag = (): void => { scrollbarDragStart = null; };
scrollbarThumbElement.addEventListener('pointerup', stopScrollbarDrag);
scrollbarThumbElement.addEventListener('pointercancel', stopScrollbarDrag);
new ResizeObserver(scheduleSettingsScrollbarSync).observe(panelElement);
new ResizeObserver(scheduleSettingsScrollbarSync).observe(document.querySelector<HTMLElement>('.settings-content')!);
supportModal.addEventListener('click', (event) => {
  if (event.target === supportModal) closeSupportModal();
});

async function reloadSettings(): Promise<void> {
  try {
    settings = await window.settingsAPI.load();
    applyLocale(settings.language);
    render();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : t('settings.other.loadFailed'), true);
  }
}

window.settingsAPI.onUpdated((next) => {
  const languageChanged = next.language !== activeLanguage;
  settings = next;
  if (languageChanged) applyLocale(settings.language);
  if (!recordingShortcut) render();
});

void window.settingsAPI.getAppVersion()
  .then((version) => { versionElement.textContent = `v${version}`; })
  .catch(() => { versionElement.textContent = ''; });
void reloadSettings();
