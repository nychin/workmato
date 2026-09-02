/**
 * 从开发版 taskflow-data.sqlite 导出“说明”引导项目到 guide-source/guide.zh.json。
 *
 * 用法：node scripts/guide-source/export-dev-guide.cjs [数据库路径]
 *   默认读取开发版 userData：%TEMP%\tomato-clock-dev\taskflow-data.sqlite
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const initSqlJs = require('sql.js/dist/sql-asm.js');

const databasePath = process.argv[2] ?? path.join(os.tmpdir(), 'tomato-clock-dev', 'taskflow-data.sqlite');
const outputPath = path.join(__dirname, 'guide.zh.json');

function rows(db, sql) {
  const result = db.exec(sql);
  return result.length
    ? result[0].values.map((values) => Object.fromEntries(result[0].columns.map((column, index) => [column, values[index] ?? null])))
    : [];
}

initSqlJs().then((SQL) => {
  const db = new SQL.Database(fs.readFileSync(databasePath));
  const projects = rows(db, 'SELECT id, title FROM projects');
  const guide = projects.find((project) => project.title === '说明');
  if (!guide) throw new Error(`开发版数据库中没有找到“说明”项目（现有项目：${projects.map((p) => p.title).join('、')}）。`);
  const guideId = guide.id;

  const projectRows = rows(db, `SELECT id, title, archived, archived_at, created_at, updated_at, pinned_at, sort_order, viewport_x, viewport_y, viewport_zoom, sidebar_group_id FROM projects WHERE id='${guideId}'`);
  const project = projectRows.map((p) => ({
    id: p.id,
    title: p.title,
    archived: Boolean(p.archived),
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    pinnedAt: p.pinned_at,
    sortOrder: p.sort_order,
    viewport: p.viewport_x !== null ? { x: p.viewport_x, y: p.viewport_y, zoom: p.viewport_zoom } : undefined,
    archivedAt: p.archived_at,
    sidebarGroupId: p.sidebar_group_id,
  }));

  const cardRows = rows(db, `SELECT * FROM cards WHERE project_id='${guideId}'`);
  const cards = cardRows.map((c) => {
    const out = {
      id: c.id, project_id: c.project_id, title: c.title, markdown: c.markdown,
      x: c.x, y: c.y, collapsed: c.collapsed, completed: c.completed,
      created_at: c.created_at, updated_at: c.updated_at,
      parent_id: c.parent_id, card_type: c.card_type, note_mode: c.note_mode,
      drawing: c.drawing, note_collapsed: c.note_collapsed, note_width: c.note_width,
      group_id: c.group_id, note_height: c.note_height,
    };
    return out;
  });
  const edges = rows(db, `SELECT * FROM edges WHERE project_id='${guideId}'`).map((e) => ({
    id: e.id, project_id: e.project_id, source_id: e.source_id, target_id: e.target_id, created_at: e.created_at,
  }));
  const groupRows = rows(db, 'SELECT * FROM groups');
  const referencedGroupIds = new Set(cards.map((c) => c.group_id).filter(Boolean));
  const groups = groupRows.filter((g) => referencedGroupIds.has(g.id)).map((g) => ({ id: g.id, color: g.color }));

  const out = { version: 1, projects: project, projectGroups: [], cards, edges, groups, pinnedCardId: null, activeProjectId: guideId };
  fs.writeFileSync(outputPath, JSON.stringify(out, null, 2));
  console.log(`Exported guide: ${cards.length} cards, ${edges.length} edges, ${groups.length} groups → ${outputPath}`);
});
