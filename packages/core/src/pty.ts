/**
 * PtyBackend — the swappable terminal seam. See PRD §5.2.
 *
 * Hosts (app-web over websockets, app-electron over IPC) implement this.
 * The UI talks to terminals ONLY through this interface, never to node-pty
 * directly.
 */

export interface SpawnOptions {
  sessionId: string;
  cwd: string;
  cols: number;
  rows: number;
  /** default: win32 -> pwsh.exe, else $SHELL || bash */
  shell?: string;
  /** v1: always "claude" */
  command?: string;
  env?: Record<string, string>;
}

export interface Disposable {
  dispose(): void;
}

export interface PtyBackend {
  spawn(opts: SpawnOptions): Promise<void>;
  write(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  kill(sessionId: string): void;
  onData(sessionId: string, cb: (data: string) => void): Disposable;
  onExit(sessionId: string, cb: (exitCode: number) => void): Disposable;
}
