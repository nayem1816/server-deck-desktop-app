import type { DesktopApi, DesktopEvents, IpcResult } from '@serverdeck/shared';

/** What electron/preload.ts exposes. */
interface Bridge {
  invoke(channel: string, args: unknown[]): Promise<IpcResult<unknown>>;
  send(channel: string, args: unknown[]): void;
  on(event: string, listener: (payload: unknown) => void): () => void;
  platform: string;
}

declare global {
  interface Window {
    serverdeck?: Bridge;
  }
}

export class DesktopClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DesktopClientError';
  }

  /** First error per field, from a VALIDATION_ERROR. */
  get fieldErrors(): Record<string, string> {
    const fields = (this.details as { fieldErrors?: Record<string, string[] | undefined> } | null)
      ?.fieldErrors;
    const out: Record<string, string> = {};
    for (const [key, messages] of Object.entries(fields ?? {})) {
      if (messages?.[0]) out[key] = messages[0];
    }
    return out;
  }
}

export function hasBridge(): boolean {
  return typeof window !== 'undefined' && window.serverdeck !== undefined;
}

export function isMac(): boolean {
  return hasBridge() && window.serverdeck!.platform === 'darwin';
}

function bridge(): Bridge {
  if (!hasBridge()) {
    throw new DesktopClientError('NO_BRIDGE', 'Open ServerDeck from the desktop app.');
  }
  return window.serverdeck!;
}

async function call(channel: string, args: unknown[]): Promise<unknown> {
  const result = await bridge().invoke(channel, args);
  if (!result.ok) {
    throw new DesktopClientError(result.error.code, result.error.message, result.error.details);
  }
  return result.data;
}

function namespace<T extends object>(name: string, fireAndForget: string[] = []): T {
  return new Proxy({} as T, {
    get: (_target, method) => {
      if (typeof method !== 'string') return undefined;
      return (...args: unknown[]) =>
        fireAndForget.includes(method)
          ? bridge().send(`${name}.${method}`, args)
          : call(`${name}.${method}`, args);
    },
  });
}

/** Typed access to the main process. See packages/shared/src/desktop.ts. */
export const api: DesktopApi = {
  auth: namespace('auth'),
  servers: namespace('servers'),
  sync: namespace('sync'),
  data: namespace('data'),
  ssh: namespace('ssh', ['write', 'resize', 'answerHostKey']),
  clipboard: namespace('clipboard'),
  on<K extends keyof DesktopEvents>(event: K, listener: (payload: DesktopEvents[K]) => void) {
    if (!hasBridge()) return () => undefined;
    return bridge().on(event, listener as (payload: unknown) => void);
  },
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong. Please try again.';
}
