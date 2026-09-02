const initSqlJs = require('D:/AI/tomato_gpt/app/node_modules/sql.js/dist/sql-asm.js');
const fs = require('fs');

(async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(process.argv[2]));
  const rows = (sql) => db.exec(sql).flatMap((r) => r.values.map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))));

  const projects = rows('SELECT id, title, archived FROM projects');
  const groups = rows('SELECT id, color FROM groups');
  const cards = rows('SELECT id, project_id, title, x, y, parent_id, group_id, card_type, note_width, note_height FROM cards');

  for (const p of projects) {
    const projectCards = cards.filter((c) => c.project_id === p.id);
    const gids = new Set(projectCards.map((c) => c.group_id).filter(Boolean));
    console.log(`\n===== 项目「${p.title}」(archived=${p.archived}) =====`);
    console.log(`项目内组: ${[...gids].length}`);
    for (const gid of gids) {
      const g = groups.find((x) => x.id === gid);
      const members = projectCards.filter((c) => c.group_id === gid && !c.parent_id);
      const notes = projectCards.filter((c) => c.group_id === gid && c.parent_id);
      console.log(` 组 ${gid} (${g ? g.color : '???'}) 主卡 ${members.length} 便签 ${notes.length}`);
      for (const m of members) console.log(`   - [${m.id}] "${m.title.slice(0, 12)}" x=${m.x} y=${m.y}`);
      for (const n of notes) console.log(`   - [note ${n.id}] x=${n.x} y=${n.y} parent=${n.parent_id}`);
    }
    const allGrouped = projectCards.filter((c) => !c.group_id);
    console.log(`未分组卡片: ${allGrouped.length}`);
  }
})();
