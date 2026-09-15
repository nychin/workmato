import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { archiveExpired, emptyContext, type ContextCommand, type ContextData } from '../../shared/context';

function validateData(value: unknown): ContextData {
  const data = value as ContextData;
  if (!data || data.version !== 1 || !Array.isArray(data.notes) || typeof data.scratch !== 'string'
    || !Number.isFinite(data.opacity) || data.opacity < 0.2 || data.opacity > 1
    || data.notes.some((note) => !note || typeof note.id !== 'string' || typeof note.text !== 'string'
      || !Number.isFinite(note.createdAt) || !Number.isFinite(note.freshAt) || typeof note.preserved !== 'boolean'
      || (note.archivedAt !== null && !Number.isFinite(note.archivedAt)))) throw new Error('Invalid context data');
  if (new Set(data.notes.map((note) => note.id)).size !== data.notes.length) throw new Error('Duplicate context note');
  return data;
}

/** 串行执行条目级命令，避免速记抽屉与面板覆盖彼此的数据；原子替换持久化文件。 */
export class ContextRepository {
  private data: ContextData | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly directory: string) {}

  private async read(): Promise<ContextData> {
    if (this.data) return this.data;
    const file = path.join(this.directory, 'context.json');
    try {
      this.data = validateData(JSON.parse(await fs.readFile(file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.data = emptyContext();
    }
    return this.data;
  }

  private run(command?: ContextCommand): Promise<ContextData> {
    const operation = this.queue.then(async () => {
      const data: ContextData = JSON.parse(JSON.stringify(await this.read()));
      const expired = archiveExpired(data);
      if (command) {
        if (typeof command !== 'object' || typeof command.type !== 'string') throw new Error('Invalid context command');
        if (['add', 'edit', 'scratch'].includes(command.type)
          && (!('text' in command) || typeof command.text !== 'string' || command.text.length > 100000)) throw new Error('Invalid context text');
        if (['edit', 'delete', 'preserve', 'restore'].includes(command.type)
          && (!('id' in command) || typeof command.id !== 'string')) throw new Error('Invalid context id');
        const note = 'id' in command ? data.notes.find((item) => item.id === command.id) : undefined;
        if ('id' in command && !note) throw new Error('Context note not found');
        switch (command.type) {
          case 'add':
            data.notes.push({ id: randomUUID(), text: command.text, createdAt: Date.now(), freshAt: Date.now(), preserved: false, archivedAt: null });
            break;
          case 'edit': note!.text = command.text; break;
          case 'delete': data.notes = data.notes.filter((item) => item.id !== command.id); break;
          case 'preserve':
            note!.preserved = !note!.preserved;
            note!.freshAt = Date.now();
            note!.archivedAt = null;
            break;
          case 'restore':
            note!.freshAt = Date.now();
            note!.archivedAt = null;
            break;
          case 'scratch': data.scratch = command.text; break;
          case 'opacity':
            if (!Number.isFinite(command.value) || command.value < 0.2 || command.value > 1) throw new Error('Invalid opacity');
            data.opacity = command.value;
            break;
          default: throw new Error('Unknown context command');
        }
      }
      if (command || expired) {
        await fs.mkdir(this.directory, { recursive: true });
        const file = path.join(this.directory, 'context.json');
        await fs.writeFile(`${file}.tmp`, JSON.stringify(data, null, 2), 'utf8');
        await fs.rename(`${file}.tmp`, file);
      }
      this.data = data;
      return JSON.parse(JSON.stringify(data)) as ContextData;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  load(): Promise<ContextData> { return this.run(); }
  change(command: ContextCommand): Promise<ContextData> { return this.run(command); }
  async flush(): Promise<void> { await this.queue; }
}
