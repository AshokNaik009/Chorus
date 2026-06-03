/**
 * Preload bridge. Runs with Node access (sandbox:false) but in an isolated
 * context (contextIsolation:true), and exposes exactly one object —
 * `window.paneApi` — to the renderer. The renderer never touches ipcRenderer or
 * Node directly; this is the whole attack surface between them.
 */
import os from 'node:os';
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IPC,
  type PaneApi,
  type PtyDataEvent,
  type PtyExitEvent,
} from '../shared/ipc.js';

const api: PaneApi = {
  homeDir: os.homedir(),
  spawn: (opts) => ipcRenderer.send(IPC.spawn, opts),
  write: (sessionId, data) => ipcRenderer.send(IPC.write, sessionId, data),
  resize: (sessionId, cols, rows) =>
    ipcRenderer.send(IPC.resize, sessionId, cols, rows),
  kill: (sessionId) => ipcRenderer.send(IPC.kill, sessionId),
  onData: (cb) => {
    const listener = (_e: IpcRendererEvent, payload: PtyDataEvent) => cb(payload);
    ipcRenderer.on(IPC.data, listener);
    return () => ipcRenderer.removeListener(IPC.data, listener);
  },
  onExit: (cb) => {
    const listener = (_e: IpcRendererEvent, payload: PtyExitEvent) => cb(payload);
    ipcRenderer.on(IPC.exit, listener);
    return () => ipcRenderer.removeListener(IPC.exit, listener);
  },
  loadState: () => ipcRenderer.invoke(IPC.loadState),
  saveState: (state) => ipcRenderer.invoke(IPC.saveState, state),
};

contextBridge.exposeInMainWorld('paneApi', api);
