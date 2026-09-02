import type { TaskFlowData } from '../../shared/taskflow';

function clone(data: TaskFlowData): TaskFlowData {
  return structuredClone(data);
}

/**
 * 小型快照式历史记录足够支撑初版；上限避免长时间使用无限占用内存。
 * 后续复杂操作增加后，可在不影响 UI 的情况下替换为命令模式。
 */
export class TaskFlowHistory {
  private past: TaskFlowData[] = [];
  private future: TaskFlowData[] = [];

  push(data: TaskFlowData): void {
    this.past.push(clone(data));
    if (this.past.length > 80) this.past.shift();
    this.future = [];
  }

  undo(current: TaskFlowData): TaskFlowData | null {
    const previous = this.past.pop();
    if (!previous) return null;
    this.future.push(clone(current));
    return previous;
  }

  redo(current: TaskFlowData): TaskFlowData | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(clone(current));
    return next;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }
}
