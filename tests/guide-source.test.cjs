const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('guide import preserves exact wording and structure, removes deleted cards and invalidates changed translations', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-import-'));
  try {
    const script = path.join(directory, 'import.cjs');
    fs.copyFileSync(path.join(__dirname, '../scripts/guide-source/import-zh.cjs'), script);
    const translated = { title: { zh: '说明', en: 'Guide', ja: '使い方' }, markdown: { zh: '旧文本', en: 'Old', ja: '旧' } };
    fs.writeFileSync(path.join(directory, 'guide.data.json'), JSON.stringify({ project: { title: { zh: '说明' } }, cards: [
      { id: 'same', ...translated }, { id: 'old-id', ...translated }, { id: 'deleted', ...translated },
    ] }));
    const incoming = { cards: [
      { id: 'same', title: '说明', markdown: '按住ctrl+右键来切断连接', x: 1, y: 2, cardType: 'note', parentId: 'new-id', noteMode: 'draw', drawing: { strokes: [] }, noteCollapsed: false, noteWidth: 240, noteHeight: 120, groupId: 'group' },
      { id: 'new-id', title: '说明', markdown: '旧文本', x: 3, y: 4 },
    ], edges: [{ id: 'edge', sourceId: 'same', targetId: 'new-id' }], groups: [{ id: 'group', color: '#fff' }] };
    const source = path.join(directory, 'incoming.json');
    fs.writeFileSync(source, JSON.stringify(incoming));
    execFileSync(process.execPath, [script, source]);
    const result = JSON.parse(fs.readFileSync(path.join(directory, 'guide.data.json'), 'utf8'));
    assert.equal(result.cards.length, 2);
    const note = result.cards.find((c) => c.id === 'same');
    assert.deepEqual(note.markdown, { zh: incoming.cards[0].markdown });
    assert.equal(note.title.en, 'Guide');
    for (const key of ['parentId', 'cardType', 'drawing', 'noteMode', 'noteCollapsed', 'noteWidth', 'noteHeight', 'groupId']) assert.deepEqual(note[key], incoming.cards[0][key]);
    assert.equal(result.cards.find((c) => c.id === 'new-id').markdown.en, 'Old');
    assert.deepEqual(result.edges, incoming.edges);
    assert.deepEqual(result.groups, incoming.groups);
    incoming.edges[0] = { id: 'bad', source_id: 'same', target_id: 'new-id' };
    fs.writeFileSync(source, JSON.stringify(incoming));
    assert.throws(() => execFileSync(process.execPath, [script, source], { stdio: 'pipe' }));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('bundled guide source matches latest Chinese export and all cards have translations', () => {
  const source = require('../scripts/guide-source/guide.data.json');
  const exported = require('../scripts/guide-source/guide.zh.json');
  assert.equal(source.cards.length, exported.cards.length);
  assert.equal(source.edges.length, exported.edges.length);
  for (const card of source.cards) {
    const original = exported.cards.find((c) => c.id === card.id);
    assert.equal(card.title.zh, original.title);
    assert.equal(card.markdown.zh, original.markdown ?? '');
    for (const lang of ['en', 'ja']) {
      assert.equal(typeof card.title[lang], 'string');
      assert.equal(typeof card.markdown[lang], 'string');
    }
  }
  const ids = new Set(source.cards.map((c) => c.id));
  for (const edge of source.edges) assert.ok(ids.has(edge.sourceId) && ids.has(edge.targetId));
});
