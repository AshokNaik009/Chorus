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

/** The full persisted workspace. */
export interface WorkspaceState {
  version: 1;
  layout: LayoutNode;
  sessions: SessionConfig[];
}
