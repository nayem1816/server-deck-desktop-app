import fs from 'node:fs/promises';
import path from 'node:path';
import { protocol } from 'electron';

export const APP_SCHEME = 'app';
export const APP_ORIGIN = `${APP_SCHEME}://serverdeck`;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

// Next's static export inlines bootstrap scripts, hence 'unsafe-inline' for scripts.
// The renderer talks to nothing over the network: all I/O goes through IPC.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Must run before app.whenReady(). */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

/** Serves the Next.js static export (D-018) with clean URLs: /login → login.html. */
export function serveStaticExport(rootDir: string): void {
  const root = path.resolve(rootDir);

  protocol.handle(APP_SCHEME, async (request) => {
    const { pathname } = new URL(request.url);
    const relative = decodeURIComponent(pathname).replace(/^\/+/, '');
    const base = path.resolve(root, relative);
    if (base !== root && !base.startsWith(root + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }

    const candidates = path.extname(base)
      ? [base]
      : [`${base}.html`, path.join(base, 'index.html')];
    for (const file of candidates) {
      try {
        const body = await fs.readFile(file);
        return new Response(body, {
          headers: {
            'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
            'Content-Security-Policy': CSP,
          },
        });
      } catch {
        // try next candidate
      }
    }
    const notFound = await fs.readFile(path.join(root, '404.html')).catch(() => 'Not found');
    return new Response(notFound, {
      status: 404,
      headers: { 'Content-Type': MIME['.html']!, 'Content-Security-Policy': CSP },
    });
  });
}
