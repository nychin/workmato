/** 工作上下文的持久化模型与跨进程契约。时间统一使用 Unix 毫秒。 */
export interface ContextNote {
  id: string;
  text: string;
  createdAt: number;
  freshAt: number;
  preserved: boolean;
  archivedAt: number | null;
}

export interface ContextData {
  version: 1;
  notes: ContextNote[];
  scratch: string;
  opacity: number;
}

export type ContextCommand =
  | { type: 'add'; text: string }
  | { type: 'edit'; id: string; text: string }
  | { type: 'preserve'; id: string }
  | { type: 'restore'; id: string }
  | { type: 'delete'; id: string }
  | { type: 'scratch'; text: string }
  | { type: 'opacity'; value: number };

export interface ContextWindowState { expanded: boolean; pinned: boolean; passthrough: boolean }

/** 渲染布局与原生矩形命中共用 DIP 尺寸，避免窗口放大后穿透开关错位。 */
export const CONTEXT_LAYOUT = {
  panel: { x: 10, y: 18, width: Math.round(394 * 1.1), height: Math.round(196 * 1.15) },
  columns: [104, 151, 178],
  icon: { x: 0, y: 0, width: 40, height: 40 },
  switchInset: { x: 9, y: 1, width: 26, height: 24 },
} as const;

export const CONTEXT_WINDOW_SIZE = {
  width: CONTEXT_LAYOUT.panel.x + CONTEXT_LAYOUT.panel.width + 4,
  height: CONTEXT_LAYOUT.panel.y + CONTEXT_LAYOUT.panel.height + 2,
};

export const CONTEXT_PASSTHROUGH_RECT = {
  x: CONTEXT_LAYOUT.panel.x + CONTEXT_LAYOUT.columns[0] + CONTEXT_LAYOUT.columns[1] + CONTEXT_LAYOUT.switchInset.x,
  y: CONTEXT_LAYOUT.panel.y + CONTEXT_LAYOUT.switchInset.y,
  width: CONTEXT_LAYOUT.switchInset.width,
  height: CONTEXT_LAYOUT.switchInset.height,
};

export function contextRectContains(rect: { x: number; y: number; width: number; height: number }, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

export interface ContextAPI {
  ready: () => void;
  load: () => Promise<ContextData>;
  change: (command: ContextCommand) => Promise<ContextData>;
  togglePin: () => void;
  setPassthrough: (enabled: boolean) => void;
  closeCapture: () => void;
  dragStart: () => void;
  dragMove: () => void;
  dragEnd: () => void;
  onData: (callback: (data: ContextData) => void) => void;
  onState: (callback: (state: ContextWindowState) => void) => void;
  onCapture: (callback: () => void) => void;
}

export const CONTEXT_LIFETIME = 90 * 60 * 1000;
export const emptyContext = (): ContextData => ({ version: 1, notes: [], scratch: '', opacity: 1 });

export function freshness(note: ContextNote, now = Date.now()): number {
  return note.preserved ? -1 : Math.min(2, Math.floor(Math.max(0, now - note.freshAt) / (30 * 60 * 1000)));
}

export function sortContextNotes(notes: ContextNote[]): ContextNote[] {
  return [...notes].sort((a, b) => Number(b.preserved) - Number(a.preserved) || b.freshAt - a.freshAt || a.id.localeCompare(b.id));
}

export function archiveExpired(data: ContextData, now = Date.now()): boolean {
  let changed = false;
  for (const note of data.notes) {
    if (note.archivedAt === null && !note.preserved && now - note.freshAt >= CONTEXT_LIFETIME) {
      note.archivedAt = note.freshAt + CONTEXT_LIFETIME;
      changed = true;
    }
  }
  return changed;
}
