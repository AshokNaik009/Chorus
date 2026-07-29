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
  /**
   * How much of each session's recent output to keep for replay, in characters.
   * Default 256k — a few screens of a TUI plus scrollback.
   */
  replayLimit?: number;
}

interface Internal {
  scanner: OscStatusScanner;
  output: Emitter<string>;
  subs: Disposable[];
  firstOutputSeen: boolean;
  quietTimer: number | null;
  /** Recent output chunks, replayed to a terminal that (re)attaches. */
  replay: string[];
  /** Total length of `replay`, tracked so trimming needs no re-summing. */
  replayLen: number;
}

/**
 * Where in `chunk` the last full-screen erase starts, or -1. Everything before
 * a `2J`/`3J` has been wiped off the screen, so the replay can start there and
 * stay the size of what is actually visible.
 */
function lastScreenClear(chunk: string): number {
  return Math.max(chunk.lastIndexOf('\x1b[2J'), chunk.lastIndexOf('\x1b[3J'));
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
  private readonly replayLimit: number;

  /** Fires on any change to the session list, config, or status. */
  readonly onChange = new Emitter<Session[]>();
  /** Fires whenever a single session's status transitions. */
  readonly onStatus = new Emitter<StatusChange>();

  constructor(
    private readonly backend: PtyBackend,
    options: SessionManagerOptions = {},
  ) {
    this.fallbackIdleMs = options.fallbackIdleMs ?? 1500;
    this.replayLimit = options.replayLimit ?? 256_000;
  }

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

  async spawn(
    config: SessionConfig,
    dims: { cols: number; rows: number },
    extras: SpawnExtras = {},
  ): Promise<void> {
    const id = config.sessionId;
    if (this.sessions.has(id)) return;

    this.sessions.set(id, { config: { ...config }, status: 'spawning' });
    const prior = this.internal.get(id);
    const state: Internal = {
      scanner: new OscStatusScanner(),
      output: prior?.output ?? new Emitter<string>(),
      subs: [],
      firstOutputSeen: false,
      quietTimer: null,
      // A pane can subscribe before spawn; anything it already buffered belongs
      // to this session and is carried over with the emitter.
      replay: prior?.replay ?? [],
      replayLen: prior?.replayLen ?? 0,
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

  /**
   * Everything the session has printed recently, up to `replayLimit`.
   *
   * This is what lets a pane survive being unmounted. Leaving a workspace
   * disposes its xterm while the PTY keeps running, so a terminal that comes
   * back has an empty screen and no reason to repaint — a TUI redraws when
   * something asks it to, and nothing does. Writing this into the fresh
   * terminal restores what was there, including whatever printed while the
   * workspace was in the background.
   */
  replayText(sessionId: string): string {
    const state = this.internal.get(sessionId);
    return state ? state.replay.join('') : '';
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
    this.dispatch(sessionId, { type: 'hook', status });
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

    if (output) {
      this.appendReplay(state, output);
      state.output.emit(output);
    }

    // While `running`, continued output keeps it alive (resets the quiet timer).
    if (state.quietTimer !== null) {
      this.armQuietTimer(sessionId);
    }
  }

  /**
   * Record output for a later replay, oldest-first and bounded. A chunk that
   * clears the screen resets the buffer to what follows it — the program has
   * just declared everything before it invisible.
   */
  private appendReplay(state: Internal, chunk: string): void {
    const clearAt = lastScreenClear(chunk);
    if (clearAt >= 0) {
      const tail = chunk.slice(clearAt);
      state.replay = [tail];
      state.replayLen = tail.length;
      return;
    }
    state.replay.push(chunk);
    state.replayLen += chunk.length;
    // Drop whole chunks off the front, never a partial one: cutting mid-escape
    // would feed the terminal a truncated sequence and garble the replay. The
    // last chunk always stays, even if it alone exceeds the limit.
    while (state.replayLen > this.replayLimit && state.replay.length > 1) {
      state.replayLen -= state.replay.shift()!.length;
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
        replay: [],
        replayLen: 0,
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
