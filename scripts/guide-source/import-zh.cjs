/**
 * 把开发版导出的最新“说明”回填到 guide.data.json。
 *
 * 用法：node scripts/guide-source/import-zh.cjs <dev-guide.json>
 *   dev-guide.json 由 scripts/guide-source/export-dev-guide.cjs 生成
 *   （或手工从导出的用户数据中提取“说明”项目，结构同 guide.zh.json）。
 *
 * 行为：按卡片 id 匹配，更新结构（x/y/连线/分组）与 zh 文本；已存在的卡保留 en/ja 翻译；
 *       新增卡仅写入 zh（en/ja 由 sync 脚本回退到 zh，需人工补翻）。
 */
const fs = require('node:fs');
const path = require('node:path');

const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/guide-source/import-zh.cjs <dev-guide.json>');
const dataPath = path.join(__dirname, 'guide.data.json');

const incoming = JSON.parse(fs.readFileSync(path.resolve(source), 'utf8'));
const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
if (!incoming.cards || !Array.isArray(incoming.cards)) throw new Error('输入文件缺少 cards。');

const clean = (text) => (text ?? '')
  .replace(/sihft/g, 'Shift')
  .replace(/tap键/g, 'Tab 键')
  .replace(/补充(?!卡片)/g, '附属便签');

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
      current.title.zh = clean(incomingCard.title);
      updated++;
    }
    current.markdown.zh = clean(incomingCard.markdown ?? '');
  } else {
    const card = {
      id: incomingCard.id,
      x: incomingCard.x,
      y: incomingCard.y,
      collapsed: Boolean(incomingCard.collapsed),
      completed: Boolean(incomingCard.completed),
      title: { zh: clean(incomingCard.title) },
      markdown: { zh: clean(incomingCard.markdown ?? '') },
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
