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
  createBlackboard: (swarmId, baseCwd, doc) =>
    ipcRenderer.invoke(IPC.createBlackboard, swarmId, baseCwd, doc),
  isGitRepo: (dir) => ipcRenderer.invoke(IPC.isGitRepo, dir),
  createWorktree: (repoDir, worktreeSubdir, branch) =>
    ipcRenderer.invoke(IPC.createWorktree, repoDir, worktreeSubdir, branch),
  removeWorktree: (repoDir, worktreeDir) =>
    ipcRenderer.invoke(IPC.removeWorktree, repoDir, worktreeDir),
  reviewWorktree: (repoDir, branch, worktreeDir) =>
    ipcRenderer.invoke(IPC.reviewWorktree, repoDir, branch, worktreeDir),
  mergeWorktree: (repoDir, branch, worktreeDir, opts) =>
    ipcRenderer.invoke(IPC.mergeWorktree, repoDir, branch, worktreeDir, opts),
  discardWorktree: (repoDir, worktreeDir, branch) =>
    ipcRenderer.invoke(IPC.discardWorktree, repoDir, worktreeDir, branch),
  captureSessionId: (paneSessionId, cwd) =>
    ipcRenderer.invoke(IPC.captureSessionId, paneSessionId, cwd),
  hasConversation: (claudeSessionId, cwd) =>
    ipcRenderer.invoke(IPC.hasConversation, claudeSessionId, cwd),
  exportConversations: (items) =>
    ipcRenderer.invoke(IPC.exportConversations, items),
  importConversations: (refs) =>
    ipcRenderer.invoke(IPC.importConversations, refs),
  readContextHealth: (claudeSessionId, cwd) =>
    ipcRenderer.invoke(IPC.readContextHealth, claudeSessionId, cwd),
};

contextBridge.exposeInMainWorld('paneApi', api);
