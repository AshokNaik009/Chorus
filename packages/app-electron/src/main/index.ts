/**
 * Electron main process. Creates the window, owns the node-pty host, and
 * persists workspace state to a JSON file in userData. The renderer reuses
 * @app/ui + @app/core unchanged; everything Electron-specific lives here and in
 * the preload (PRD §11 — the host seam).
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { app, BrowserWindow, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import {
  claudeProjectSlug,
  parseWorkspaceState,
  type ConversationRef,
  type ImportConversationsResult,
  type SpawnOptions,
  type WorkspaceState,
} from '@app/core';
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
    title: 'Chorus',
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

/** Expand `~` and fall back to $HOME so a bad base never throws (mirrors pty-host). */
function resolveBase(input: string): string {
  const home = os.homedir();
  let c = (input ?? '').trim();
  if (!c || c === '~' || c === '~/') return home;
  if (c.startsWith('~/')) c = path.join(home, c.slice(2));
  else if (!path.isAbsolute(c)) c = path.resolve(home, c);
  return c;
}

// Swarm blackboard: create <base>/.chorus-swarm-<id>/ + CHORUS_SWARM.md (Epic 10).
ipcMain.handle(
  IPC.createBlackboard,
  async (_e, swarmId: string, baseCwd: string, doc: string): Promise<string | null> => {
    try {
      const dir = path.join(resolveBase(baseCwd), `.chorus-swarm-${swarmId}`);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'CHORUS_SWARM.md'), doc, 'utf8');
      return dir;
    } catch {
      return null;
    }
  },
);

// ---- Layer-2 memory portability (PRD Epic 11 / M12). All touch ~/.claude. ----

function projectsDir(absCwd: string): string {
  return path.join(os.homedir(), '.claude', 'projects', claudeProjectSlug(absCwd));
}

// VS-11.A: the transcript filename IS the session id; the newest .jsonl in the
// project's slug dir is this pane's conversation. Best-effort; null on any miss.
ipcMain.handle(
  IPC.captureSessionId,
  async (_e, _paneSessionId: string, cwd: string): Promise<string | null> => {
    try {
      const dir = projectsDir(resolveBase(cwd));
      const files = await fs.readdir(dir);
      const jsonl = files.filter((f) => f.endsWith('.jsonl'));
      if (jsonl.length === 0) return null;
      const stats = await Promise.all(
        jsonl.map(async (f) => ({
          id: f.replace(/\.jsonl$/, ''),
          mtime: (await fs.stat(path.join(dir, f))).mtimeMs,
        })),
      );
      stats.sort((a, b) => b.mtime - a.mtime);
      return stats[0].id;
    } catch {
      return null;
    }
  },
);

ipcMain.handle(
  IPC.exportConversations,
  async (
    _e,
    items: { sessionId: string; cwd: string }[],
  ): Promise<ConversationRef[]> => {
    const out: ConversationRef[] = [];
    for (const it of items) {
      try {
        const abs = resolveBase(it.cwd);
        const file = path.join(projectsDir(abs), `${it.sessionId}.jsonl`);
        const transcript = await fs.readFile(file, 'utf8');
        out.push({ sessionId: it.sessionId, originalProjectPath: abs, transcript });
      } catch {
        /* transcript missing — skip this one */
      }
    }
    return out;
  },
);

// `refs` arrive with project paths already remapped for this machine. Never
// silently overwrites — an existing transcript is backed up (.bak) and skipped.
ipcMain.handle(
  IPC.importConversations,
  async (_e, refs: ConversationRef[]): Promise<ImportConversationsResult> => {
    let imported = 0;
    let skipped = 0;
    const warnings: string[] = [];
    for (const ref of refs) {
      try {
        const dir = projectsDir(ref.originalProjectPath);
        await fs.mkdir(dir, { recursive: true });
        const file = path.join(dir, `${ref.sessionId}.jsonl`);
        const exists = await fs
          .access(file)
          .then(() => true)
          .catch(() => false);
        if (exists) {
          await fs.copyFile(file, `${file}.bak`);
          skipped += 1;
          warnings.push(`Kept existing transcript ${ref.sessionId} (backed up .bak).`);
          continue;
        }
        await fs.writeFile(file, ref.transcript, 'utf8');
        imported += 1;
      } catch (e) {
        warnings.push(`Failed to import ${ref.sessionId}: ${(e as Error).message}`);
      }
    }
    return { imported, skipped, warnings };
  },
);

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
