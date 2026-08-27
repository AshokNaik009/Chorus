/**
 * IslandBridge — the swappable macOS Dynamic Island seam (PRD §11, host seam).
 *
 * The UI derives a small view-model from its live status and pushes it here;
 * hosts that can drive the notch (Electron on a notch MacBook) render it and
 * route header actions back. Hosts without a notch (web, non-notch Macs) inject
 * nothing, and the UI simply never drives an island. The UI talks to the notch
 * ONLY through this interface, never to the `electron-dynamic-island` package
 * directly.
 */
import type { Disposable } from './pty.js';
import type { SessionStatus } from './models.js';
import type { ContextTier } from './context-health.js';

/** One session row shown in the Dynamic Island panel. */
export interface IslandSession {
  sessionId: string;
  title: string;
  status: SessionStatus;
  /** The workspace this session belongs to (sessions can span workspaces). */
  workspaceName?: string;
  /** Context-window occupancy 0..1 (from the health poll), if known. */
  contextPct?: number;
  /** Health tier for colouring the occupancy badge. */
  contextTier?: ContextTier;
  /** True for the focused/active pane (highlighted, sorted first). */
  active?: boolean;
}

/** The view-model the renderer pushes to the notch panel. */
export interface IslandViewModel {
  /** Master opt-in. When false the host hides the panel. */
  enabled: boolean;
  /** Name of the active workspace (shown in the panel summary). */
  activeWorkspaceName?: string;
  /** Every live session, richest-first; the panel renders one row each. */
  sessions: IslandSession[];
  /** How many live sessions are currently `waiting`. */
  waitingCount: number;
}

/** Header actions routed back from the panel. Extensible (approve/deny later). */
export type IslandAction = { type: 'jump'; sessionId: string };

export interface IslandBridge {
  /** Push the latest view-model (or `{ enabled:false, … }` to hide). */
  update(vm: IslandViewModel): void;
  /** Subscribe to header actions; returns an unsubscribe handle. */
  onAction(cb: (action: IslandAction) => void): Disposable;
}
