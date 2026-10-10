import { apiErrorSchema, tokensResponseSchema } from '@serverdeck/shared';
import { DesktopError, offlineError, signedOutError } from './errors';

export interface TokenHolder {
  getRefreshToken(): string | null;
  setRefreshToken(token: string): void;
  /** The refresh token was rejected: the user must log in again. */
  onSessionEnded(reason: string): void;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Send the access token (default true). */
  auth?: boolean;
}

const TIMEOUT_MS = 20_000;

/** HTTP client for the ServerDeck API. Runs in the main process only (D-016). */
export class ApiClient {
  private accessToken: string | null = null;
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly tokens: TokenHolder,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  setAccessToken(token: string | null): void {
    this.accessToken = token;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const auth = options.auth ?? true;
    if (auth && !this.accessToken) await this.refresh();

    let res = await this.send(path, options, auth);
    // Only token problems trigger a refresh; e.g. a wrong current password is also a 401.
    if (auth && res.status === 401 && (await this.isTokenError(res))) {
      await this.refresh();
      res = await this.send(path, options, auth);
    }
    return this.parse<T>(res);
  }

  private async isTokenError(res: Response): Promise<boolean> {
    const body = apiErrorSchema.safeParse(await res.clone().json().catch(() => null));
    return !body.success || ['TOKEN_EXPIRED', 'UNAUTHORIZED'].includes(body.data.error.code);
  }

  /** Single-flight: concurrent 401s share one refresh call. */
  refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const refreshToken = this.tokens.getRefreshToken();
    if (!refreshToken) throw signedOutError();

    const res = await this.send('/auth/refresh', { method: 'POST', body: { refreshToken } }, false);
    if (res.status === 401) {
      this.accessToken = null;
      const body = await this.parse<never>(res).catch((err: unknown) => err);
      const reason =
        body instanceof DesktopError && body.code === 'TOKEN_REUSED'
          ? 'Your session was used on another device. Please log in again.'
          : 'Your session expired. Please log in again.';
      this.tokens.onSessionEnded(reason);
      throw signedOutError();
    }
    const tokens = tokensResponseSchema.parse(await this.parse(res));
    this.accessToken = tokens.accessToken;
    this.tokens.setRefreshToken(tokens.refreshToken);
  }

  private async send(path: string, options: RequestOptions, auth: boolean): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth && this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw offlineError();
    }
  }

  private async parse<T>(res: Response): Promise<T> {
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      // Fall through: non-JSON response (proxy error page etc.)
    }
    if (res.ok) return json as T;

    const parsed = apiErrorSchema.safeParse(json);
    if (parsed.success) {
      const { code, message, details } = parsed.data.error;
      throw new DesktopError(code, message, details, res.status);
    }
    if (res.status >= 500) {
      throw new DesktopError(
        'SERVER_ERROR',
        'The ServerDeck server had a problem. Your changes are saved and will sync later.',
        undefined,
        res.status,
      );
    }
    throw new DesktopError('INTERNAL', `Unexpected response (${res.status})`, undefined, res.status);
  }
}
