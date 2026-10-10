// Starts Next.js dev server + Electron. Usage: pnpm dev (API should run separately: pnpm dev:api).
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';

const require = createRequire(import.meta.url);
const PORT = 3000;
const isWindows = process.platform === 'win32';

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.end();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function waitForPort(port) {
  while (!(await portInUse(port))) await new Promise((r) => setTimeout(r, 300));
}

/** On Windows, killing the shell leaves Next running; kill the whole process tree. */
function killTree(child) {
  if (!child.pid) return;
  if (isWindows) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}

if (await portInUse(PORT)) {
  console.error(
    `Port ${PORT} is already in use (probably a leftover Next.js dev server).\n` +
      `Stop it first, e.g. on Windows: for /f "tokens=5" %p in ('netstat -ano ^| findstr :${PORT}') do taskkill /PID %p /T /F`,
  );
  process.exit(1);
}

const build = spawnSync('node', ['scripts/build-electron.mjs'], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

const next = spawn('pnpm', ['exec', 'next', 'dev', 'web', '-p', String(PORT)], {
  stdio: 'inherit',
  shell: isWindows,
});
await waitForPort(PORT);
// Compile the first page before the window opens, so it doesn't sit on a blank screen.
await fetch(`http://localhost:${PORT}/login`).catch(() => undefined);

// VS Code's terminal sets ELECTRON_RUN_AS_NODE, which would start Electron as plain Node.
const env = { ...process.env, SERVERDECK_DEV_URL: `http://localhost:${PORT}` };
delete env.ELECTRON_RUN_AS_NODE;

const electron = spawn(require('electron'), ['.'], { stdio: 'inherit', env });
const shutdown = (code) => {
  killTree(next);
  process.exit(code ?? 0);
};
electron.on('exit', shutdown);
process.on('SIGINT', () => {
  electron.kill();
  shutdown(0);
});
