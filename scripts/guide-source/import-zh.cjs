/**
 * 把开发版导出的最新“说明”回填到 guide.data.json。
 *
 * 用法：node scripts/guide-source/import-zh.cjs <dev-guide.json>
 *   dev-guide.json 由 scripts/guide-source/export-dev-guide.cjs 生成
 *   （或手工从导出的用户数据中提取“说明”项目，结构同 guide.zh.json）。
 *
 * 行为：按卡片 id 匹配并同步增删、结构与原始中文。未修改的字段保留翻译；
 *       id 重建时按完全相同的中文内容复用翻译，新增或修改的文本需人工补翻。
 */
const fs = require('node:fs');
const path = require('node:path');

const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/guide-source/import-zh.cjs <dev-guide.json>');
const dataPath = path.join(__dirname, 'guide.data.json');

const incoming = JSON.parse(fs.readFileSync(path.resolve(source), 'utf8'));
const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
if (!incoming.cards || !Array.isArray(incoming.cards)) throw new Error('输入文件缺少 cards。');

const clean = (text) => text ?? '';

const translationsByText = new Map(data.cards.map((card) => [JSON.stringify([card.title.zh, card.markdown.zh]), card]));
const cardIds = new Set(incoming.cards.map((card) => card.id));
for (const edge of incoming.edges ?? []) {
  if (!cardIds.has(edge.sourceId) || !cardIds.has(edge.targetId)) throw new Error(`连线 ${edge.id} 缺少有效的 sourceId/targetId。`);
}
// 同步删除的卡片，避免旧说明在每次生成时重新出现。
const incomingIds = new Set(incoming.cards.map((card) => card.id));
data.cards = data.cards.filter((card) => incomingIds.has(card.id));

const existing = new Map(data.cards.map((card) => [card.id, card]));
let added = 0;
let updated = 0;

for (const incomingCard of incoming.cards) {
  const current = existing.get(incomingCard.id);
  if (current) {
    // 更新结构
    current.x = incomingCard.x;
    current.y = incomingCard.y;
    current.collapsed = Boolean(incomingCard.collapsed);
    current.completed = Boolean(incomingCard.completed);
    for (const key of ['parentId', 'cardType', 'noteMode', 'drawing', 'noteCollapsed', 'noteWidth', 'noteHeight', 'groupId']) {
      if (incomingCard[key] !== undefined && incomingCard[key] !== null) current[key] = incomingCard[key];
      else delete current[key];
    }
    if (clean(incomingCard.title) !== current.title.zh) {
      current.title = { zh: clean(incomingCard.title) };
      updated++;
    }
    if (clean(incomingCard.markdown) !== current.markdown.zh) current.markdown = { zh: clean(incomingCard.markdown) };
  } else {
    const translated = translationsByText.get(JSON.stringify([clean(incomingCard.title), clean(incomingCard.markdown)]));
    const card = {
      id: incomingCard.id,
      x: incomingCard.x,
      y: incomingCard.y,
      collapsed: Boolean(incomingCard.collapsed),
      completed: Boolean(incomingCard.completed),
      title: translated ? { ...translated.title } : { zh: clean(incomingCard.title) },
      markdown: translated ? { ...translated.markdown } : { zh: clean(incomingCard.markdown) },
    };
    for (const key of ['parentId', 'cardType', 'noteMode', 'drawing', 'noteCollapsed', 'noteWidth', 'noteHeight', 'groupId']) {
      if (incomingCard[key] !== undefined && incomingCard[key] !== null) card[key] = incomingCard[key];
    }
    data.cards.push(card);
    existing.set(card.id, card);
    added++;
  }
}

// 项目标题与 meta
data.project.title.zh = '说明';
if (incoming.projects?.[0]) {
  const p = incoming.projects[0];
  data.project.meta = {
    createdAt: p.createdAt ?? data.project.meta?.createdAt,
    updatedAt: p.updatedAt ?? data.project.meta?.updatedAt,
    sortOrder: p.sortOrder ?? data.project.meta?.sortOrder,
    viewport: p.viewport ?? data.project.meta?.viewport,
  };
}

// 连线 / 分组
data.edges = (incoming.edges ?? []).map((edge) => ({
  id: edge.id, sourceId: edge.sourceId, targetId: edge.targetId, createdAt: edge.createdAt,
}));
data.groups = (incoming.groups ?? []).map((group) => ({ id: group.id, color: group.color }));

fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
console.log(`Imported zh guide: ${added} added, ${updated} title-changed, ${data.cards.length} cards total.`);
console.log('请检查新增卡片的 en/ja 翻译，然后运行 npm run sync:guide。');
