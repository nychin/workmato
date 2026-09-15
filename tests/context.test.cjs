const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { archiveExpired, freshness, sortContextNotes, emptyContext } = require('../dist/shared/context.js');
const { ContextRepository } = require('../dist/main/context/repository.js');

test('freshness boundaries, preserved ordering and automatic archive at 90 minutes', () => {
  const note = { id: 'a', text: 'draft', createdAt: 0, freshAt: 0, preserved: false, archivedAt: null };
  assert.equal(freshness(note, 30 * 60000 - 1), 0);
  assert.equal(freshness(note, 30 * 60000), 1);
  assert.equal(freshness(note, 60 * 60000), 2);
  const data = emptyContext();
  data.notes = [note, { ...note, id: 'b', preserved: true }, { ...note, id: 'c', freshAt: 1 }];
  assert.deepEqual(sortContextNotes(data.notes).map((item) => item.id), ['b', 'c', 'a']);
  assert.equal(archiveExpired(data, 90 * 60000 - 1), false);
  assert.equal(archiveExpired(data, 90 * 60000), true);
  assert.equal(note.archivedAt, 90 * 60000);
  assert.equal(data.notes[1].archivedAt, null);
  assert.equal(data.notes[2].archivedAt, null);
  assert.equal(archiveExpired(data, 90 * 60000), false);
});

test('concurrent panel and capture commands persist without lost updates; invalid commands cannot poison the queue', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tomato-context-'));
  try {
    const repository = new ContextRepository(directory);
    await Promise.all([
      repository.change({ type: 'add', text: 'panel' }),
      repository.change({ type: 'add', text: 'capture' }),
      repository.change({ type: 'scratch', text: 'scratch' }),
    ]);
    let data = await repository.load();
    assert.deepEqual(data.notes.map((note) => note.text), ['panel', 'capture']);
    assert.equal(data.scratch, 'scratch');
    const id = data.notes[0].id;
    await repository.change({ type: 'preserve', id });
    data = await repository.change({ type: 'edit', id, text: 'edited' });
    assert.equal(data.notes[0].preserved, true);
    assert.equal(data.notes[0].text, 'edited');
    await assert.rejects(repository.change({ type: 'opacity', value: NaN }));
    await assert.rejects(repository.change({ type: 'edit', id }));
    await assert.rejects(repository.change({ type: 'delete' }));
    data = await repository.change({ type: 'opacity', value: 0.4 });
    await repository.flush();
    assert.deepEqual(await new ContextRepository(directory).load(), data);
    data = await repository.change({ type: 'delete', id });
    assert.equal(data.notes.length, 1);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('restart archives expired records, restores them and leaves corrupt files intact', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tomato-context-'));
  try {
    const file = path.join(directory, 'context.json');
    const data = emptyContext();
    data.notes.push({ id: 'old', text: 'keep me', createdAt: 0, freshAt: 0, preserved: false, archivedAt: null });
    await fs.writeFile(file, JSON.stringify(data));
    const repository = new ContextRepository(directory);
    assert.equal((await repository.load()).notes[0].archivedAt, 90 * 60000);
    const restored = await repository.change({ type: 'restore', id: 'old' });
    assert.equal(restored.notes[0].archivedAt, null);
    assert.ok(restored.notes[0].freshAt > 0);
    await fs.writeFile(file, '{broken');
    await assert.rejects(new ContextRepository(directory).load());
    assert.equal(await fs.readFile(file, 'utf8'), '{broken');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
