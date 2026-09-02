/**
 * 零依赖 i18n 核心。shared 目录同时被主进程（tsc）与渲染进程（vite）引用。
 *
 * 用法：
 *   import { setLocale, t } from '../shared/i18n';
 *   setLocale(settings.language);
 *   t('status.error.integerRange', { min: 1, max: 99 });
 */
import type { AppLanguage } from '../settings';
import { zhCN, type DictKey } from './zh-CN';
import { enUS } from './en-US';
import { jaJP } from './ja-JP';

export type { DictKey };

const LANGUAGES: readonly AppLanguage[] = ['zh-CN', 'en-US', 'ja-JP'];

const dictionaries: Record<AppLanguage, Record<DictKey, string>> = {
  'zh-CN': zhCN,
  'en-US': enUS,
  'ja-JP': jaJP,
};

let current: Record<DictKey, string> = zhCN;
let currentLanguage: AppLanguage = 'zh-CN';

export function isAppLanguage(value: unknown): value is AppLanguage {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

export function setLocale(language: AppLanguage): void {
  currentLanguage = isAppLanguage(language) ? language : 'zh-CN';
  current = dictionaries[currentLanguage];
}

export function getLocale(): AppLanguage {
  return currentLanguage;
}

/** Missing keys fall back to Chinese, then to the key itself (never undefined). */
export function t(key: DictKey, params?: Record<string, string | number>): string {
  let text = current[key] ?? zhCN[key] ?? key;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}

/** Detect the app language from an Electron/system locale string (e.g. "zh-CN", "ja", "en-US"). */
export function detectAppLanguage(systemLocale: string | undefined): AppLanguage {
  const normalized = (systemLocale ?? '').toLowerCase();
  if (normalized.startsWith('zh')) return 'zh-CN';
  if (normalized.startsWith('ja')) return 'ja-JP';
  return 'en-US';
}
