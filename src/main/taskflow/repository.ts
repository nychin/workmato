import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { TaskCard, TaskEdge, TaskFlowData, TaskGroup, TaskProject, TaskProjectGroup } from '../../shared/taskflow';
import type { AppLanguage } from '../../shared/settings';
import { getBundledGuideSeed } from './seed';

const CURRENT_DATA_VERSION = 1 as const;
const CURRENT_SCHEMA_VERSION = 4;

type SqlValue = string | number | null;

interface SqlResult {
  columns: string[];
  values: SqlValue[][];
}

interface SqlDatabase {
  run(sql: string, params?: SqlValue[]): void;
  exec(sql: string): SqlResult[];
  export(): Uint8Array;
  close(): void;
}

interface SqlJsModule {
  Database: new (data?: Uint8Array) => SqlDatabase;
}

type InitSqlJs = () => Promise<SqlJsModule>;

const initSqlJs = require('sql.js/dist/sql-asm.js') as InitSqlJs;

function asString(value: SqlValue): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function asOptionalString(value: SqlValue): string | null {
  return typeof value === 'string' ? value : null;
}

function asOptionalNumber(value: SqlValue): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: SqlValue): boolean {
  return value === 1 || value === '1' || value === 'true';
}

function nullable(value: string | number | null | undefined): SqlValue {
  return value ?? null;
}

function rows(db: SqlDatabase, sql: string): Array<Record<string, SqlValue>> {
  return db.exec(sql).flatMap((result) => result.values.map((values) => Object.fromEntries(
    result.columns.map((column, index) => [column, values[index] ?? null]),
  )));
}

export interface TaskFlowRepositoryOptions {
  /** Used by persistence tests. Production data continues to use Electron's userData directory. */
  dataDirectory?: string;
}

/**
 * SQLite persistence for the task-flow window. The renderer keeps sending and receiving
 * TaskFlowData snapshots through IPC, so this storage change does not alter UI behavior.
 */
export class TaskFlowRepository {
  private readonly dataDirectory?: string;
  private sqlModule: Promise<SqlJsModule> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: TaskFlowRepositoryOptions = {}) {
    this.dataDirectory = options.dataDirectory;
  }

  private get storageDirectory(): string {
    return this.dataDirectory ?? app.getPath('userData');
  }

  private get databasePath(): string {
    return path.join(this.storageDirectory, 'taskflow-data.sqlite');
  }

  private get legacyJsonPath(): string {
    return path.join(this.storageDirectory, 'taskflow-data.json');
  }

  private get legacyBackupPath(): string {
    return `${this.legacyJsonPath}.pre-sqlite-backup`;
  }

  private get bundledGuideStatePath(): string {
    return path.join(this.storageDirectory, 'taskflow-bundled-guide.json');
  }

  async load(bundledGuideVersion?: string, language: AppLanguage = 'zh-CN'): Promise<TaskFlowData> {
    const databaseBytes = await this.readIfPresent(this.databasePath);
    if (databaseBytes) {
      const db = await this.openDatabase(databaseBytes);
      try {
        this.ensureSchema(db);
        const snapshot = this.normalize(this.readSnapshot(db));
        return bundledGuideVersion ? this.ensureBundledGuide(snapshot, bundledGuideVersion, language) : snapshot;
      } finally {
        db.close();
      }
    }

    const legacyData = await this.readLegacyJson();
    if (legacyData) {
      await this.createLegacyBackup();
    }

    const initialData = legacyData ?? this.createInitialData(language);
    await this.persistSnapshot(initialData, false);
    if (!bundledGuideVersion) return initialData;
    if (!legacyData) {
      await this.writeBundledGuideState(bundledGuideVersion, language, initialData.projects.map((project) => project.id));
      return initialData;
    }
    return this.ensureBundledGuide(initialData, bundledGuideVersion, language);
  }

  async save(data: TaskFlowData): Promise<void> {
    // The renderer mutates its in-memory object after scheduling saves. Freeze this snapshot
    // before it enters the queue so an older queued save cannot contain newer partial changes.
    const snapshot = this.normalize(JSON.parse(JSON.stringify(data)) as TaskFlowData);
    const write = this.writeQueue.then(() => this.persistSnapshot(snapshot, true));
    this.writeQueue = write.catch(() => undefined);
    return write;
  }

  private async persistSnapshot(data: TaskFlowData, openExisting: boolean): Promise<void> {
    const existingBytes = openExisting ? await this.readIfPresent(this.databasePath) : null;
    const db = await this.openDatabase(existingBytes ?? undefined);

    try {
      this.ensureSchema(db);
      this.replaceSnapshot(db, this.normalize(data));
      await this.writeDatabaseFile(db);
    } finally {
      db.close();
    }
  }

  private async openDatabase(data?: Uint8Array): Promise<SqlDatabase> {
    if (!this.sqlModule) this.sqlModule = initSqlJs();
    const SQL = await this.sqlModule;
    return new SQL.Database(data);
  }

  private ensureSchema(db: SqlDatabase): void {
    db.run(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        archived INTEGER NOT NULL,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        pinned_at TEXT,
        sort_order INTEGER,
        viewport_x REAL,
        viewport_y REAL,
        viewport_zoom REAL,
        sidebar_group_id TEXT
      );
      CREATE TABLE IF NOT EXISTS project_groups (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        collapsed INTEGER NOT NULL,
        sort_order INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        markdown TEXT NOT NULL,
        x REAL NOT NULL,
        y REAL NOT NULL,
        collapsed INTEGER NOT NULL,
        completed INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        parent_id TEXT,
        card_type TEXT,
        note_mode TEXT,
        drawing TEXT,
        note_collapsed INTEGER,
        note_width REAL,
        note_height REAL,
        group_id TEXT
      );
      CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        color TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_state (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        pinned_card_id TEXT,
        active_project_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_projects_archive_sort ON projects (archived, sort_order);
      CREATE INDEX IF NOT EXISTS idx_cards_project ON cards (project_id);
      CREATE INDEX IF NOT EXISTS idx_cards_parent ON cards (parent_id);
      CREATE INDEX IF NOT EXISTS idx_cards_group ON cards (group_id);
      CREATE INDEX IF NOT EXISTS idx_edges_project ON edges (project_id);
      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges (source_id);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges (target_id);
    `);

    const schemaVersion = rows(db, "SELECT value FROM schema_meta WHERE key = 'schema_version'")[0]?.value;
    if (schemaVersion === undefined) {
      db.run("INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)", [String(CURRENT_SCHEMA_VERSION)]);
      return;
    }

    const parsedVersion = Number(schemaVersion);
    if (!Number.isInteger(parsedVersion) || parsedVersion < 1) {
      throw new Error('[taskflow] Invalid SQLite schema version.');
    }
    if (parsedVersion > CURRENT_SCHEMA_VERSION) {
      throw new Error('[taskflow] SQLite data was created by a newer version of the app.');
    }

    for (let version = parsedVersion + 1; version <= CURRENT_SCHEMA_VERSION; version += 1) {
      this.migrateSchema(db, version);
      db.run("UPDATE schema_meta SET value = ? WHERE key = 'schema_version'", [String(version)]);
    }
  }

  private migrateSchema(db: SqlDatabase, version: number): void {
    if (version === 2) {
      db.run('ALTER TABLE projects ADD COLUMN viewport_x REAL');
      db.run('ALTER TABLE projects ADD COLUMN viewport_y REAL');
      db.run('ALTER TABLE projects ADD COLUMN viewport_zoom REAL');
      return;
    }
    if (version === 3) {
      db.run('ALTER TABLE projects ADD COLUMN sidebar_group_id TEXT');
      db.run(`CREATE TABLE IF NOT EXISTS project_groups (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        collapsed INTEGER NOT NULL,
        sort_order INTEGER NOT NULL
      )`);
      return;
    }
    if (version === 4) {
      const cardColumns = rows(db, 'PRAGMA table_info(cards)').map((row) => asString(row.name));
      if (!cardColumns.includes('note_height')) db.run('ALTER TABLE cards ADD COLUMN note_height REAL');
      return;
    }
    throw new Error(`[taskflow] Missing migration for SQLite schema version ${version}.`);
  }

  private replaceSnapshot(db: SqlDatabase, data: TaskFlowData): void {
    db.run('BEGIN IMMEDIATE');
    try {
      db.run('DELETE FROM edges');
      db.run('DELETE FROM cards');
      db.run('DELETE FROM groups');
      db.run('DELETE FROM project_groups');
      db.run('DELETE FROM projects');
      db.run('DELETE FROM app_state');

      for (const project of data.projects) {
        db.run(
          `INSERT INTO projects (
            id, title, archived, archived_at, created_at, updated_at, pinned_at, sort_order,
            viewport_x, viewport_y, viewport_zoom, sidebar_group_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            project.id,
            project.title,
            project.archived ? 1 : 0,
            nullable(project.archivedAt),
            project.createdAt,
            project.updatedAt,
            nullable(project.pinnedAt),
            nullable(project.sortOrder),
            nullable(project.viewport?.x),
            nullable(project.viewport?.y),
            nullable(project.viewport?.zoom),
            nullable(project.sidebarGroupId),
          ],
        );
      }

      for (const group of data.projectGroups) {
        db.run(
          'INSERT INTO project_groups (id, title, collapsed, sort_order) VALUES (?, ?, ?, ?)',
          [group.id, group.title, group.collapsed ? 1 : 0, group.sortOrder],
        );
      }

      for (const card of data.cards) {
        db.run(
          `INSERT INTO cards (
            id, project_id, title, markdown, x, y, collapsed, completed, created_at, updated_at,
            parent_id, card_type, note_mode, drawing, note_collapsed, note_width, note_height, group_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            card.id,
            card.projectId,
            card.title,
            card.markdown,
            card.x,
            card.y,
            card.collapsed ? 1 : 0,
            card.completed ? 1 : 0,
            card.createdAt,
            card.updatedAt,
            nullable(card.parentId),
            nullable(card.cardType),
            nullable(card.noteMode),
            nullable(card.drawing),
            card.noteCollapsed === undefined ? null : card.noteCollapsed ? 1 : 0,
            nullable(card.noteWidth),
            nullable(card.noteHeight),
            nullable(card.groupId),
          ],
        );
      }

      for (const edge of data.edges) {
        db.run(
          'INSERT INTO edges (id, project_id, source_id, target_id, created_at) VALUES (?, ?, ?, ?, ?)',
          [edge.id, edge.projectId, edge.sourceId, edge.targetId, edge.createdAt],
        );
      }

      for (const group of data.groups) {
        db.run('INSERT INTO groups (id, color) VALUES (?, ?)', [group.id, group.color]);
      }

      db.run(
        'INSERT INTO app_state (singleton_id, pinned_card_id, active_project_id) VALUES (1, ?, ?)',
        [nullable(data.pinnedCardId), nullable(data.activeProjectId)],
      );
      db.run('COMMIT');
    } catch (error) {
      try {
        db.run('ROLLBACK');
      } catch {
        // The transaction can fail before SQLite considers it active.
      }
      throw error;
    }
  }

  private readSnapshot(db: SqlDatabase): TaskFlowData {
    const projects: TaskProject[] = rows(
      db,
      `SELECT id, title, archived, archived_at, created_at, updated_at, pinned_at, sort_order,
        viewport_x, viewport_y, viewport_zoom, sidebar_group_id FROM projects`,
    ).map((row) => {
      const project: TaskProject = {
        id: asString(row.id),
        title: asString(row.title),
        archived: asBoolean(row.archived),
        createdAt: asString(row.created_at),
        updatedAt: asString(row.updated_at),
      };
      const archivedAt = asOptionalString(row.archived_at);
      const pinnedAt = asOptionalString(row.pinned_at);
      const sortOrder = asOptionalNumber(row.sort_order);
      const viewportX = asOptionalNumber(row.viewport_x);
      const viewportY = asOptionalNumber(row.viewport_y);
      const viewportZoom = asOptionalNumber(row.viewport_zoom);
      const sidebarGroupId = asOptionalString(row.sidebar_group_id);
      if (archivedAt !== null) project.archivedAt = archivedAt;
      if (pinnedAt !== null) project.pinnedAt = pinnedAt;
      if (sortOrder !== undefined) project.sortOrder = sortOrder;
      if (viewportX !== undefined && viewportY !== undefined && viewportZoom !== undefined) {
        project.viewport = { x: viewportX, y: viewportY, zoom: viewportZoom };
      }
      if (sidebarGroupId !== null) project.sidebarGroupId = sidebarGroupId;
      return project;
    });

    const projectGroups: TaskProjectGroup[] = rows(
      db,
      'SELECT id, title, collapsed, sort_order FROM project_groups',
    ).map((row) => ({
      id: asString(row.id),
      title: asString(row.title),
      collapsed: asBoolean(row.collapsed),
      sortOrder: Number(row.sort_order ?? 0),
    }));

    const cards: TaskCard[] = rows(
      db,
      `SELECT id, project_id, title, markdown, x, y, collapsed, completed, created_at, updated_at,
        parent_id, card_type, note_mode, drawing, note_collapsed, note_width, note_height, group_id
       FROM cards`,
    ).map((row) => {
      const card: TaskCard = {
        id: asString(row.id),
        projectId: asString(row.project_id),
        title: asString(row.title),
        markdown: asString(row.markdown),
        x: Number(row.x ?? 0),
        y: Number(row.y ?? 0),
        collapsed: asBoolean(row.collapsed),
        completed: asBoolean(row.completed),
        createdAt: asString(row.created_at),
        updatedAt: asString(row.updated_at),
      };
      const parentId = asOptionalString(row.parent_id);
      const cardType = asOptionalString(row.card_type);
      const noteMode = asOptionalString(row.note_mode);
      const drawing = asOptionalString(row.drawing);
      const noteWidth = asOptionalNumber(row.note_width);
      const noteHeight = asOptionalNumber(row.note_height);
      const groupId = asOptionalString(row.group_id);
      if (parentId !== null) card.parentId = parentId;
      if (cardType === 'task' || cardType === 'note') card.cardType = cardType;
      if (noteMode === 'text' || noteMode === 'draw') card.noteMode = noteMode;
      if (drawing !== null) card.drawing = drawing;
      if (row.note_collapsed !== null) card.noteCollapsed = asBoolean(row.note_collapsed);
      if (noteWidth !== undefined) card.noteWidth = noteWidth;
      if (noteHeight !== undefined) card.noteHeight = noteHeight;
      if (groupId !== null) card.groupId = groupId;
      return card;
    });

    const edges: TaskEdge[] = rows(
      db,
      'SELECT id, project_id, source_id, target_id, created_at FROM edges',
    ).map((row) => ({
      id: asString(row.id),
      projectId: asString(row.project_id),
      sourceId: asString(row.source_id),
      targetId: asString(row.target_id),
      createdAt: asString(row.created_at),
    }));

    const groups: TaskGroup[] = rows(db, 'SELECT id, color FROM groups').map((row) => ({
      id: asString(row.id),
      color: asString(row.color),
    }));

    const state = rows(db, 'SELECT pinned_card_id, active_project_id FROM app_state WHERE singleton_id = 1')[0];
    return {
      version: CURRENT_DATA_VERSION,
      projects,
      projectGroups,
      cards,
      edges,
      groups,
      pinnedCardId: state ? asOptionalString(state.pinned_card_id) : null,
      activeProjectId: state ? asOptionalString(state.active_project_id) : null,
    };
  }

  private async writeDatabaseFile(db: SqlDatabase): Promise<void> {
    await fs.mkdir(this.storageDirectory, { recursive: true });
    const tempPath = `${this.databasePath}.tmp`;
    await fs.writeFile(tempPath, Buffer.from(db.export()));
    await fs.rename(tempPath, this.databasePath);
  }

  private async readIfPresent(filePath: string): Promise<Uint8Array | null> {
    try {
      return await fs.readFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async readLegacyJson(): Promise<TaskFlowData | null> {
    try {
      const raw = await fs.readFile(this.legacyJsonPath, 'utf8');
      return this.normalize(JSON.parse(raw) as Partial<TaskFlowData>);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error(`[taskflow] Unable to migrate legacy JSON data: ${(error as Error).message}`);
    }
  }

  private async createLegacyBackup(): Promise<void> {
    try {
      await fs.copyFile(this.legacyJsonPath, this.legacyBackupPath, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }

  private createInitialData(language: AppLanguage): TaskFlowData {
    return structuredClone(getBundledGuideSeed(language));
  }

  /**
   * 按 “appVersion@language” 管理内置“说明”引导：
   * 版本变化或界面语言切换时，先移除旧语言引导（若用户未删除），再注入新版本。
   * 用户手动删除过引导则不会复活。
   */
  private async ensureBundledGuide(data: TaskFlowData, appVersion: string, language: AppLanguage): Promise<TaskFlowData> {
    const state = await this.readBundledGuideState();
    const key = `${appVersion}@${language}`;
    if (state?.key === key) return data;

    // 旧版本状态文件（仅记录 version，无 language/projectIds）：无法回溯哪个项目是内置引导。
    // 若已存在标题匹配当前语言引导的项目，视为用户已持有的引导，记录其 id 且不再重复注入，
    // 避免升级后出现两份“说明”。
    if (state && !state.language) {
      const guideTitle = getBundledGuideSeed(language).projects[0]?.title;
      const existingGuide = data.projects.find((project) => !project.archived && project.title === guideTitle);
      if (existingGuide) {
        await this.writeBundledGuideState(appVersion, language, [existingGuide.id]);
        return data;
      }
    }

    const previousProjectIds = new Set(state?.projectIds ?? []);
    const withoutOldGuide: TaskFlowData = {
      ...data,
      projects: data.projects.filter((project) => !previousProjectIds.has(project.id)),
      cards: data.cards.filter((card) => !previousProjectIds.has(card.projectId)),
      edges: data.edges.filter((edge) => !previousProjectIds.has(edge.projectId)),
      pinnedCardId: data.pinnedCardId && previousProjectIds.has(data.pinnedCardId) ? null : data.pinnedCardId,
    };
    const projectIds = new Set(withoutOldGuide.projects.map((project) => project.id));
    withoutOldGuide.activeProjectId = withoutOldGuide.activeProjectId && projectIds.has(withoutOldGuide.activeProjectId)
      ? withoutOldGuide.activeProjectId
      : withoutOldGuide.projects.find((project) => !project.archived)?.id ?? null;
    const next = withoutOldGuide;
    // 移除旧引导后清理其遗留的群组
    const usedGroupIds = new Set(next.cards.map((card) => card.groupId).filter((id): id is string => Boolean(id)));
    next.groups = next.groups.filter((group) => usedGroupIds.has(group.id));

    const guide = this.cloneBundledGuide(next, language);
    const merged: TaskFlowData = {
      ...next,
      projects: [...next.projects, ...guide.projects],
      cards: [...next.cards, ...guide.cards],
      edges: [...next.edges, ...guide.edges],
      groups: [...next.groups, ...guide.groups],
      // 被替换引导后若没有其它活动项目，直接激活新引导。
      activeProjectId: next.activeProjectId ?? guide.projects[0]?.id ?? null,
    };
    await this.persistSnapshot(merged, true);
    await this.writeBundledGuideState(appVersion, language, guide.projects.map((project) => project.id));
    return merged;
  }

  private cloneBundledGuide(existing: TaskFlowData, language: AppLanguage): TaskFlowData {
    const seed = getBundledGuideSeed(language);
    const timestamp = new Date().toISOString();
    const projectIds = new Map(seed.projects.map((project) => [project.id, `project_${randomUUID()}`]));
    const cardIds = new Map(seed.cards.map((card) => [card.id, `card_${randomUUID()}`]));
    const groupIds = new Map(seed.groups.map((group) => [group.id, `group_${randomUUID()}`]));
    const highestSortOrder = Math.max(0, ...existing.projects.map((project) => project.sortOrder ?? 0));

    return {
      version: CURRENT_DATA_VERSION,
      projects: seed.projects.map((project, index) => ({
        ...structuredClone(project),
        id: projectIds.get(project.id)!,
        archived: false,
        archivedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        pinnedAt: timestamp,
        sortOrder: highestSortOrder + (seed.projects.length - index) * 10,
      })),
      projectGroups: [],
      cards: seed.cards.map((card) => ({
        ...structuredClone(card),
        id: cardIds.get(card.id)!,
        projectId: projectIds.get(card.projectId)!,
        parentId: card.parentId ? cardIds.get(card.parentId) ?? null : card.parentId,
        groupId: card.groupId ? groupIds.get(card.groupId) ?? null : card.groupId,
        createdAt: timestamp,
        updatedAt: timestamp,
      })),
      edges: seed.edges.map((edge) => ({
        ...structuredClone(edge),
        id: `edge_${randomUUID()}`,
        projectId: projectIds.get(edge.projectId)!,
        sourceId: cardIds.get(edge.sourceId)!,
        targetId: cardIds.get(edge.targetId)!,
        createdAt: timestamp,
      })),
      groups: seed.groups.map((group) => ({
        ...structuredClone(group),
        id: groupIds.get(group.id)!,
      })),
      pinnedCardId: null,
      activeProjectId: null,
    };
  }

  private async readBundledGuideState(): Promise<{ key: string; projectIds: string[]; language: string | null } | null> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.bundledGuideStatePath, 'utf8')) as { version?: unknown; language?: unknown; projectIds?: unknown };
      const version = typeof parsed.version === 'string' ? parsed.version : null;
      const language = typeof parsed.language === 'string' ? parsed.language : null;
      const projectIds = Array.isArray(parsed.projectIds)
        ? parsed.projectIds.filter((id): id is string => typeof id === 'string')
        : [];
      if (version === null) return null;
      return { key: `${version}@${language ?? ''}`, projectIds, language };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  private async writeBundledGuideState(version: string, language: AppLanguage, projectIds: string[]): Promise<void> {
    await fs.mkdir(this.storageDirectory, { recursive: true });
    const temporaryPath = `${this.bundledGuideStatePath}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify({ version, language, projectIds }, null, 2), 'utf8');
    await fs.rename(temporaryPath, this.bundledGuideStatePath);
  }

  /** Prevent incomplete hand-edited or legacy data from reaching the renderer. */
  private normalize(candidate: Partial<TaskFlowData>): TaskFlowData {
    const projectGroups = (Array.isArray(candidate.projectGroups) ? candidate.projectGroups : [])
      .filter((group) => group && typeof group.id === 'string' && typeof group.title === 'string')
      .map((group) => ({
        id: group.id,
        title: group.title,
        collapsed: Boolean(group.collapsed),
        sortOrder: Number.isFinite(group.sortOrder) ? group.sortOrder : 0,
      }));
    const projectGroupIds = new Set(projectGroups.map((group) => group.id));
    const projects = (Array.isArray(candidate.projects) ? candidate.projects : []).map((project) => {
      if (project.sidebarGroupId && projectGroupIds.has(project.sidebarGroupId)) return project;
      const { sidebarGroupId: _invalidGroupId, ...withoutGroup } = project;
      return withoutGroup;
    });
    const projectIds = new Set(projects.map((item) => item.id));
    const cards = (Array.isArray(candidate.cards) ? candidate.cards : []).filter((card) => projectIds.has(card.projectId));
    const cardIds = new Set(cards.map((item) => item.id));
    const edges = (Array.isArray(candidate.edges) ? candidate.edges : []).filter(
      (edge) => projectIds.has(edge.projectId) && cardIds.has(edge.sourceId) && cardIds.has(edge.targetId) && edge.sourceId !== edge.targetId,
    );

    const activeProjectId = candidate.activeProjectId && projectIds.has(candidate.activeProjectId)
      ? candidate.activeProjectId
      : projects.find((project) => !project.archived)?.id ?? projects[0]?.id ?? null;

    return {
      version: CURRENT_DATA_VERSION,
      projects,
      projectGroups,
      cards,
      edges,
      groups: Array.isArray(candidate.groups) ? candidate.groups : [],
      pinnedCardId: candidate.pinnedCardId && cardIds.has(candidate.pinnedCardId) ? candidate.pinnedCardId : null,
      activeProjectId,
    };
  }
}
