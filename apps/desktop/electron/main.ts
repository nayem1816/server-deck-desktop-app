import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  safeStorage,
  shell,
  type MenuItemConstructorOptions,
} from 'electron';
import {
  historyListResponseSchema,
  type DesktopEvents,
  type ServerForm,
} from '@serverdeck/shared';
import { Account } from './account';
import { DataTransfer } from './dataTransfer';
import { DesktopError } from './errors';
import { registerHandlers } from './ipc';
import { APP_ORIGIN, registerAppScheme, serveStaticExport } from './protocol';
import { SecureStore } from './secureStore';
import { ServerRepo } from './servers';
import { SshManager } from './ssh';
import { SyncEngine } from './sync';
import { Vault } from './vault';

/** Set by scripts/dev.mjs; in a packaged app the static export is served from app://. */
const DEV_URL = process.env.SERVERDECK_DEV_URL;
const API_URL = process.env.SERVERDECK_API_URL ?? 'http://localhost:4000';

// Separate profile folder, e.g. to run two "devices" side by side when testing sync.
// Must be set before the single-instance lock, which is per profile.
if (process.env.SERVERDECK_USER_DATA) app.setPath('userData', process.env.SERVERDECK_USER_DATA);

registerAppScheme();
if (!app.requestSingleInstanceLock()) app.quit();

let mainWindow: BrowserWindow | null = null;

function broadcast<K extends keyof DesktopEvents>(event: K, payload: DesktopEvents[K]): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(`evt:${event}`, payload);
}

function createServices() {
  const userData = app.getPath('userData');
  const vault = new Vault();
  const store = new SecureStore(path.join(userData, 'session.bin'), {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (data) => safeStorage.decryptString(data),
  });

  // Assigned after Account, which needs these in its callbacks.
  // eslint-disable-next-line prefer-const
  let sync: SyncEngine;
  // eslint-disable-next-line prefer-const
  let ssh: SshManager;
  const account = new Account({
    apiUrl: API_URL,
    store,
    vault,
    dataDir: path.join(userData, 'accounts'),
    deviceName: os.hostname(),
    onSignedIn: () => {
      sync.stop();
      sync.start();
      broadcast('servers:changed', null);
    },
    onSignedOut: (reason) => {
      sync.stop();
      ssh.disconnectAll();
      broadcast('auth:signed-out', { reason });
    },
  });
  sync = new SyncEngine({
    api: account.api,
    db: () => account.db(),
    onState: (state) => broadcast('sync:state', state),
    onDataChanged: () => broadcast('servers:changed', null),
  });
  const servers = new ServerRepo(
    () => account.db(),
    vault,
    () => {
      broadcast('servers:changed', null);
      sync.notifyLocalChange();
    },
  );
  ssh = new SshManager(servers, broadcast);
  const data = new DataTransfer(servers, {
    chooseSavePath: async (defaultName) => {
      const result = await dialog.showSaveDialog({
        title: 'Export servers',
        defaultPath: path.join(app.getPath('documents'), defaultName),
        filters: [{ name: 'ServerDeck export', extensions: ['json'] }],
      });
      return result.canceled ? null : (result.filePath ?? null);
    },
    chooseOpenPath: async () => {
      const result = await dialog.showOpenDialog({
        title: 'Import servers',
        filters: [{ name: 'ServerDeck export', extensions: ['json'] }],
        properties: ['openFile'],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  });
  return { account, sync, servers, ssh, data };
}

function registerIpc({ account, sync, servers, ssh, data }: ReturnType<typeof createServices>): void {
  registerHandlers({
    auth: {
      getSession: () => account.getSession(),
      signup: (input) => account.signup(input),
      login: (input) => account.login(input),
      logout: () => account.logout(),
      logoutAll: () => account.logoutAll(),
      requestPasswordReset: (email) => account.requestPasswordReset(email),
      verifyResetCode: (email, code) => account.verifyResetCode(email, code),
      completePasswordReset: (input) => account.completePasswordReset(input),
      updateName: (name) => account.updateName(name),
      changeEmail: (input) => account.changeEmail(input),
      changePassword: (input) => account.changePassword(input),
      deleteAccount: (password) => account.deleteAccount(password),
    },
    servers: {
      list: () => servers.list(),
      create: (form: ServerForm) => servers.create(form),
      update: (id, form) => servers.update(id, form),
      duplicate: (id) => servers.duplicate(id),
      remove: (id) => servers.remove(id),
      restore: (id) => servers.restore(id),
      listTrash: () => servers.listTrash(),
      listHistory: async () =>
        historyListResponseSchema.parse(await account.api.request('/servers/history')).entries,
      restoreHistory: async (historyId) => {
        await account.api.request(`/servers/history/${encodeURIComponent(historyId)}/restore`, {
          method: 'POST',
        });
        await sync.syncNow();
      },
      pickKeyFile: async () => {
        const result = await dialog.showOpenDialog({
          title: 'Choose a private key',
          defaultPath: path.join(os.homedir(), '.ssh'),
          properties: ['openFile', 'showHiddenFiles'],
        });
        const file = result.filePaths[0];
        if (result.canceled || !file) return null;
        const stat = await fs.stat(file);
        if (stat.size > 64 * 1024) {
          throw new DesktopError('VALIDATION_ERROR', 'That file is too large to be a private key.');
        }
        return fs.readFile(file, 'utf8');
      },
    },
    sync: {
      getState: () => sync.getState(),
      syncNow: () => sync.syncNow(),
    },
    data: {
      exportToFile: (passphrase) => data.exportToFile(passphrase),
      importFromFile: (passphrase) => data.importFromFile(passphrase),
    },
    ssh: {
      test: (target) => ssh.test(target),
      connect: (tabId, serverId, size) => ssh.connect(tabId, serverId, size),
      write: (tabId, text) => ssh.write(tabId, text),
      resize: (tabId, size) => ssh.resize(tabId, size),
      disconnect: (tabId) => ssh.disconnect(tabId),
      answerHostKey: (tabId, accept) => ssh.answerHostKey(tabId, accept),
    },
    clipboard: {
      readText: () => clipboard.readText(),
      writeText: (text) => clipboard.writeText(text),
    },
  });
}

function buildMenu(): void {
  // No default "Close Window" on Ctrl/Cmd+W: the renderer uses it to close terminal tabs.
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        ...(app.isPackaged
          ? []
          : [{ role: 'reload' as const }, { role: 'toggleDevTools' as const }]),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(sync: SyncEngine, isSignedIn: () => boolean): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0F1115',
    autoHideMenuBar: true,
    title: 'ServerDeck',
    // Taskbar/window icon in development and on Linux; packaged Windows/macOS use the app icon.
    icon: path.join(app.getAppPath(), 'web', app.isPackaged ? 'out' : 'public', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const allowedOrigin = DEV_URL ? new URL(DEV_URL).origin : APP_ORIGIN;
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== allowedOrigin) event.preventDefault();
  });

  let lastFocusSync = 0;
  win.on('focus', () => {
    if (isSignedIn() && Date.now() - lastFocusSync > 10_000) {
      lastFocusSync = Date.now();
      void sync.syncNow();
    }
  });
  win.once('ready-to-show', () => win.show());
  // The dev server may still be starting: retry instead of leaving an empty window.
  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* ABORTED: superseded navigation */) return;
    console.error(`Failed to load ${url}: ${description}. Retrying…`);
    setTimeout(() => void win.loadURL(DEV_URL ?? `${APP_ORIGIN}/`), 1000);
  });

  void win.loadURL(DEV_URL ?? `${APP_ORIGIN}/`);
  return win;
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

void app.whenReady().then(() => {
  if (!DEV_URL) serveStaticExport(path.join(app.getAppPath(), 'web', 'out'));
  buildMenu();
  const services = createServices();
  registerIpc(services);
  services.account.restore();

  mainWindow = createWindow(services.sync, () => services.account.isSignedIn);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow(services.sync, () => services.account.isSignedIn);
    }
  });
});
