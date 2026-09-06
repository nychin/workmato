import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  AppLanguage,
  AppSettings,
  APP_LANGUAGES,
  BuiltInSoundAsset,
  createDefaultSettings,
  DEFAULT_SETTINGS,
  RestMode,
  ShortcutAction,
  SoundAsset,
  SoundEvent,
  TaskFlowTheme,
} from '../../shared/settings';
import { detectAppLanguage } from '../../shared/i18n';

export interface SettingsRepositoryOptions {
  dataDirectory?: string;
}

const SHORTCUT_ACTIONS: ShortcutAction[] = [
  'toggleMainWindow', 'toggleTimer', 'toggleTaskFlow', 'taskflowNewProject', 'taskflowAddCard',
  'taskflowUndo', 'taskflowRedo', 'openSettings', 'taskflowToggleSidebar',
  'taskflowAddNote', 'taskflowPlaceTask', 'taskflowDetachCard', 'taskflowGroup', 'taskflowToggleNPanel',
];
const SOUND_EVENTS: SoundEvent[] = ['focusStart', 'prolongation', 'restStart', 'restEnd', 'taskComplete'];
const SOUND_ASSETS = new Set<BuiltInSoundAsset>([
  'focus_start', 'prolongation', 'rest_start', 'rest_end', 'happy', 'rage',
  'focus_start_02', 'focus_start_03', 'prolongation_02',
]);
const THEME_KEYS: Array<keyof TaskFlowTheme> = ['coral', 'leaf', 'amber', 'ink', 'sand', 'paper', 'complete'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integerInRange(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

function numberInRange(value: unknown, fallback: number, min: number, max: number): number {
  const selected = typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fallback;
  return Math.round(selected * 10) / 10;
}

function panelScaleInRange(value: unknown, fallback: number): number {
  const selected = typeof value === 'number' && Number.isFinite(value) && value >= 0.5 && value <= 2
    ? value
    : fallback;
  return Math.round(selected * 20) / 20;
}

function validColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toUpperCase() : fallback;
}

function isSoundAsset(value: unknown): value is SoundAsset {
  return value === null || (typeof value === 'string' && (SOUND_ASSETS.has(value as BuiltInSoundAsset)
    || /^custom:[a-zA-Z0-9_-]+\.(mp3|wav|ogg|m4a)$/i.test(value)));
}

function normalizeLanguage(value: unknown): AppLanguage {
  return typeof value === 'string' && (APP_LANGUAGES as readonly string[]).includes(value)
    ? value as AppLanguage
    : 'zh-CN';
}

/** Normalizes untrusted imported JSON without letting invalid values reach runtime services. */
export function normalizeSettings(candidate: unknown): AppSettings {
  const defaults = createDefaultSettings();
  if (!isRecord(candidate)) return defaults;
  const timer = isRecord(candidate.timer) ? candidate.timer : {};
  const sound = isRecord(candidate.sound) ? candidate.sound : {};
  const shortcutValues = isRecord(candidate.shortcuts) ? candidate.shortcuts : {};
  const soundValues = isRecord(sound.events) ? sound.events : {};
  const themeValues = isRecord(candidate.taskFlowTheme) ? candidate.taskFlowTheme : {};
  const restMode: RestMode = timer.restMode === 'manual' ? 'manual' : 'auto';
  const rawLegacyShortRatio = typeof timer.autoShortRestPercent === 'number'
    ? timer.autoShortRestPercent / 100
    : undefined;
  const legacyShortRatio = numberInRange(
    rawLegacyShortRatio,
    defaults.timer.autoShortRestRatio,
    0.1,
    3,
  );
  const legacyLongRatio = numberInRange(
    typeof timer.autoLongRestMultiplier === 'number' && rawLegacyShortRatio !== undefined
      ? rawLegacyShortRatio * timer.autoLongRestMultiplier
      : undefined,
    defaults.timer.autoLongRestRatio,
    0.1,
    3,
  );

  const shortcuts = Object.fromEntries(SHORTCUT_ACTIONS.map((action) => {
    const value = shortcutValues[action];
    return [action, typeof value === 'string' && value.length <= 80 ? value : value === null ? null : defaults.shortcuts[action]];
  })) as AppSettings['shortcuts'];
  const events = Object.fromEntries(SOUND_EVENTS.map((event) => {
    const value = soundValues[event];
    return [event, isSoundAsset(value) ? value : defaults.sound.events[event]];
  })) as AppSettings['sound']['events'];
  const taskFlowTheme: TaskFlowTheme = {
    coral: validColor(themeValues.coral, defaults.taskFlowTheme.coral),
    leaf: validColor(themeValues.leaf, defaults.taskFlowTheme.leaf),
    amber: validColor(themeValues.amber, defaults.taskFlowTheme.amber),
    ink: validColor(themeValues.ink, defaults.taskFlowTheme.ink),
    sand: validColor(themeValues.sand, defaults.taskFlowTheme.sand),
    paper: validColor(themeValues.paper, defaults.taskFlowTheme.paper),
    complete: validColor(themeValues.complete, defaults.taskFlowTheme.complete),
  };

  return {
    version: 1,
    language: normalizeLanguage(candidate.language),
    timer: {
      focusMinutes: integerInRange(timer.focusMinutes, defaults.timer.focusMinutes, 1, 99),
      restMode,
      autoShortRestRatio: numberInRange(timer.autoShortRestRatio, legacyShortRatio, 0.1, 3),
      autoLongRestRatio: numberInRange(timer.autoLongRestRatio, legacyLongRatio, 0.1, 3),
      includeProlongationInAutoRest: timer.includeProlongationInAutoRest === true,
      shortRestMinutes: integerInRange(timer.shortRestMinutes, defaults.timer.shortRestMinutes, 1, 99),
      longRestMinutes: integerInRange(timer.longRestMinutes, defaults.timer.longRestMinutes, 1, 180),
      longRestInterval: integerInRange(timer.longRestInterval, defaults.timer.longRestInterval, 1, 12),
    },
    shortcuts,
    enterSwap: candidate.enterSwap === true,
    // 旧配置没有该字段时保留迁移兼容性；新用户和“重置所有设置”使用默认值启用。
    wheelCtrlSwap: candidate.wheelCtrlSwap === true,
    // 兼容旧版“双倍尺寸”开关：勾选迁移为 200%，其余迁移为 100%。
    tomatoPanelScale: panelScaleInRange(candidate.tomatoPanelScale, candidate.tomatoPanelDoubleSize === true ? 2 : 1),
    launchAtLogin: candidate.launchAtLogin === true,
    sound: {
      enabled: sound.enabled !== false,
      volume: integerInRange(sound.volume, defaults.sound.volume, 0, 100),
      events,
    },
    taskFlowTheme,
  };
}

export class SettingsRepository {
  private readonly dataDirectory?: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: SettingsRepositoryOptions = {}) {
    this.dataDirectory = options.dataDirectory;
  }

  private get storageDirectory(): string {
    return this.dataDirectory ?? app.getPath('userData');
  }

  private get settingsPath(): string {
    return path.join(this.storageDirectory, 'settings.json');
  }

  async load(): Promise<AppSettings> {
    try {
      const raw = await fs.readFile(this.settingsPath, 'utf8');
      return normalizeSettings(JSON.parse(raw) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        await this.backupInvalidFile();
      }
      // 首次运行（settings.json 不存在）时按系统 UI 语言选择默认语言；
      // 配置损坏重建时保持同样的检测逻辑，确保新环境拿到合适的语言。
      const defaults = createDefaultSettings();
      defaults.language = detectAppLanguage(app.getLocale());
      await this.save(defaults);
      return defaults;
    }
  }

  async save(candidate: unknown): Promise<AppSettings> {
    const settings = normalizeSettings(candidate);
    const write = this.writeQueue.then(() => this.writeAtomic(this.settingsPath, JSON.stringify(settings, null, 2)));
    this.writeQueue = write.catch(() => undefined);
    await write;
    return settings;
  }

  async reset(): Promise<AppSettings> {
    // 与首启一致：重置后按系统语言重新检测默认语言。
    const defaults = createDefaultSettings();
    defaults.language = detectAppLanguage(app.getLocale());
    return this.save(defaults);
  }

  async exportRaw(): Promise<AppSettings> {
    return this.load();
  }

  private async backupInvalidFile(): Promise<void> {
    try {
      const invalidPath = `${this.settingsPath}.invalid-${Date.now()}.bak`;
      await fs.copyFile(this.settingsPath, invalidPath);
    } catch {
      // A missing or unreadable invalid file should not prevent the application from recovering defaults.
    }
  }

  private async writeAtomic(filePath: string, contents: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.tmp`;
    await fs.writeFile(temporaryPath, contents, 'utf8');
    await fs.rename(temporaryPath, filePath);
  }
}
