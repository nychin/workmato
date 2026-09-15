import { BrowserWindow, screen, type Rectangle } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

let worker: ChildProcessWithoutNullStreams | null = null;
let ready = false;
let pending: ((rect: Rectangle | null) => void) | null = null;

export function disposeFocusDisplay(): void {
  const previous = worker;
  worker = null;
  ready = false;
  pending?.(null);
  pending = null;
  previous?.kill();
}

/** 预先编译一次 Win32 查询，快捷键触发时仅通过 stdin 发出查询。 */
export function prepareFocusDisplay(): void {
  if (process.platform !== 'win32' || worker) return;
  const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ContextForeground {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[ContextForeground]::SetProcessDPIAware() | Out-Null
[Console]::WriteLine('ready')
while ($null -ne [Console]::ReadLine()) {
  $contextRect = New-Object ContextForeground+Rect
  if ([ContextForeground]::GetWindowRect([ContextForeground]::GetForegroundWindow(), [ref]$contextRect)) {
    [Console]::WriteLine((@{ x=$contextRect.Left; y=$contextRect.Top; width=($contextRect.Right-$contextRect.Left); height=($contextRect.Bottom-$contextRect.Top) } | ConvertTo-Json -Compress))
  } else { [Console]::WriteLine('null') }
}`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
  worker = child;
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line === 'ready') { ready = true; continue; }
      const resolve = pending;
      pending = null;
      try { resolve?.(JSON.parse(line)); } catch { resolve?.(null); }
    }
  });
  child.stderr.resume();
  const stopped = (): void => { if (worker === child) disposeFocusDisplay(); };
  child.on('error', stopped);
  child.on('exit', stopped);
  child.stdin.on('error', stopped);
}

/** Electron 不提供其它应用的前台窗口；Windows 下只查询窗口矩形，不读取窗口内容。 */
export async function getFocusedWorkArea(): Promise<Rectangle> {
  const ownWindow = BrowserWindow.getFocusedWindow();
  if (ownWindow) return screen.getDisplayMatching(ownWindow.getBounds()).workArea;
  const fallback = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  if (process.platform !== 'win32') return fallback;
  prepareFocusDisplay();
  if (!ready || !worker || pending) return fallback;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { disposeFocusDisplay(); resolve(fallback); }, 150);
    pending = (rect) => {
      clearTimeout(timeout);
      if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) {
        resolve(fallback);
        return;
      }
      resolve(screen.getDisplayMatching(screen.screenToDipRect(null, rect)).workArea);
    };
    worker!.stdin.write('query\n');
  });
}
