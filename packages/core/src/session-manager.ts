import type { SessionConfig, SessionStatus } from './models.js';
import type { Disposable, PtyBackend } from './pty.js';
import { Emitter } from './emitter.js';
import { OscStatusScanner } from './osc.js';
import {
  statusReducer,
  type HookStatus,
  type StatusEvent,
} from './status.js';

/** A live session: its config plus current status. */
export interface Session {
  config: SessionConfig;
  status: SessionStatus;
  /**
   * Count of completed turns, i.e. authoritative `idle` (Claude Stop) hooks
   * seen. 0 until the agent finishes its first turn. Used by swarm fan-out to
   * gate the verifier: a CLI-arg-launched agent never enters `running` (no
   * `submit` write, and Claude has no running hook), so "has it finished a
   * turn?" must be read from Stop hooks, not the status.
   */
  turnsCompleted: number;
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

// Access the ambient timer globals without depending on DOM/node lib types,
// keeping @app/core dependency-free. Reads the live property at call time, so
// test fake-timers that patch globalThis still apply.
const timers = globalThis as unknown as {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(handle: number): void;
};

export interface SessionManagerOptions {
  /**
   * Fallback only: ms of no output after a heuristic `running` before we treat
   * the session as idle. Disabled once any hook is seen. Default 1500.
   */
  fallbackIdleMs?: number;
}

interface Internal {
  scanner: OscStatusScanner;
  output: Emitter<string>;
  subs: Disposable[];
  firstOutputSeen: boolean;
  quietTimer: number | null;
}

/**
 * Owns the set of sessions and is the single entry point the UI uses to drive
 * terminals. All terminal I/O is delegated to an injected `PtyBackend`. Incoming
 * PTY data is run through a per-session OSC scanner (PRD §5.4) that surfaces
 * authoritative hook statuses and strips the control bytes before the UI sees
 * them. A gated stream heuristic (submit -> running, quiet -> idle) covers the
 * no-hooks case without ever overriding a hook-driven state. See §5.2/§5.3,
 * Epic 2 & 5, and §11 (status logic lives here, not in React).
 */
export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly internal = new Map<string, Internal>();
  private readonly fallbackIdleMs: number;

  /** Fires on any change to the session list, config, or status. */
  readonly onChange = new Emitter<Session[]>();
  /** Fires whenever a single session's status transitions. */
  readonly onStatus = new Emitter<StatusChange>();

  constructor(
    private readonly backend: PtyBackend,
    options: SessionManagerOptions = {},
  ) {
    this.fallbackIdleMs = options.fallbackIdleMs ?? 1500;
  }

  list(): Session[] {
    return [...this.sessions.values()].map((s) => ({
      config: { ...s.config },
      status: s.status,
      turnsCompleted: s.turnsCompleted,
    }));
  }

  get(sessionId: string): Session | undefined {
    const s = this.sessions.get(sessionId);
    return s
      ? { config: { ...s.config }, status: s.status, turnsCompleted: s.turnsCompleted }
      : undefined;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async spawn(
    config: SessionConfig,
    dims: { cols: number; rows: number },
    extras: SpawnExtras = {},
  ): Promise<void> {
    const id = config.sessionId;
    if (this.sessions.has(id)) return;

    this.sessions.set(id, {
      config: { ...config },
      status: 'spawning',
      turnsCompleted: 0,
    });
    const state: Internal = {
      scanner: new OscStatusScanner(),
      output: this.internal.get(id)?.output ?? new Emitter<string>(),
      subs: [],
      firstOutputSeen: false,
      quietTimer: null,
    };
    this.internal.set(id, state);

    state.subs.push(
      this.backend.onData(id, (raw) => this.handleData(id, raw)),
      this.backend.onExit(id, () => {
        this.clearQuietTimer(id);
        this.dispatch(id, { type: 'exit' });
      }),
    );

    this.emitChange();

    await this.backend.spawn({
      sessionId: id,
      cwd: config.cwd,
      cols: dims.cols,
      rows: dims.rows,
      command: extras.command,
      shell: extras.shell,
      env: extras.env,
    });
  }

  /** Subscribe to a session's cleaned PTY output (OSC status bytes removed). */
  onData(sessionId: string, cb: (data: string) => void): Disposable {
    return this.outputEmitter(sessionId).on(cb);
  }

  write(sessionId: string, data: string): void {
    const state = this.internal.get(sessionId);
    if (!state) return;
    this.backend.write(sessionId, data);
    // A submitted prompt is the PRIMARY `running` signal (PRD §5.3) — it applies
    // with or without hooks. The quiet timer armed here is a self-healing safety
    // net; a Stop/Notification hook, when present, fires later, is authoritative,
    // and cancels the timer.
    if (/[\r\n]/.test(data)) {
      this.dispatch(sessionId, { type: 'submit' });
      this.armQuietTimer(sessionId);
    }
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

  /** Feed an authoritative hook status. Disables the fallback heuristic. */
  applyHookStatus(sessionId: string, status: HookStatus): void {
    // Hooks are authoritative; cancel any pending fallback transition.
    this.clearQuietTimer(sessionId);
    const s = this.sessions.get(sessionId);
    const prev = s?.status;
    // A Stop hook (idle) marks a completed turn. Count it even when the status
    // doesn't change — an agent often already reads `idle` (from the first-render
    // heuristic) when its turn ends, so the Stop would otherwise emit nothing,
    // and swarm gating would never see the turn finish.
    if (status === 'idle' && s) s.turnsCompleted += 1;
    this.dispatch(sessionId, { type: 'hook', status });
    if (status === 'idle' && s && prev === 'idle') this.emitChange();
  }

  kill(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return;
    this.backend.kill(sessionId);
  }

  remove(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return;
    this.backend.kill(sessionId);
    const state = this.internal.get(sessionId);
    if (state) {
      this.clearQuietTimer(sessionId);
      for (const d of state.subs) d.dispose();
      state.output.clear();
    }
    this.internal.delete(sessionId);
    this.sessions.delete(sessionId);
    this.emitChange();
  }

  dispose(): void {
    for (const id of [...this.sessions.keys()]) this.remove(id);
    this.onChange.clear();
    this.onStatus.clear();
  }

  private handleData(sessionId: string, raw: string): void {
    const state = this.internal.get(sessionId);
    if (!state) return;

    const { output, statuses } = state.scanner.push(raw);

    if (!state.firstOutputSeen) {
      state.firstOutputSeen = true;
      this.dispatch(sessionId, { type: 'firstOutput' });
    }
    for (const status of statuses) this.applyHookStatus(sessionId, status);

    if (output) state.output.emit(output);

    // While `running`, continued output keeps it alive (resets the quiet timer).
    if (state.quietTimer !== null) {
      this.armQuietTimer(sessionId);
    }
  }

  private outputEmitter(sessionId: string): Emitter<string> {
    let state = this.internal.get(sessionId);
    if (!state) {
      // Allow subscribing before spawn; the emitter is carried into spawn().
      const output = new Emitter<string>();
      state = {
        scanner: new OscStatusScanner(),
        output,
        subs: [],
        firstOutputSeen: false,
        quietTimer: null,
      };
      this.internal.set(sessionId, state);
    }
    return state.output;
  }

  private armQuietTimer(sessionId: string): void {
    const state = this.internal.get(sessionId);
    if (!state) return;
    this.clearQuietTimer(sessionId);
    state.quietTimer = timers.setTimeout(() => {
      const s = this.internal.get(sessionId);
      if (s) {
        s.quietTimer = null;
        this.dispatch(sessionId, { type: 'quiet' });
      }
    }, this.fallbackIdleMs);
  }

  private clearQuietTimer(sessionId: string): void {
    const state = this.internal.get(sessionId);
    if (state?.quietTimer != null) {
      timers.clearTimeout(state.quietTimer);
      state.quietTimer = null;
    }
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

  private emitChange(): void {
    this.onChange.emit(this.list());
  }
}
