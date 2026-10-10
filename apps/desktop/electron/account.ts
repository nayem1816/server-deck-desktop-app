import fs from 'node:fs';
import path from 'node:path';
import {
  authResponseSchema,
  createAccountVault,
  deriveAccountKeys,
  emailSchema,
  fromBase64,
  preloginResponseSchema,
  rewrapVaultForPassword,
  toBase64,
  unwrapVaultKey,
  unwrapVaultKeyWithRecovery,
  userSchema,
  VaultCryptoError,
  verifyResetCodeResponseSchema,
  type AuthResponse,
  type SessionInfo,
  type User,
} from '@serverdeck/shared';
import { ApiClient } from './apiClient';
import { DesktopError, fieldError, signedOutError } from './errors';
import { LocalDb } from './localdb';
import type { PersistedSession, SecureStore } from './secureStore';
import type { Vault } from './vault';

export const MIN_PASSWORD_LENGTH = 8;

export interface AccountDeps {
  apiUrl: string;
  store: SecureStore;
  vault: Vault;
  /** Folder for per-account local databases. */
  dataDir: string;
  deviceName: string;
  onSignedIn: () => void;
  onSignedOut: (reason: string) => void;
  fetchImpl?: typeof fetch;
}

function checkPassword(password: string, field = 'password'): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw fieldError(field, `Use at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (password.length > 1024) throw fieldError(field, 'Password is too long');
}

/**
 * Sign-up, login, session restore and account changes. The password never leaves this
 * process: only the derived authKey goes to the API (DECISIONS.md D-002).
 */
export class Account {
  readonly api: ApiClient;
  private session: PersistedSession | null = null;
  private localDb: LocalDb | null = null;
  private pendingReset: { email: string; resetToken: string; vaultKeyRecovery: string } | null =
    null;

  constructor(private readonly deps: AccountDeps) {
    this.api = new ApiClient(
      deps.apiUrl,
      {
        getRefreshToken: () => this.session?.refreshToken ?? null,
        setRefreshToken: (token) => {
          if (!this.session) return;
          this.session.refreshToken = token;
          deps.store.save(this.session);
        },
        onSessionEnded: (reason) => this.endSession(reason),
      },
      deps.fetchImpl,
    );
  }

  get isSignedIn(): boolean {
    return this.session !== null;
  }

  db(): LocalDb {
    if (!this.localDb) throw signedOutError();
    return this.localDb;
  }

  getSession(): SessionInfo | null {
    return this.session ? { user: this.session.user } : null;
  }

  /** "Stay logged in": works offline, the access token is fetched on first API call. */
  restore(): SessionInfo | null {
    const saved = this.deps.store.load();
    if (!saved) return null;
    this.session = saved;
    this.deps.vault.set(fromBase64(saved.vaultKey));
    this.openDb(saved.user.id, saved.vaultKeyVersion);
    this.deps.onSignedIn();
    return { user: saved.user };
  }

  async signup(input: { name: string; email: string; password: string }) {
    checkPassword(input.password);
    const vault = await createAccountVault(input.password);
    const res = authResponseSchema.parse(
      await this.api.request('/auth/signup', {
        method: 'POST',
        auth: false,
        body: {
          name: input.name,
          email: input.email,
          authKey: vault.authKey,
          kdfSalt: vault.kdfSalt,
          kdfParams: vault.kdfParams,
          vaultKeyWrapped: vault.vaultKeyWrapped,
          vaultKeyRecovery: vault.vaultKeyRecovery,
          deviceName: this.deps.deviceName,
        },
      }),
    );
    this.startSession(res, vault.vaultKey);
    return { user: res.user, recoveryKey: vault.recoveryKey };
  }

  async login(input: { email: string; password: string }): Promise<SessionInfo> {
    const email = emailSchema.parse(input.email);
    const keys = await this.deriveKeys(email, input.password);
    const res = authResponseSchema.parse(
      await this.api.request('/auth/login', {
        method: 'POST',
        auth: false,
        body: { email, authKey: keys.authKey, deviceName: this.deps.deviceName },
      }),
    );
    const vaultKey = await unwrapVaultKey(keys.wrapKey, res.vault.vaultKeyWrapped);
    keys.wrapKey.fill(0);
    this.startSession(res, vaultKey);
    return { user: res.user };
  }

  async logout(): Promise<void> {
    const refreshToken = this.session?.refreshToken;
    if (refreshToken) {
      // Best effort: logging out must work offline too.
      await this.api
        .request('/auth/logout', { method: 'POST', auth: false, body: { refreshToken } })
        .catch(() => undefined);
    }
    this.endSession('');
  }

  async logoutAll(): Promise<void> {
    await this.api.request('/auth/logout-all', { method: 'POST' });
    this.endSession('');
  }

  async requestPasswordReset(email: string): Promise<void> {
    await this.api.request('/auth/forgot-password', {
      method: 'POST',
      auth: false,
      body: { email: emailSchema.parse(email) },
    });
  }

  async verifyResetCode(email: string, code: string): Promise<void> {
    const normalized = emailSchema.parse(email);
    const res = verifyResetCodeResponseSchema.parse(
      await this.api.request('/auth/reset-password/verify', {
        method: 'POST',
        auth: false,
        body: { email: normalized, code: code.trim() },
      }),
    );
    this.pendingReset = { email: normalized, ...res };
  }

  async completePasswordReset(input: { newPassword: string; recoveryKey: string | null }) {
    const reset = this.pendingReset;
    if (!reset) {
      throw new DesktopError('INVALID_CODE', 'The reset session expired. Request a new code.');
    }
    checkPassword(input.newPassword, 'newPassword');

    let body: Record<string, unknown>;
    let newRecoveryKey: string | null = null;
    if (input.recoveryKey) {
      let vaultKey: Uint8Array;
      try {
        vaultKey = await unwrapVaultKeyWithRecovery(input.recoveryKey, reset.vaultKeyRecovery);
      } catch (err) {
        if (err instanceof VaultCryptoError) {
          throw fieldError('recoveryKey', "This recovery key doesn't match your account.");
        }
        throw err;
      }
      const rewrapped = await rewrapVaultForPassword(input.newPassword, vaultKey);
      body = {
        resetToken: reset.resetToken,
        newAuthKey: rewrapped.authKey,
        newKdfSalt: rewrapped.kdfSalt,
        newKdfParams: rewrapped.kdfParams,
        newVaultKeyWrapped: rewrapped.vaultKeyWrapped,
        secretsReset: false,
      };
    } else {
      const vault = await createAccountVault(input.newPassword);
      newRecoveryKey = vault.recoveryKey;
      body = {
        resetToken: reset.resetToken,
        newAuthKey: vault.authKey,
        newKdfSalt: vault.kdfSalt,
        newKdfParams: vault.kdfParams,
        newVaultKeyWrapped: vault.vaultKeyWrapped,
        secretsReset: true,
        newVaultKeyRecovery: vault.vaultKeyRecovery,
      };
    }

    await this.api.request('/auth/reset-password', { method: 'POST', auth: false, body });
    this.pendingReset = null;
    if (this.session) this.endSession('');
    const { user } = await this.login({ email: reset.email, password: input.newPassword });
    return { user, newRecoveryKey };
  }

  async updateName(name: string): Promise<User> {
    const user = userSchema.parse(await this.api.request('/me', { method: 'PATCH', body: { name } }));
    this.updateUser(user);
    return user;
  }

  async changeEmail(input: { email: string; password: string }): Promise<User> {
    const current = this.requireSession();
    const keys = await this.deriveKeys(current.user.email, input.password);
    const user = userSchema.parse(
      await this.api.request('/me', {
        method: 'PATCH',
        body: { email: input.email, currentAuthKey: keys.authKey },
      }),
    );
    this.updateUser(user);
    return user;
  }

  async changePassword(input: { currentPassword: string; newPassword: string }): Promise<void> {
    const current = this.requireSession();
    checkPassword(input.newPassword, 'newPassword');
    const keys = await this.deriveKeys(current.user.email, input.currentPassword);
    const vaultKey = this.deps.vault.exportKey();
    const rewrapped = await rewrapVaultForPassword(input.newPassword, vaultKey);
    const res = authResponseSchema.parse(
      await this.api.request('/me/password', {
        method: 'POST',
        body: {
          currentAuthKey: keys.authKey,
          newAuthKey: rewrapped.authKey,
          newKdfSalt: rewrapped.kdfSalt,
          newKdfParams: rewrapped.kdfParams,
          newVaultKeyWrapped: rewrapped.vaultKeyWrapped,
          deviceName: this.deps.deviceName,
        },
      }),
    );
    this.startSession(res, vaultKey);
  }

  async deleteAccount(password: string): Promise<void> {
    const current = this.requireSession();
    const keys = await this.deriveKeys(current.user.email, password);
    await this.api.request('/me', { method: 'DELETE', body: { authKey: keys.authKey } });
    const file = this.dbFile(current.user.id);
    this.endSession('');
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
  }

  private async deriveKeys(email: string, password: string) {
    const pre = preloginResponseSchema.parse(
      await this.api.request('/auth/prelogin', { method: 'POST', auth: false, body: { email } }),
    );
    try {
      return await deriveAccountKeys(password, pre.kdfSalt, pre.kdfParams);
    } catch {
      throw new DesktopError('INVALID_CREDENTIALS', 'Email or password is wrong');
    }
  }

  private requireSession(): PersistedSession {
    if (!this.session) throw signedOutError();
    return this.session;
  }

  private updateUser(user: User): void {
    const session = this.requireSession();
    session.user = user;
    this.deps.store.save(session);
  }

  private startSession(res: AuthResponse, vaultKey: Uint8Array): void {
    const sameUser = this.session?.user.id === res.user.id;
    if (!sameUser) this.closeDb();

    this.session = {
      user: res.user,
      refreshToken: res.refreshToken,
      vaultKey: toBase64(vaultKey),
      vaultKeyVersion: res.vault.vaultKeyVersion,
    };
    this.api.setAccessToken(res.accessToken);
    this.deps.vault.set(new Uint8Array(vaultKey));
    this.deps.store.save(this.session);
    if (!sameUser) this.openDb(res.user.id, res.vault.vaultKeyVersion);
    this.deps.onSignedIn();
  }

  private endSession(reason: string): void {
    if (!this.session) return;
    this.session = null;
    this.api.setAccessToken(null);
    this.deps.vault.clear();
    this.deps.store.clear();
    this.closeDb();
    this.deps.onSignedOut(reason);
  }

  private dbFile(userId: string): string {
    return path.join(this.deps.dataDir, `${userId}.sqlite`);
  }

  private openDb(userId: string, vaultKeyVersion: number): void {
    fs.mkdirSync(this.deps.dataDir, { recursive: true });
    const db = new LocalDb(this.dbFile(userId));
    // The vault key was replaced (reset without recovery key): local ciphertext is unreadable.
    const previous = db.getMeta('vaultKeyVersion');
    if (previous !== null && Number(previous) !== vaultKeyVersion) db.clearAllSecrets();
    db.setMeta('vaultKeyVersion', String(vaultKeyVersion));
    this.localDb = db;
  }

  private closeDb(): void {
    this.localDb?.close();
    this.localDb = null;
  }
}
