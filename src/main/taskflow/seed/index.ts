import type { AppLanguage } from '../../../shared/settings';
import type { TaskFlowData } from '../../../shared/taskflow';
import { GUIDE_SEED_ZH_CN } from './seed.zh-CN';
import { GUIDE_SEED_EN_US } from './seed.en-US';
import { GUIDE_SEED_JA_JP } from './seed.ja-JP';

const seeds: Record<AppLanguage, TaskFlowData> = {
  'zh-CN': GUIDE_SEED_ZH_CN,
  'en-US': GUIDE_SEED_EN_US,
  'ja-JP': GUIDE_SEED_JA_JP,
};

/** 按当前界面语言返回内置“说明”引导任务。 */
export function getBundledGuideSeed(language: AppLanguage): TaskFlowData {
  return seeds[language] ?? GUIDE_SEED_ZH_CN;
}
