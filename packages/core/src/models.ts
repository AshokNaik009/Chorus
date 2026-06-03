/**
 * Core domain models. Framework-agnostic, zero UI/host dependencies.
 * See PRD §5.2.
 */

/** Lifecycle status of a single Claude Code session. See PRD §5.3. */
export type SessionStatus =
  | 'spawning'
  | 'running'
  | 'waiting'
  | 'idle'
  | 'exited';

/** Persisted configuration for one session/pane. */
export interface SessionConfig {
  sessionId: string;
  title: string;
  cwd: string;
}

/**
 * A node in the layout tree. Either a recursive split (row/column) or a leaf
 * pane bound to a single session. Arbitrary nesting supports future templates.
 */
export type LayoutNode =
  | {
      type: 'split';
      direction: 'row' | 'column';
      /** Relative sizes of `children`, same length as `children`. */
      sizes: number[];
      children: LayoutNode[];
    }
  | { type: 'pane'; sessionId: string };

/**
 * A workspace: a named group of terminal sessions with its own layout and a
 * default working directory that new panes inherit. The top-level switchable
 * unit (see the product decisions extending PRD v1).
 */
export interface Workspace {
  id: string;
  name: string;
  /** New panes prefill this cwd; each pane may override it. */
  defaultCwd: string;
  layout: LayoutNode;
  /** Configs for panes that have been started (a pane may exist unstarted). */
  sessions: SessionConfig[];
}

/** The full persisted state: many workspaces plus which one is active. */
export interface WorkspaceState {
  version: 2;
  workspaces: Workspace[];
  activeWorkspaceId: string;
}
