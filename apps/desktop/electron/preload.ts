import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

/**
 * Minimal bridge: the renderer can only make RPC calls by name and listen to events.
 * The typed window.api is built on top of this in web/lib/desktop.ts.
 */
const bridge = {
  invoke: (channel: string, args: unknown[]) => ipcRenderer.invoke('rpc', channel, args),
  send: (channel: string, args: unknown[]) => ipcRenderer.send('rpc-send', channel, args),
  on: (event: string, listener: (payload: unknown) => void) => {
    const wrapped = (_e: IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on(`evt:${event}`, wrapped);
    return () => {
      ipcRenderer.removeListener(`evt:${event}`, wrapped);
    };
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld('serverdeck', bridge);

export type Bridge = typeof bridge;
