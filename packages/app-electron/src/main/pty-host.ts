/**
 * PTY host for the Electron main process. Owns the node-pty child processes and
 * streams their I/O to the renderer over IPC.
 *
 * This is the Node-side twin of app-web's `server/index.ts`: identical spawn
 * logic (login+interactive shell, cwd resolution, Claude status hooks) — the
 * only difference is the transport (IPC `webContents.send` here, websockets
 * there). The pure, host-agnostic bits (`shellLaunchArgs`, `withClaudeHooks`,
 * `buildClaudeHookSettings`) come from @app/core so both hosts stay in sync.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import process from 'node:process';
import pty, { type IPty } from 'node-pty';
import type { WebContents } from 'electron';
import {
  buildClaudeHookSettings,
  shellLaunchArgs,
  withClaudeHooks,
  type SpawnOptions,
} from '@app/core';
import { IPC } from '../shared/ipc.js';

/**
 * Write the Claude Code status hooks (Notification/Stop -> OSC) to a temp file
 * once; every claude session is launched with `--settings <file>`. The OSC is
 * namespaced per stream, so one shared file serves all sessions.
 */
function installHooksFile(): string | null {
  try {
    const file = path.join(os.tmpdir(), 'pane-claude-hooks.json');
    fs.writeFileSync(file, JSON.stringify(buildClaudeHookSettings(), null, 2));
    return file;
  } catch {
    return null;
  }
}

function defaultShell(): string {
  if (process.platform === 'win32') return 'pwsh.exe';
  return process.env.SHELL || 'bash';
}

/**
 * node-pty does not expand `~` or resolve relative paths, and a non-existent
 * cwd makes the child exit immediately. Expand/resolve here and fall back to the
 * home directory so a bad path never kills the session.
 */
function resolveCwd(input: string | undefined): string {
  const home = os.homedir();
  let c = (input ?? '').trim();
  if (!c || c === '~' || c === '~/') return home;
  if (c.startsWith('~/')) c = path.join(home, c.slice(2));
  else if (!path.isAbsolute(c)) c = path.resolve(home, c);
  try {
    if (fs.statSync(c).isDirectory()) return c;
  } catch {
    /* fall back to home */
  }
  return home;
}

/**
 * Manages all node-pty processes for one window. `kill()`/`killAll()` guarantee
 * no orphaned children when a session closes or the app quits (PRD US-1.1, §8).
 */
export class PtyHost {
  private readonly procs = new Map<string, IPty>();
  private readonly hooksFile = installHooksFile();

  constructor(private readonly target: WebContents) {}

  spawn(opts: SpawnOptions): void {
    if (this.procs.has(opts.sessionId)) return; // idempotent
    const shell = opts.shell || defaultShell();
    const cwd = resolveCwd(opts.cwd);
    const command = this.hooksFile
      ? withClaudeHooks(opts.command, this.hooksFile)
      : opts.command;
    const args = shellLaunchArgs(command, process.platform === 'win32');
    const proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: opts.cols || 80,
      rows: opts.rows || 24,
      cwd,
      env: { ...process.env, ...(opts.env ?? {}) } as Record<string, string>,
    });
    this.procs.set(opts.sessionId, proc);

    proc.onData((data) => this.send(IPC.data, { sessionId: opts.sessionId, data }));
    proc.onExit(({ exitCode }) => {
      this.procs.delete(opts.sessionId);
      this.send(IPC.exit, { sessionId: opts.sessionId, exitCode });
    });
  }

  write(sessionId: string, data: string): void {
    this.procs.get(sessionId)?.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    try {
      this.procs.get(sessionId)?.resize(cols, rows);
    } catch {
      /* size transiently invalid during a layout change */
    }
  }

  kill(sessionId: string): void {
    const proc = this.procs.get(sessionId);
    if (proc) {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
      this.procs.delete(sessionId);
    }
  }

  killAll(): void {
    for (const id of [...this.procs.keys()]) this.kill(id);
  }

  /** Don't post to a renderer that's being torn down. */
  private send(channel: string, payload: unknown): void {
    if (!this.target.isDestroyed()) this.target.send(channel, payload);
  }
}
