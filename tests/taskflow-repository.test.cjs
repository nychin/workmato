const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const initSqlJs = require('sql.js/dist/sql-asm.js');

const { TaskFlowRepository } = require('../dist/main/taskflow/repository.js');

function fixture() {
  return {
    version: 1,
    projects: [
      {
        id: 'project-active',
        title: 'Active project',
        archived: false,
        createdAt: '2026-08-12T00:00:00.000Z',
        updatedAt: '2026-08-12T01:00:00.000Z',
        pinnedAt: '2026-08-12T00:30:00.000Z',
        sortOrder: 40,
        viewport: { x: -315.5, y: 86.25, zoom: 1.35 },
        sidebarGroupId: 'sidebar-group-work',
      },
      {
        id: 'project-archive',
        title: 'Archived project',
        archived: true,
        archivedAt: '2026-08-11T00:00:00.000Z',
        createdAt: '2026-08-10T00:00:00.000Z',
        updatedAt: '2026-08-11T00:00:00.000Z',
        sortOrder: 10,
      },
    ],
    projectGroups: [
      { id: 'sidebar-group-work', title: 'Work', collapsed: true, sortOrder: 20 },
    ],
    cards: [
      {
        id: 'card-task',
        projectId: 'project-active',
        title: 'Task card',
        markdown: '- [ ] first',
        x: 124.5,
        y: 352.75,
        collapsed: false,
        completed: false,
        createdAt: '2026-08-12T00:00:00.000Z',
        updatedAt: '2026-08-12T01:00:00.000Z',
        groupId: 'group-red',
      },
      {
        id: 'card-draw-note',
        projectId: 'project-active',
        parentId: 'card-task',
        cardType: 'note',
        noteMode: 'draw',
        drawing: '[[{"x":0.1,"y":0.2},{"x":0.3,"y":0.4}]]',
        noteCollapsed: true,
        noteWidth: 640,
        title: 'Attached drawing',
        markdown: '',
        x: 124.5,
        y: 562.75,
        collapsed: false,
        completed: false,
        createdAt: '2026-08-12T00:00:00.000Z',
        updatedAt: '2026-08-12T01:00:00.000Z',
      },
      {
        id: 'card-standalone-note',
        projectId: 'project-archive',
        cardType: 'note',
        noteMode: 'text',
        noteWidth: 420,
        title: 'Archived note',
        markdown: 'This stays with the archived project.',
        x: 40,
        y: 80,
        collapsed: false,
        completed: true,
        createdAt: '2026-08-10T00:00:00.000Z',
        updatedAt: '2026-08-11T00:00:00.000Z',
      },
    ],
    edges: [
      {
        id: 'edge-task-note',
        projectId: 'project-active',
        sourceId: 'card-task',
        targetId: 'card-draw-note',
        createdAt: '2026-08-12T01:00:00.000Z',
      },
    ],
    groups: [{ id: 'group-red', color: '#FF0000' }],
    pinnedCardId: 'card-task',
    activeProjectId: 'project-active',
  };
}

test('migrates legacy JSON once and preserves task-flow fields', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'taskflow-sqlite-test-'));
  const legacyPath = path.join(directory, 'taskflow-data.json');
  const expected = fixture();

  try {
    await fs.writeFile(legacyPath, JSON.stringify(expected), 'utf8');

    const repository = new TaskFlowRepository({ dataDirectory: directory });
    assert.deepEqual(await repository.load(), expected);

    const databasePath = path.join(directory, 'taskflow-data.sqlite');
    const databaseHeader = await fs.readFile(databasePath);
    assert.equal(databaseHeader.subarray(0, 16).toString('utf8'), 'SQLite format 3\u0000');
    assert.deepEqual(JSON.parse(await fs.readFile(`${legacyPath}.pre-sqlite-backup`, 'utf8')), expected);
    assert.deepEqual(JSON.parse(await fs.readFile(legacyPath, 'utf8')), expected);

    expected.cards[0].title = 'Saved after migration';
    expected.projects[0].sortOrder = 55;
    await repository.save(expected);

    const restartedRepository = new TaskFlowRepository({ dataDirectory: directory });
    assert.deepEqual(await restartedRepository.load(), expected);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('replaces the bundled guide on version upgrade and language switch', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'taskflow-guide-test-'));

  try {
    const repository = new TaskFlowRepository({ dataDirectory: directory });
    const fresh = await repository.load('1.1.0');
    assert.equal(fresh.projects.filter((project) => project.title === '说明').length, 1);

    const sameVersion = await new TaskFlowRepository({ dataDirectory: directory }).load('1.1.0');
    assert.equal(sameVersion.projects.filter((project) => project.title === '说明').length, 1);

    const previousGuideIds = new Set(
      sameVersion.projects.filter((project) => project.title === '说明').map((item) => item.id),
    );

    // 版本升级：替换而非追加，旧引导被移除
    const upgraded = await new TaskFlowRepository({ dataDirectory: directory }).load('1.2.2');
    assert.equal(upgraded.projects.filter((project) => project.title === '说明').length, 1);
    assert.equal(upgraded.projects.filter((project) => previousGuideIds.has(project.id)).length, 0);
    assert.ok(upgraded.activeProjectId && upgraded.projects.some((project) => project.id === upgraded.activeProjectId));

    // 切换语言：替换为对应语言版本
    const switchedEn = await new TaskFlowRepository({ dataDirectory: directory }).load('1.2.2', 'en-US');
    assert.equal(switchedEn.projects.filter((project) => project.title === 'Guide').length, 1);
    assert.equal(switchedEn.projects.filter((project) => project.title === '说明').length, 0);
    const enGuideCards = switchedEn.cards.filter((card) => card.projectId === switchedEn.projects.find((p) => p.title === 'Guide')?.id);
    assert.ok(enGuideCards.some((card) => card.title === 'Adding Cards'));

    const switchedJa = await new TaskFlowRepository({ dataDirectory: directory }).load('1.2.2', 'ja-JP');
    assert.equal(switchedJa.projects.filter((project) => project.title === '使い方').length, 1);
    assert.equal(switchedJa.projects.filter((project) => project.title === 'Guide').length, 0);

    // 用户手动删除引导后不复活
    const withoutGuide = { ...switchedJa, projects: switchedJa.projects.filter((p) => p.title !== '使い方') };
    await new TaskFlowRepository({ dataDirectory: directory }).save(withoutGuide);
    const afterManualDelete = await new TaskFlowRepository({ dataDirectory: directory }).load('1.2.2', 'ja-JP');
    assert.equal(afterManualDelete.projects.filter((project) => project.title === '使い方').length, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('migrates schema v1 databases and persists project viewport state', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'taskflow-viewport-migration-test-'));

  try {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta (key, value) VALUES ('schema_version', '1');
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, archived INTEGER NOT NULL, archived_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, pinned_at TEXT, sort_order INTEGER
      );
      INSERT INTO projects (id, title, archived, created_at, updated_at)
      VALUES ('project-v1', 'Old project', 0, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
    `);
    await fs.writeFile(path.join(directory, 'taskflow-data.sqlite'), Buffer.from(db.export()));
    db.close();

    const repository = new TaskFlowRepository({ dataDirectory: directory });
    const migrated = await repository.load();
    assert.equal(migrated.projects[0].viewport, undefined);
    migrated.projects[0].viewport = { x: -240, y: 125, zoom: 0.8 };
    migrated.projects[0].sidebarGroupId = 'group-migrated';
    migrated.projectGroups.push({ id: 'group-migrated', title: 'Migrated', collapsed: true, sortOrder: 10 });
    await repository.save(migrated);

    const restarted = await new TaskFlowRepository({ dataDirectory: directory }).load();
    assert.deepEqual(restarted.projects[0].viewport, { x: -240, y: 125, zoom: 0.8 });
    assert.equal(restarted.projects[0].sidebarGroupId, 'group-migrated');
    assert.deepEqual(restarted.projectGroups, [{ id: 'group-migrated', title: 'Migrated', collapsed: true, sortOrder: 10 }]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
