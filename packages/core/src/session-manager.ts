import type { SessionConfig, SessionStatus } from './models.js';
import type { Disposable, PtyBackend } from './pty.js';
import { Emitter } from './emitter.js';
import {
  statusReducer,
  type HookStatus,
  type StatusEvent,
} from './status.js';

/** A live session: its config plus current status. */
export interface Session {
  config: SessionConfig;
  status: SessionStatus;
}

export interface SpawnExtras {
  /** v1: "claude". Omit for a plain shell (dev harness only). */
  command?: string;
  shell?: string;
  env?: Record<string, string>;
}

export interface StatusChange {
  sessionId: string;
  status: SessionStatus;
}

/**
 * Owns the set of sessions and is the single entry point the UI uses to drive
 * terminals. It delegates ALL terminal I/O to an injected `PtyBackend` (the
 * seam) and emits session-list + status-change events. The UI never touches
 * node-pty/ws/IPC directly. See PRD §5.2, Epic 2, §11.
 */
export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly subs = new Map<string, Disposable[]>();
  private readonly firstOutputSeen = new Set<string>();

  /** Fires on any change to the session list, config, or status. */
  readonly onChange = new Emitter<Session[]>();
  /** Fires whenever a single session's status transitions. */
  readonly onStatus = new Emitter<StatusChange>();

  constructor(private readonly backend: PtyBackend) {}

  /** Immutable snapshot of all sessions, in insertion order. */
  list(): Session[] {
    return [...this.sessions.values()].map((s) => ({
      config: { ...s.config },
      status: s.status,
    }));
  }

  get(sessionId: string): Session | undefined {
    const s = this.sessions.get(sessionId);
    return s ? { config: { ...s.config }, status: s.status } : undefined;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Spawn a session and wire its backend lifecycle to the status machine. */
  async spawn(
    config: SessionConfig,
    dims: { cols: number; rows: number },
    extras: SpawnExtras = {},
  ): Promise<void> {
    if (this.sessions.has(config.sessionId)) return;

    this.sessions.set(config.sessionId, {
      config: { ...config },
      status: 'spawning',
    });
    this.firstOutputSeen.delete(config.sessionId);

    const dataSub = this.backend.onData(config.sessionId, () => {
      if (!this.firstOutputSeen.has(config.sessionId)) {
        this.firstOutputSeen.add(config.sessionId);
        this.dispatch(config.sessionId, { type: 'firstOutput' });
      }
    });
    const exitSub = this.backend.onExit(config.sessionId, () => {
      this.dispatch(config.sessionId, { type: 'exit' });
    });
    this.subs.set(config.sessionId, [dataSub, exitSub]);

    this.emitChange();

    await this.backend.spawn({
      sessionId: config.sessionId,
      cwd: config.cwd,
      cols: dims.cols,
      rows: dims.rows,
      command: extras.command,
      shell: extras.shell,
      env: extras.env,
    });
  }

  /** Subscribe to raw PTY output for a session (UI writes this to xterm). */
  onData(sessionId: string, cb: (data: string) => void): Disposable {
    return this.backend.onData(sessionId, cb);
  }

  write(sessionId: string, data: string): void {
    if (!this.sessions.has(sessionId)) return;
    this.backend.write(sessionId, data);
    // NB: `submit` (running) detection from raw keystrokes is wired in M3
    // alongside the OSC/hook layer to avoid false positives without hooks.
  }

  resize(sessionId: string, cols: number, rows: number): void {
    if (!this.sessions.has(sessionId)) return;
    this.backend.resize(sessionId, cols, rows);
  }

  rename(sessionId: string, title: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.config.title === title) return;
    s.config.title = title;
    this.emitChange();
  }

  /** Feed an authoritative hook status (from the OSC handler, M3). */
  applyHookStatus(sessionId: string, status: HookStatus): void {
    this.dispatch(sessionId, { type: 'hook', status });
  }

  /** Kill the PTY; the resulting onExit drives the session to `exited`. */
  kill(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return;
    this.backend.kill(sessionId);
  }

  /** Kill and forget a session, releasing its backend subscriptions. */
  remove(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return;
    this.backend.kill(sessionId);
    this.disposeSubs(sessionId);
    this.sessions.delete(sessionId);
    this.firstOutputSeen.delete(sessionId);
    this.emitChange();
  }

  dispose(): void {
    for (const id of [...this.sessions.keys()]) this.remove(id);
    this.onChange.clear();
    this.onStatus.clear();
  }

  private dispatch(sessionId: string, event: StatusEvent): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const next = statusReducer(s.status, event);
    if (next === s.status) return;
    s.status = next;
    this.onStatus.emit({ sessionId, status: next });
    this.emitChange();
  }

  private disposeSubs(sessionId: string): void {
    for (const d of this.subs.get(sessionId) ?? []) d.dispose();
    this.subs.delete(sessionId);
  }

  private emitChange(): void {
    this.onChange.emit(this.list());
  }
}
