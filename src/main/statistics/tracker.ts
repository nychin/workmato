import type { FocusRecord } from '../../shared/settings';

export interface FocusTaskSnapshot {
  taskCardId: string | null;
  taskTitle: string | null;
  projectId: string | null;
  projectTitle: string | null;
}

interface FocusSession {
  id: string;
  startedAt: string;
  plannedSeconds: number;
  task: FocusTaskSnapshot;
}

function localDate(value: string): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function createId(): string {
  return `focus_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

/** Holds an in-progress session only; completed records are written by StatisticsRepository. */
export class FocusSessionTracker {
  private session: FocusSession | null = null;

  begin(plannedSeconds: number, task: FocusTaskSnapshot): void {
    this.session = { id: createId(), startedAt: new Date().toISOString(), plannedSeconds, task };
  }

  finish(focusSeconds: number, completed: boolean, finalize = true): FocusRecord | null {
    if (!this.session) return null;
    const session = this.session;
    if (finalize) this.session = null;
    const completedAt = new Date().toISOString();
    return {
      id: session.id,
      startedAt: session.startedAt,
      completedAt,
      localDate: localDate(completedAt),
      taskCardId: session.task.taskCardId,
      taskTitle: session.task.taskTitle,
      projectId: session.task.projectId,
      projectTitle: session.task.projectTitle,
      focusSeconds: Math.max(0, Math.floor(focusSeconds)),
      plannedSeconds: session.plannedSeconds,
      completed,
    };
  }

  discard(): void {
    this.session = null;
  }
}
