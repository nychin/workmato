import fs from 'node:fs/promises';
import path from 'node:path';
import type { TimerDailyProgress } from '../../shared/timer-day';

/** 每日计数独立于历史统计，沿用原子替换和串行写入约定。 */
export class TimerDailyRepository {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly directory: string) {}

  async load(): Promise<TimerDailyProgress | null> {
    try {
      const value = JSON.parse(await fs.readFile(path.join(this.directory, 'timer-daily.json'), 'utf8')) as TimerDailyProgress;
      if (value.version !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(value.day)
        || !Number.isSafeInteger(value.pomodoroCount) || value.pomodoroCount < 0
        || !Number.isSafeInteger(value.restsSinceLong) || value.restsSinceLong < 0) throw new Error('Invalid timer daily progress');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[timer] Failed to load daily progress:', error);
      return null;
    }
  }

  save(progress: TimerDailyProgress): Promise<void> {
    const contents = JSON.stringify(progress, null, 2);
    const write = this.queue.then(async () => {
      await fs.mkdir(this.directory, { recursive: true });
      const file = path.join(this.directory, 'timer-daily.json');
      await fs.writeFile(`${file}.tmp`, contents, 'utf8');
      await fs.rename(`${file}.tmp`, file);
    });
    this.queue = write.catch(() => undefined);
    return write;
  }

  flush(): Promise<void> { return this.queue; }
}
