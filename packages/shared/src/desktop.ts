/**
 * Contract between the Electron main process and the renderer (window.api).
 * The renderer never sees the vault key or decrypted secrets (DECISIONS.md D-016).
 */
import type { User } from './schemas/user';
import type { AuthType, ServerForm } from './schemas/server';

export interface DesktopErrorShape {
  code: string;
  message: string;
  details?: unknown;
}

/** IPC can't carry custom error fields, so every call resolves to a result. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: DesktopErrorShape };

/** A server as the UI sees it: no ciphertext, just whether secrets are present. */
export interface ServerView {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  hasSecret: boolean;
  hasPassphrase: boolean;
  hostKeyFingerprint: string | null;
  tags: string[];
  notes: string | null;
  lastConnectedAt: string | null;
  updatedAt: string;
  deletedAt: string | null;
  /** Has local changes not yet confirmed by the API. */
  pending: boolean;
}

/** Form for edits: empty secret fields mean "keep the saved value". */
export type ServerUpdateForm = ServerForm;

export interface HistoryEntry {
  id: string;
  serverId: string;
  name: string;
  host: string;
  reason: 'conflict' | 'restore';
  createdAt: string;
}

export type SyncStatus = 'synced' | 'syncing' | 'offline' | 'error' | 'signed-out';

export interface SyncState {
  status: SyncStatus;
  pendingChanges: number;
  lastSyncedAt: string | null;
  message: string | null;
}

export interface SessionInfo {
  user: User;
}

export type SshStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface HostKeyPrompt {
  tabId: string;
  serverId: string;
  host: string;
  fingerprint: string;
  /** Set when the server's key differs from the one saved earlier. */
  previousFingerprint: string | null;
}

/** Steps of a connection, in order, reported while status is 'connecting'. */
export type SshStage = 'network' | 'verify' | 'auth' | 'shell';

export interface SshStatusEvent {
  tabId: string;
  status: SshStatus;
  message: string | null;
  stage?: SshStage;
}

export interface SshDataEvent {
  tabId: string;
  data: string;
}

export interface DesktopEvents {
  'sync:state': SyncState;
  'servers:changed': null;
  'auth:signed-out': { reason: string };
  'ssh:status': SshStatusEvent;
  'ssh:data': SshDataEvent;
  'ssh:host-key': HostKeyPrompt;
}

export interface TestConnectionResult {
  ok: boolean;
  message: string;
  fingerprint: string | null;
}

export interface DesktopApi {
  auth: {
    getSession(): Promise<SessionInfo | null>;
    signup(input: { name: string; email: string; password: string }): Promise<{
      user: User;
      recoveryKey: string;
    }>;
    login(input: { email: string; password: string }): Promise<SessionInfo>;
    logout(): Promise<void>;
    logoutAll(): Promise<void>;
    requestPasswordReset(email: string): Promise<void>;
    verifyResetCode(email: string, code: string): Promise<void>;
    /** recoveryKey null = reset without it; saved secrets are wiped and a new recovery key is made. */
    completePasswordReset(input: { newPassword: string; recoveryKey: string | null }): Promise<{
      user: User;
      newRecoveryKey: string | null;
    }>;
    updateName(name: string): Promise<User>;
    changeEmail(input: { email: string; password: string }): Promise<User>;
    changePassword(input: { currentPassword: string; newPassword: string }): Promise<void>;
    deleteAccount(password: string): Promise<void>;
  };
  servers: {
    list(): Promise<ServerView[]>;
    create(form: ServerForm): Promise<ServerView>;
    update(id: string, form: ServerUpdateForm): Promise<ServerView>;
    duplicate(id: string): Promise<ServerView>;
    remove(id: string): Promise<void>;
    restore(id: string): Promise<void>;
    listTrash(): Promise<ServerView[]>;
    listHistory(): Promise<HistoryEntry[]>;
    restoreHistory(historyId: string): Promise<void>;
    /** Opens a file dialog and returns the file's text, or null if cancelled. */
    pickKeyFile(): Promise<string | null>;
  };
  sync: {
    getState(): Promise<SyncState>;
    syncNow(): Promise<void>;
  };
  data: {
    exportToFile(passphrase: string): Promise<{ path: string } | null>;
    importFromFile(passphrase: string): Promise<{ imported: number } | null>;
  };
  ssh: {
    /** Tests a saved server or unsaved form values. */
    test(target: { serverId: string } | { form: ServerForm; serverId?: string }): Promise<TestConnectionResult>;
    connect(tabId: string, serverId: string, size: { cols: number; rows: number }): Promise<void>;
    write(tabId: string, data: string): void;
    resize(tabId: string, size: { cols: number; rows: number }): void;
    disconnect(tabId: string): Promise<void>;
    answerHostKey(tabId: string, accept: boolean): void;
  };
  clipboard: {
    readText(): Promise<string>;
    writeText(text: string): Promise<void>;
  };
  on<K extends keyof DesktopEvents>(
    event: K,
    listener: (payload: DesktopEvents[K]) => void,
  ): () => void;
}
