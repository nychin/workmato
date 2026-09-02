const assert = require('node:assert/strict');
const test = require('node:test');

const { makeRoomForInsertedCard } = require('../dist/shared/taskflow-layout.js');

function card(id, x, parentId) {
  return {
    id, projectId: 'project', title: id, markdown: '', x, y: 0,
    collapsed: false, completed: false, createdAt: '', updatedAt: '', parentId,
  };
}

function edge(id, sourceId, targetId) {
  return { id, projectId: 'project', sourceId, targetId, createdAt: '' };
}

test('inserting into a short edge pushes the target branch to standard spacing', () => {
  const source = card('source', 0);
  const target = card('target', 330);
  const child = card('child', 690);
  const note = card('note', 330, 'target');
  const inserted = card('inserted', 120);
  const replaced = edge('before', 'source', 'target');

  makeRoomForInsertedCard(
    [source, target, child, note],
    [replaced, edge('after', 'target', 'child')],
    inserted,
    replaced,
  );

  assert.equal(inserted.x, 360);
  assert.equal(target.x, 720);
  assert.equal(child.x, 1080);
  assert.equal(note.x, 720);
  assert.equal(source.x, 0);
});

test('inserting into an edge with enough room keeps the existing layout', () => {
  const source = card('source', 0);
  const target = card('target', 1080);
  const inserted = card('inserted', 500);
  const replaced = edge('before', 'source', 'target');

  makeRoomForInsertedCard([source, target], [replaced], inserted, replaced);

  assert.equal(inserted.x, 500);
  assert.equal(target.x, 1080);
});
