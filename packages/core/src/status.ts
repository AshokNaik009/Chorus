import type { SessionStatus } from './models.js';

/**
 * Pure status state machine. See PRD §5.3.
 *
 * Hook events (Claude Code Notification/Stop hooks delivered via OSC, §5.4) are
 * AUTHORITATIVE. Stream events (`submit`, `firstOutput`) are the lightweight
 * fallback heuristic used when hooks are absent; they must never override a
 * hook-driven state. That ordering is enforced by callers choosing which event
 * to dispatch — this reducer treats a `hook` event as the source of truth and
 * only lets stream events nudge from non-conclusive states.
 */
export type HookStatus = Extract<SessionStatus, 'running' | 'waiting' | 'idle'>;

export type StatusEvent =
  | { type: 'spawn' }
  | { type: 'exit' }
  /** OSC hook signal — authoritative. */
  | { type: 'hook'; status: HookStatus }
  /** User submitted a prompt (Enter on a non-empty line). Fallback heuristic. */
  | { type: 'submit' }
  /** First PTY output after spawn → prompt is ready. Fallback heuristic. */
  | { type: 'firstOutput' }
  /** A quiet period (no output) after running. Fallback heuristic → idle. */
  | { type: 'quiet' };

export const INITIAL_STATUS: SessionStatus = 'spawning';

export function statusReducer(
  state: SessionStatus,
  event: StatusEvent,
): SessionStatus {
  // `exited` is absorbing — nothing revives a dead PTY.
  if (state === 'exited') return 'exited';

  switch (event.type) {
    case 'spawn':
      return 'spawning';
    case 'exit':
      return 'exited';
    case 'hook':
      // Authoritative: a hook can move us to any live state.
      return event.status;
    case 'submit':
      // Can't submit before the prompt is ready.
      return state === 'spawning' ? 'spawning' : 'running';
    case 'firstOutput':
      // First output means the initial prompt rendered and is idle.
      return state === 'spawning' ? 'idle' : state;
    case 'quiet':
      // Output stopped after a heuristic `running`; treat as idle. Callers only
      // dispatch this when no hook has been seen, so hooks are never overridden.
      return state === 'running' ? 'idle' : state;
    default: {
      // Exhaustiveness guard.
      const _never: never = event;
      return _never;
    }
  }
}
