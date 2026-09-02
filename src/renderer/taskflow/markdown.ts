export interface MarkdownTaskLine {
  checked: boolean;
  text: string;
  indent: number;
  sourceLine: number;
}

export type MarkdownLine =
  | ({ kind: 'task' } & MarkdownTaskLine)
  | { kind: 'blank'; sourceLine: number }
  | { kind: 'heading'; level: number; text: string; sourceLine: number }
  | { kind: 'unordered-list'; indent: number; text: string; sourceLine: number }
  | { kind: 'ordered-list'; indent: number; number: string; text: string; sourceLine: number }
  | { kind: 'quote'; text: string; sourceLine: number }
  | { kind: 'code'; text: string; sourceLine: number }
  | { kind: 'horizontal-rule'; sourceLine: number }
  | { kind: 'paragraph'; text: string; sourceLine: number };

const TASK_PATTERN = /^(\s*)[-*]\s+\[([ xX])\]\s*(.*)$/;

export function parseMarkdownTasks(markdown: string): MarkdownTaskLine[] {
  return markdown.split('\n').flatMap((line, sourceLine) => {
    const match = line.match(TASK_PATTERN);
    if (!match) return [];
    return [{
      checked: match[2].toLowerCase() === 'x',
      text: match[3],
      indent: Math.floor(match[1].replace(/\t/g, '  ').length / 2),
      sourceLine,
    }];
  });
}

export function toggleMarkdownTask(markdown: string, sourceLine: number): string {
  const lines = markdown.split('\n');
  const line = lines[sourceLine];
  if (!line) return markdown;
  lines[sourceLine] = line.replace(TASK_PATTERN, (_full, indent: string, checked: string, text: string) => {
    return `${indent}- [${checked.toLowerCase() === 'x' ? ' ' : 'x'}] ${text}`;
  });
  return lines.join('\n');
}

/**
 * 按源行顺序解析卡片正文。这里有意只实现卡片中常用且稳定的 Markdown 子集，
 * 避免引入允许原始 HTML 的渲染器，确保用户内容始终按文本安全输出。
 */
export function parseMarkdownLines(markdown: string): MarkdownLine[] {
  const result: MarkdownLine[] = [];
  let fencedCode = false;

  markdown.split('\n').forEach((line, sourceLine) => {
    if (/^\s*```/.test(line)) {
      fencedCode = !fencedCode;
      return;
    }
    if (fencedCode) {
      result.push({ kind: 'code', text: line, sourceLine });
      return;
    }

    const task = line.match(TASK_PATTERN);
    if (task) {
      result.push({
        kind: 'task',
        checked: task[2].toLowerCase() === 'x',
        text: task[3],
        indent: Math.floor(task[1].replace(/\t/g, '  ').length / 2),
        sourceLine,
      });
      return;
    }
    if (!line.trim()) {
      result.push({ kind: 'blank', sourceLine });
      return;
    }
    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      result.push({ kind: 'horizontal-rule', sourceLine });
      return;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
    if (heading) {
      result.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim(), sourceLine });
      return;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      result.push({ kind: 'quote', text: quote[1], sourceLine });
      return;
    }
    const unordered = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (unordered) {
      result.push({
        kind: 'unordered-list',
        indent: Math.floor(unordered[1].replace(/\t/g, '  ').length / 2),
        text: unordered[2],
        sourceLine,
      });
      return;
    }
    const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
    if (ordered) {
      result.push({
        kind: 'ordered-list',
        indent: Math.floor(ordered[1].replace(/\t/g, '  ').length / 2),
        number: ordered[2],
        text: ordered[3],
        sourceLine,
      });
      return;
    }
    result.push({ kind: 'paragraph', text: line.trim(), sourceLine });
  });

  return result;
}

/**
 * 将 Markdown 拆分为阅读态段落。
 * - 保留空行（返回 '' 表示空行），以便渲染时体现段间距，与 textarea 编辑态视觉一致；
 * - 跳过任务行（由 renderMarkdown 单独渲染为勾选框），不产生任何占位；
 * - 非任务行做 trim 去除首尾空白。
 */
export function renderPlainMarkdown(markdown: string): string[] {
  return markdown
    .split('\n')
    .filter((line) => !TASK_PATTERN.test(line.trim()))
    .map((line) => line.trim());
}
