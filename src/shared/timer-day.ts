/** 按本地日历划分番茄日；用 setDate 跨日以兼容夏令时，不减固定 24 小时。 */
export function getTimerDay(now: Date, resetTime: string): string {
  const [hours, minutes] = resetTime.split(':').map(Number);
  const boundary = new Date(now);
  boundary.setHours(hours, minutes, 0, 0);
  if (now.getTime() < boundary.getTime()) boundary.setDate(boundary.getDate() - 1);
  return `${boundary.getFullYear()}-${String(boundary.getMonth() + 1).padStart(2, '0')}-${String(boundary.getDate()).padStart(2, '0')}`;
}

export interface TimerDailyProgress {
  version: 1;
  day: string;
  pomodoroCount: number;
  restsSinceLong: number;
}

export function validResetTime(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}
