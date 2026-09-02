import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FocusRecord, PeriodSummary, ProjectFocusRanking, StatisticsDashboard, TaskFocusRanking } from '../../shared/settings';

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

export interface StatisticsRepositoryOptions {
  dataDirectory?: string;
}

function rows(db: SqlDatabase, sql: string, params: SqlValue[] = []): Array<Record<string, SqlValue>> {
  return db.exec(sql).flatMap((result) => result.values.map((values) => Object.fromEntries(
    result.columns.map((column, index) => [column, values[index] ?? null]),
  )));
}

function asString(value: SqlValue): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function asNullableString(value: SqlValue): string | null {
  return typeof value === 'string' ? value : null;
}

function toLocalDate(value: string): string {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function startOfWeek(date: Date): string {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const offset = (result.getDay() + 6) % 7;
  result.setDate(result.getDate() - offset);
  return toLocalDate(result.toISOString());
}

function startOfMonth(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`;
}

function normalizeRecord(candidate: FocusRecord): FocusRecord {
  if (!candidate.id || !Number.isInteger(candidate.focusSeconds) || candidate.focusSeconds < 0) {
    throw new Error('[statistics] Invalid focus record.');
  }
  return {
    ...candidate,
    localDate: /^\d{4}-\d{2}-\d{2}$/.test(candidate.localDate) ? candidate.localDate : toLocalDate(candidate.completedAt),
    plannedSeconds: Math.max(0, Math.floor(candidate.plannedSeconds)),
    focusSeconds: Math.max(0, Math.floor(candidate.focusSeconds)),
    completed: candidate.completed === true,
  };
}

export class StatisticsRepository {
  private readonly dataDirectory?: string;
  private sqlModule: Promise<SqlJsModule> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: StatisticsRepositoryOptions = {}) {
    this.dataDirectory = options.dataDirectory;
  }

  private get storageDirectory(): string {
    return this.dataDirectory ?? app.getPath('userData');
  }

  private get databasePath(): string {
    return path.join(this.storageDirectory, 'statistics.sqlite');
  }

  async record(record: FocusRecord): Promise<void> {
    const normalized = normalizeRecord(record);
    await this.enqueue(async () => {
      const db = await this.openExisting();
      try {
        this.ensureSchema(db);
        db.run(
          `INSERT OR REPLACE INTO focus_records (
            id, started_at, completed_at, local_date, task_card_id, task_title,
            project_id, project_title, focus_seconds, planned_seconds, completed
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            normalized.id, normalized.startedAt, normalized.completedAt, normalized.localDate,
            normalized.taskCardId, normalized.taskTitle, normalized.projectId, normalized.projectTitle,
            normalized.focusSeconds, normalized.plannedSeconds, normalized.completed ? 1 : 0,
          ],
        );
        await this.writeDatabase(db);
      } finally {
        db.close();
      }
    });
  }

  async listRecords(): Promise<FocusRecord[]> {
    const db = await this.openExisting();
    try {
      this.ensureSchema(db);
      return rows(db, `SELECT id, started_at, completed_at, local_date, task_card_id, task_title,
          project_id, project_title, focus_seconds, planned_seconds, completed
        FROM focus_records ORDER BY completed_at DESC`).map((row) => ({
        id: asString(row.id),
        startedAt: asString(row.started_at),
        completedAt: asString(row.completed_at),
        localDate: asString(row.local_date),
        taskCardId: asNullableString(row.task_card_id),
        taskTitle: asNullableString(row.task_title),
        projectId: asNullableString(row.project_id),
        projectTitle: asNullableString(row.project_title),
        focusSeconds: Number(row.focus_seconds ?? 0),
        plannedSeconds: Number(row.planned_seconds ?? 0),
        completed: Number(row.completed ?? 0) === 1,
      }));
    } finally {
      db.close();
    }
  }

  async getDashboard(now = new Date()): Promise<StatisticsDashboard> {
    const records = await this.listRecords();
    const today = toLocalDate(now.toISOString());
    const week = startOfWeek(now);
    const month = startOfMonth(now);
    const summarize = (matches: FocusRecord[]): PeriodSummary => ({
      focusSeconds: matches.reduce((sum, record) => sum + record.focusSeconds, 0),
      pomodoroCount: matches.filter((record) => record.completed).length,
    });
    const rank = new Map<string, TaskFocusRanking>();
    const projectRank = new Map<string, ProjectFocusRanking>();
    for (const record of records) {
      const taskTitle = record.taskTitle ?? '未绑定任务';
      const key = `${record.taskCardId ?? taskTitle}\u0000${record.projectId ?? ''}`;
      const item = rank.get(key) ?? { taskTitle, projectTitle: record.projectTitle, focusSeconds: 0, pomodoroCount: 0 };
      item.focusSeconds += record.focusSeconds;
      item.pomodoroCount += record.completed ? 1 : 0;
      rank.set(key, item);

      const projectKey = record.projectId ?? '__unassigned__';
      const projectTitle = record.projectTitle ?? '未绑定任务';
      const project = projectRank.get(projectKey) ?? {
        id: projectKey,
        projectTitle,
        focusSeconds: 0,
        pomodoroCount: 0,
        tasks: [],
      };
      let projectTask = project.tasks.find((candidate) => candidate.taskTitle === taskTitle);
      if (!projectTask) {
        projectTask = { taskTitle, projectTitle: record.projectTitle, focusSeconds: 0, pomodoroCount: 0 };
        project.tasks.push(projectTask);
      }
      project.focusSeconds += record.focusSeconds;
      project.pomodoroCount += record.completed ? 1 : 0;
      projectTask.focusSeconds += record.focusSeconds;
      projectTask.pomodoroCount += record.completed ? 1 : 0;
      projectRank.set(projectKey, project);
    }
    return {
      day: summarize(records.filter((record) => record.localDate === today)),
      week: summarize(records.filter((record) => record.localDate >= week && record.localDate <= today)),
      month: summarize(records.filter((record) => record.localDate >= month && record.localDate <= today)),
      rankings: [...rank.values()].sort((a, b) => b.focusSeconds - a.focusSeconds).slice(0, 20),
      projectRankings: [...projectRank.values()]
        .map((project) => ({ ...project, tasks: project.tasks.sort((a, b) => b.focusSeconds - a.focusSeconds) }))
        .sort((a, b) => b.focusSeconds - a.focusSeconds),
    };
  }

  async clear(): Promise<void> {
    await this.enqueue(async () => {
      const db = await this.openExisting();
      try {
        this.ensureSchema(db);
        db.run('DELETE FROM focus_records');
        await this.writeDatabase(db);
      } finally {
        db.close();
      }
    });
  }

  async replaceRecords(records: FocusRecord[]): Promise<void> {
    const normalized = records.map(normalizeRecord);
    await this.enqueue(async () => {
      const db = await this.openExisting();
      try {
        this.ensureSchema(db);
        db.run('BEGIN IMMEDIATE');
        try {
          db.run('DELETE FROM focus_records');
          for (const record of normalized) {
            db.run(
              `INSERT INTO focus_records (
                id, started_at, completed_at, local_date, task_card_id, task_title,
                project_id, project_title, focus_seconds, planned_seconds, completed
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [record.id, record.startedAt, record.completedAt, record.localDate, record.taskCardId, record.taskTitle,
                record.projectId, record.projectTitle, record.focusSeconds, record.plannedSeconds, record.completed ? 1 : 0],
            );
          }
          db.run('COMMIT');
        } catch (error) {
          db.run('ROLLBACK');
          throw error;
        }
        await this.writeDatabase(db);
      } finally {
        db.close();
      }
    });
  }

  private async enqueue(work: () => Promise<void>): Promise<void> {
    const write = this.writeQueue.then(work);
    this.writeQueue = write.catch(() => undefined);
    await write;
  }

  private async openExisting(): Promise<SqlDatabase> {
    const bytes = await this.readIfPresent(this.databasePath);
    if (!this.sqlModule) this.sqlModule = initSqlJs();
    const SQL = await this.sqlModule;
    return new SQL.Database(bytes ?? undefined);
  }

  private ensureSchema(db: SqlDatabase): void {
    db.run(`CREATE TABLE IF NOT EXISTS focus_records (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      local_date TEXT NOT NULL,
      task_card_id TEXT,
      task_title TEXT,
      project_id TEXT,
      project_title TEXT,
      focus_seconds INTEGER NOT NULL,
      planned_seconds INTEGER NOT NULL,
      completed INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_focus_records_local_date ON focus_records (local_date);
    CREATE INDEX IF NOT EXISTS idx_focus_records_task ON focus_records (task_card_id);`);
  }

  private async readIfPresent(filePath: string): Promise<Uint8Array | null> {
    try {
      return await fs.readFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async writeDatabase(db: SqlDatabase): Promise<void> {
    await fs.mkdir(this.storageDirectory, { recursive: true });
    const temporaryPath = `${this.databasePath}.tmp`;
    await fs.writeFile(temporaryPath, Buffer.from(db.export()));
    await fs.rename(temporaryPath, this.databasePath);
  }
}
