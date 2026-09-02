/**
 * 从 scripts/guide-source/guide.data.json 生成三语内置引导任务 seed。
 *
 * guide.data.json 是三语唯一数据源：结构（id/坐标/连线/分组）+ 每卡 title/markdown 的
 * zh/en/ja 文本。运行后输出：
 *   src/main/taskflow/seed/seed.zh-CN.ts / seed.en-US.ts / seed.ja-JP.ts
 *
 * 更新流程：
 *   1. 开发版导出最新“说明” → scripts/guide-source/guide.zh.json（结构+中文）
 *   2. node scripts/guide-source/import-zh.cjs   （回填 zh 与结构，保留 en/ja 翻译）
 *   3. 检查/修订 en/ja 翻译（新增卡片需补充翻译）
 *   4. npm run sync:guide
 */
const fs = require('node:fs');
const path = require('node:path');

const sourcePath = path.join(__dirname, 'guide-source', 'guide.data.json');
const seedDir = path.resolve(__dirname, '../src/main/taskflow/seed');

const data = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
if (!data.project || !Array.isArray(data.cards)) {
  throw new Error('guide.data.json 结构不正确：缺少 project 或 cards。');
}

function buildSeed(locale) {
  const projectId = data.project.id ?? 'project_guide';
  const timestamp = new Date().toISOString();
  const project = {
    id: projectId,
    title: data.project.title[locale],
    archived: false,
    createdAt: data.project.meta?.createdAt ?? timestamp,
    updatedAt: data.project.meta?.updatedAt ?? timestamp,
    pinnedAt: timestamp,
    sortOrder: data.project.meta?.sortOrder ?? 100,
  };
  if (data.project.meta?.viewport) project.viewport = data.project.meta.viewport;
  project.archivedAt = null;
  project.sidebarGroupId = null;

  const groupIds = new Set(data.groups.map((group) => group.id));
  const cards = data.cards.map((card) => {
    const out = {
      id: card.id,
      projectId,
      title: card.title[locale] ?? card.title.zh,
      markdown: card.markdown[locale] ?? card.markdown.zh ?? '',
      x: card.x,
      y: card.y,
      collapsed: Boolean(card.collapsed),
      completed: Boolean(card.completed),
      createdAt: card.createdAt ?? timestamp,
      updatedAt: card.updatedAt ?? timestamp,
    };
    if (card.parentId) out.parentId = card.parentId;
    if (card.cardType === 'task' || card.cardType === 'note') out.cardType = card.cardType;
    if (card.noteMode === 'text' || card.noteMode === 'draw') out.noteMode = card.noteMode;
    if (card.drawing) out.drawing = card.drawing;
    if (card.noteCollapsed !== undefined) out.noteCollapsed = Boolean(card.noteCollapsed);
    if (card.noteWidth !== undefined) out.noteWidth = card.noteWidth;
    if (card.noteHeight !== undefined) out.noteHeight = card.noteHeight;
    if (card.groupId && groupIds.has(card.groupId)) out.groupId = card.groupId;
    return out;
  });

  const cardIds = new Set(cards.map((card) => card.id));
  const edges = data.edges
    .filter((edge) => cardIds.has(edge.sourceId) && cardIds.has(edge.targetId))
    .map((edge) => ({
      id: edge.id,
      projectId,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      createdAt: edge.createdAt ?? timestamp,
    }));

  return {
    version: 1,
    projects: [project],
    projectGroups: [],
    cards,
    edges,
    groups: data.groups.map((group) => ({ id: group.id, color: group.color })),
    pinnedCardId: null,
    activeProjectId: projectId,
  };
}

const locales = [
  ['zh-CN', 'zh'],
  ['en-US', 'en'],
  ['ja-JP', 'ja'],
];

for (const [localeName, localeKey] of locales) {
  const seed = buildSeed(localeKey);
  const constName = `GUIDE_SEED_${localeName.replace('-', '_').toUpperCase()}`;
  const output = `import type { TaskFlowData } from '../../../shared/taskflow';\n\n`
    + `/** Bundled guide project (${localeName}), generated from scripts/guide-source/guide.data.json. */\n`
    + `export const ${constName}: TaskFlowData = ${JSON.stringify(seed, null, 2)};\n`;
  const outputPath = path.join(seedDir, `seed.${localeName}.ts`);
  fs.writeFileSync(outputPath, output, 'utf8');
  console.log(`Synced ${localeName}: ${seed.cards.length} cards, ${seed.edges.length} edges, ${seed.groups.length} groups.`);
}
