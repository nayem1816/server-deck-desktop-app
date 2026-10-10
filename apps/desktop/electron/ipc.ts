import { ipcMain } from 'electron';
import type { DesktopApi, IpcResult } from '@serverdeck/shared';
import { toErrorShape } from './errors';

type Namespaces = Omit<DesktopApi, 'on'>;

/** Main-side implementation: same shape as window.api, with args as the renderer sends them. */
export type Handlers = {
  [N in keyof Namespaces]: {
    [M in keyof Namespaces[N]]: Namespaces[N][M] extends (...args: infer A) => infer R
      ? (...args: A) => Awaited<R> | Promise<Awaited<R>>
      : never;
  };
};

/** Calls that don't need an answer (keystrokes, resize) use ipcRenderer.send. */
export const FIRE_AND_FORGET = new Set(['ssh.write', 'ssh.resize', 'ssh.answerHostKey']);

export function registerHandlers(handlers: Handlers): void {
  const table = new Map<string, (...args: unknown[]) => unknown>();
  for (const [ns, methods] of Object.entries(handlers)) {
    for (const [method, fn] of Object.entries(methods as Record<string, unknown>)) {
      table.set(`${ns}.${method}`, fn as (...args: unknown[]) => unknown);
    }
  }

  ipcMain.handle('rpc', async (_event, channel: unknown, args: unknown): Promise<IpcResult<unknown>> => {
    const fn = typeof channel === 'string' ? table.get(channel) : undefined;
    if (!fn || !Array.isArray(args)) {
      return { ok: false, error: { code: 'NOT_FOUND', message: `Unknown call ${String(channel)}` } };
    }
    try {
      return { ok: true, data: (await fn(...args)) ?? null };
    } catch (err) {
      return { ok: false, error: toErrorShape(err) };
    }
  });

  ipcMain.on('rpc-send', (_event, channel: unknown, args: unknown) => {
    if (typeof channel !== 'string' || !FIRE_AND_FORGET.has(channel) || !Array.isArray(args)) {
      return;
    }
    try {
      table.get(channel)?.(...args);
    } catch (err) {
      console.error(`${channel} failed`, err);
    }
  });
}
