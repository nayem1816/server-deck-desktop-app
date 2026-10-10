import { createHash, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import {
  serverFormSchema,
  type DesktopEvents,
  type ServerForm,
  type SshStage,
  type TestConnectionResult,
} from '@serverdeck/shared';
import { DesktopError } from './errors';
import type { PlainSecrets, ServerRepo } from './servers';

type Emit = <K extends keyof DesktopEvents>(event: K, payload: DesktopEvents[K]) => void;

interface Target {
  serverId: string | null;
  host: string;
  port: number;
  username: string;
  savedFingerprint: string | null;
  secrets: PlainSecrets;
}

interface Size {
  cols: number;
  rows: number;
}

interface Session {
  client: Client;
  stream: ClientChannel | null;
  closedByUser: boolean;
  /** The first end-of-session reason was shown; later ones (e.g. close after error) are noise. */
  reported: boolean;
}

/** No answer from the server within this time (not counting time spent on the host-key prompt). */
const HANDSHAKE_TIMEOUT_MS = 20_000;
/** Terminal output is batched per tab to keep IPC traffic low. */
const FLUSH_MS = 8;

export function fingerprintOf(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/** Turns ssh2 / socket errors into something the user can act on. */
export function friendlySshError(err: Error & { code?: string; level?: string }): string {
  const message = err.message ?? '';
  switch (err.code) {
    case 'ECONNREFUSED':
      return 'Connection refused. Check the host and port, and that SSH is running on the server.';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return "Host not found. Check the address and your internet connection.";
    case 'ETIMEDOUT':
      return "Timed out. The server isn't responding — check the address, port and firewall.";
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'Network unreachable. Check your connection or VPN.';
    case 'ECONNRESET':
      return 'The server closed the connection.';
  }
  if (err.level === 'client-authentication' || /authentication methods failed/i.test(message)) {
    return 'Authentication failed. Check the username and the password or key.';
  }
  if (/passphrase/i.test(message)) return 'The private key needs a passphrase, or the passphrase is wrong.';
  if (/privateKey|parse.*key|unsupported key/i.test(message)) {
    return "The private key couldn't be read. Use an OpenSSH or PEM key.";
  }
  if (/handshake|timed out/i.test(message)) {
    return "Timed out. The server isn't responding — check the address, port and firewall.";
  }
  if (/host denied|host key.*(rejected|verification failed)|hostVerifier/i.test(message)) {
    return 'Connection cancelled: the host key was not accepted.';
  }
  return message || 'The connection failed.';
}

/** SSH sessions run here, in the main process; secrets never reach the renderer (spec 7). */
export class SshManager {
  private readonly sessions = new Map<string, Session>();
  private readonly hostKeyAnswers = new Map<string, (accept: boolean) => void>();
  private readonly outBuffers = new Map<string, string>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly servers: ServerRepo,
    private readonly emit: Emit,
  ) {}

  async connect(tabId: string, serverId: string, size: Size): Promise<void> {
    this.close(tabId);
    const target = await this.savedTarget(serverId);
    if (!target.secrets.password && !target.secrets.privateKey) {
      throw new DesktopError('VALIDATION_ERROR', 'Add a password or key to this server first.');
    }

    const session: Session = { client: new Client(), stream: null, closedByUser: false, reported: false };
    this.sessions.set(tabId, session);
    this.stage(tabId, 'network');

    const { client } = session;
    let acceptedFingerprint: string | null = null;

    client.on('ready', () => {
      this.stage(tabId, 'shell');
      client.shell({ term: 'xterm-256color', cols: size.cols, rows: size.rows }, (err, stream) => {
        if (err) {
          this.status(tabId, 'error', `Couldn't open a shell: ${err.message}`);
          client.end();
          return;
        }
        session.stream = stream;
        this.servers.markConnected(serverId, acceptedFingerprint);
        this.status(tabId, 'connected', null);

        const decoder = new StringDecoder('utf8');
        const onData = (chunk: Buffer) => this.output(tabId, decoder.write(chunk));
        stream.on('data', onData);
        stream.stderr.on('data', onData);
        stream.on('close', () => {
          if (!session.closedByUser && !session.reported) {
            session.reported = true;
            this.status(tabId, 'disconnected', 'The session ended.');
          }
          client.end();
        });
      });
    });

    this.attach(client, target, tabId, (fp) => {
      acceptedFingerprint = fp;
    }, (message) => {
      if (session.closedByUser || session.reported || this.sessions.get(tabId) !== session) return;
      session.reported = true;
      this.status(tabId, session.stream ? 'disconnected' : 'error', message);
    }, (stage) => {
      if (!session.closedByUser && this.sessions.get(tabId) === session) this.stage(tabId, stage);
    });
  }

  write(tabId: string, data: string): void {
    this.sessions.get(tabId)?.stream?.write(data);
  }

  resize(tabId: string, size: Size): void {
    this.sessions.get(tabId)?.stream?.setWindow(size.rows, size.cols, 0, 0);
  }

  async disconnect(tabId: string): Promise<void> {
    this.close(tabId);
  }

  answerHostKey(tabId: string, accept: boolean): void {
    const answer = this.hostKeyAnswers.get(tabId);
    this.hostKeyAnswers.delete(tabId);
    answer?.(accept);
  }

  disconnectAll(): void {
    for (const tabId of [...this.sessions.keys()]) this.close(tabId);
  }

  /** Authenticates and closes; asks about unknown host keys like a real connection. */
  async test(target: { serverId: string } | { form: ServerForm; serverId?: string }): Promise<TestConnectionResult> {
    const resolved =
      'form' in target ? await this.formTarget(target.form, target.serverId ?? null) : await this.savedTarget(target.serverId);
    if (!resolved.secrets.password && !resolved.secrets.privateKey) {
      throw new DesktopError('VALIDATION_ERROR', 'Enter a password or private key to test the connection.');
    }

    const testId = `test-${randomUUID()}`;
    const client = new Client();
    let fingerprint: string | null = null;

    return new Promise<TestConnectionResult>((resolve) => {
      let settled = false;
      const done = (result: TestConnectionResult) => {
        if (settled) return;
        settled = true;
        this.hostKeyAnswers.delete(testId);
        client.end();
        resolve(result);
      };
      client.on('ready', () => {
        // Remember an accepted key for a saved server with an unchanged address.
        if (resolved.serverId && fingerprint) this.servers.setFingerprint(resolved.serverId, fingerprint);
        done({ ok: true, message: `Connected as ${resolved.username}. Everything works.`, fingerprint });
      });
      this.attach(client, resolved, testId, (fp) => {
        fingerprint = fp;
      }, (message) => done({ ok: false, message, fingerprint }));
    });
  }

  private attach(
    client: Client,
    target: Target,
    promptId: string,
    onFingerprint: (fp: string) => void,
    onFailure: (message: string) => void,
    onStage: (stage: SshStage) => void = () => undefined,
  ): void {
    let timer: NodeJS.Timeout | null = null;
    const startTimer = () => {
      timer = setTimeout(() => {
        onFailure("Timed out. The server isn't responding — check the address, port and firewall.");
        client.end();
      }, HANDSHAKE_TIMEOUT_MS);
    };
    const stopTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    client.on('ready', stopTimer);
    // TCP is up: key exchange (and host key check) starts. Handshake done: log in.
    client.on('connect', () => onStage('verify'));
    client.on('handshake', () => onStage('auth'));
    client.on('error', (err) => {
      stopTimer();
      onFailure(friendlySshError(err));
    });
    client.on('close', () => {
      stopTimer();
      this.hostKeyAnswers.delete(promptId);
      onFailure('The connection dropped. Check your network, then reconnect.');
    });
    client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      // Servers that offer password login only through keyboard-interactive (D-020).
      finish(prompts.map(() => target.secrets.password ?? ''));
    });

    const config: ConnectConfig = {
      host: target.host,
      port: target.port,
      username: target.username,
      password: target.secrets.password ?? undefined,
      privateKey: target.secrets.privateKey ?? undefined,
      passphrase: target.secrets.passphrase ?? undefined,
      tryKeyboard: true,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 3,
      // Our own timer handles timeouts so time spent on the host-key prompt doesn't count.
      readyTimeout: 10 * 60_000,
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
        const fingerprint = fingerprintOf(key);
        if (fingerprint === target.savedFingerprint) {
          onFingerprint(fingerprint);
          verify(true);
          return;
        }
        stopTimer();
        this.hostKeyAnswers.set(promptId, (accept) => {
          if (accept) {
            onFingerprint(fingerprint);
            startTimer();
          }
          verify(accept);
        });
        this.emit('ssh:host-key', {
          tabId: promptId,
          serverId: target.serverId ?? '',
          host: `${target.host}:${target.port}`,
          fingerprint,
          previousFingerprint: target.savedFingerprint,
        });
      },
    };

    startTimer();
    try {
      client.connect(config);
    } catch (err) {
      stopTimer();
      onFailure(friendlySshError(err as Error));
    }
  }

  private async savedTarget(serverId: string): Promise<Target> {
    const { record } = this.servers.get(serverId);
    return {
      serverId,
      host: record.host,
      port: record.port,
      username: record.username,
      savedFingerprint: record.hostKeyFingerprint,
      secrets: await this.servers.secretsFor(record),
    };
  }

  /** Unsaved form values; empty secret fields fall back to the saved server's secrets. */
  private async formTarget(input: ServerForm, serverId: string | null): Promise<Target> {
    const form = serverFormSchema.parse(input);
    const saved = serverId ? this.servers.get(serverId).record : null;
    const savedSecrets = saved && saved.authType === form.authType ? await this.servers.secretsFor(saved) : null;
    const sameEndpoint = saved !== null && saved.host === form.host && saved.port === form.port;
    return {
      serverId: sameEndpoint ? serverId : null,
      host: form.host,
      port: form.port,
      username: form.username,
      savedFingerprint: sameEndpoint ? saved.hostKeyFingerprint : null,
      secrets:
        form.authType === 'password'
          ? { password: form.password || savedSecrets?.password || null, privateKey: null, passphrase: null }
          : {
              password: null,
              privateKey: form.privateKey?.trim() || savedSecrets?.privateKey || null,
              passphrase: form.passphrase || savedSecrets?.passphrase || null,
            },
    };
  }

  private close(tabId: string): void {
    const session = this.sessions.get(tabId);
    if (!session) return;
    session.closedByUser = true;
    this.sessions.delete(tabId);
    this.answerHostKey(tabId, false);
    session.client.end();
  }

  private stage(tabId: string, stage: SshStage): void {
    this.emit('ssh:status', { tabId, status: 'connecting', message: null, stage });
  }

  private status(tabId: string, status: DesktopEvents['ssh:status']['status'], message: string | null): void {
    this.flush();
    this.emit('ssh:status', { tabId, status, message });
  }

  private output(tabId: string, data: string): void {
    if (!data) return;
    this.outBuffers.set(tabId, (this.outBuffers.get(tabId) ?? '') + data);
    this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    for (const [tabId, data] of this.outBuffers) this.emit('ssh:data', { tabId, data });
    this.outBuffers.clear();
  }
}
