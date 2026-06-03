/**
 * Electron main process. Creates the window, owns the node-pty host, and
 * persists workspace state to a JSON file in userData. The renderer reuses
 * @app/ui + @app/core unchanged; everything Electron-specific lives here and in
 * the preload (PRD §11 — the host seam).
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { app, BrowserWindow, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import { parseWorkspaceState, type SpawnOptions, type WorkspaceState } from '@app/core';
import { IPC } from '../shared/ipc.js';
import { PtyHost } from './pty-host.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Persisted state file. Mirrors WebPersistence's localStorage key, on disk. */
function stateFile(): string {
  return path.join(app.getPath('userData'), 'workspace-state.v2.json');
}

async function loadState(): Promise<WorkspaceState | null> {
  try {
    const raw = await fs.readFile(stateFile(), 'utf8');
    return parseWorkspaceState(JSON.parse(raw));
  } catch {
    // missing / corrupt -> app falls back to a default workspace (US-6.1)
    return null;
  }
}

async function saveState(state: WorkspaceState): Promise<void> {
  try {
    await fs.writeFile(stateFile(), JSON.stringify(state), 'utf8');
  } catch {
    // disk error — non-fatal for an in-memory session
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#0e1116',
    title: 'Pane',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // let the preload use Node builtins (os.homedir)
    },
  });

  const pty = new PtyHost(win.webContents);

  // Renderer -> main (fire-and-forget terminal I/O).
  ipcMain.on(IPC.spawn, (_e, opts: SpawnOptions) => pty.spawn(opts));
  ipcMain.on(IPC.write, (_e, sessionId: string, data: string) =>
    pty.write(sessionId, data),
  );
  ipcMain.on(IPC.resize, (_e, sessionId: string, cols: number, rows: number) =>
    pty.resize(sessionId, cols, rows),
  );
  ipcMain.on(IPC.kill, (_e, sessionId: string) => pty.kill(sessionId));

  win.on('closed', () => pty.killAll());

  // electron-vite serves the renderer from a dev server URL; production loads
  // the built HTML file.
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

// Persistence handlers are global (not per-window): request/response via invoke.
ipcMain.handle(IPC.loadState, () => loadState());
ipcMain.handle(IPC.saveState, (_e, state: WorkspaceState) => saveState(state));

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
