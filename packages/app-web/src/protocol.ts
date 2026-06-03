/**
 * Wire protocol for the dev-harness websocket bridge (PRD §5: transport = ws).
 *
 * This is harness-transport detail and intentionally lives in app-web, NOT in
 * @app/core. In M1 the client side is wrapped by a `WebPtyBackend` that
 * implements core's `PtyBackend`. In M0 it carries one PTY per connection.
 */

export interface SpawnMsg {
  type: 'spawn';
  sessionId: string;
  cwd: string;
  cols: number;
  rows: number;
  shell?: string;
  /** v1: "claude" to launch a Claude Code session inside the shell. */
  command?: string;
  env?: Record<string, string>;
}

export interface InputMsg {
  type: 'input';
  sessionId: string;
  data: string;
}

export interface ResizeMsg {
  type: 'resize';
  sessionId: string;
  cols: number;
  rows: number;
}

export interface KillMsg {
  type: 'kill';
  sessionId: string;
}

export type ClientMsg = SpawnMsg | InputMsg | ResizeMsg | KillMsg;

export interface DataMsg {
  type: 'data';
  sessionId: string;
  data: string;
}

export interface ExitMsg {
  type: 'exit';
  sessionId: string;
  exitCode: number;
}

export type ServerMsg = DataMsg | ExitMsg;
