/**
 * The IPC contract shared by the Electron main process, the preload bridge, and
 * the renderer. Keeping the channel names and payload shapes in one place keeps
 * the three sides in lockstep. Mirrors app-web's `protocol.ts` (the websocket
 * wire format) — the difference is only the transport.
 */
import type {
  ConversationRef,
  ImportConversationsResult,
  SpawnOptions,
  WorkspaceState,
} from '@app/core';

/** Channel names. Renderer->main are invoke/send; main->renderer are sends. */
export const IPC = {
  spawn: 'pane:pty-spawn',
  write: 'pane:pty-write',
  resize: 'pane:pty-resize',
  kill: 'pane:pty-kill',
  data: 'pane:pty-data',
  exit: 'pane:pty-exit',
  loadState: 'pane:load-state',
  saveState: 'pane:save-state',
  createBlackboard: 'pane:create-blackboard',
  isGitRepo: 'pane:is-git-repo',
  createWorktree: 'pane:create-worktree',
  removeWorktree: 'pane:remove-worktree',
  captureSessionId: 'pane:capture-session-id',
  exportConversations: 'pane:export-conversations',
  importConversations: 'pane:import-conversations',
} as const;

/** Payload for `pane:pty-data` / `pane:pty-exit` (keyed by session). */
export interface PtyDataEvent {
  sessionId: string;
  data: string;
}
export interface PtyExitEvent {
  sessionId: string;
  exitCode: number;
}

/**
 * The surface the preload exposes on `window.paneApi`. The renderer's
 * `ElectronPtyBackend` / `ElectronPersistence` are thin adapters over this; it
 * is the only thing that crosses the contextIsolation boundary.
 */
export interface PaneApi {
  /** Home directory, resolved in the (Node-capable) preload for `defaultCwd`. */
  readonly homeDir: string;
  spawn(opts: SpawnOptions): void;
  write(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  kill(sessionId: string): void;
  /** Subscribe to every session's PTY output; returns an unsubscribe fn. */
  onData(cb: (e: PtyDataEvent) => void): () => void;
  /** Subscribe to every session's exit; returns an unsubscribe fn. */
  onExit(cb: (e: PtyExitEvent) => void): () => void;
  loadState(): Promise<WorkspaceState | null>;
  saveState(state: WorkspaceState): Promise<void>;
  /**
   * Create a swarm blackboard directory under `baseCwd` and write
   * `CHORUS_SWARM.md` into it. Returns the absolute dir, or null on failure.
   */
  createBlackboard(
    swarmId: string,
    baseCwd: string,
    doc: string,
  ): Promise<string | null>;
  /** True if `dir` is inside a git work tree (swarm worktrees need a repo). */
  isGitRepo(dir: string): Promise<boolean>;
  /**
   * Create an isolated worktree + branch off `repoDir`'s HEAD. `worktreeSubdir`
   * is based under `~/.chorus/worktrees/`. Returns the absolute path, or null.
   */
  createWorktree(
    repoDir: string,
    worktreeSubdir: string,
    branch: string,
  ): Promise<string | null>;
  /** Remove a worktree previously created (best-effort). */
  removeWorktree(repoDir: string, worktreeDir: string): Promise<void>;
  /** Layer-2 (PRD Epic 11) — all touch `~/.claude`, so they live in main. */
  captureSessionId(paneSessionId: string, cwd: string): Promise<string | null>;
  exportConversations(
    items: { sessionId: string; cwd: string }[],
  ): Promise<ConversationRef[]>;
  /** `refs` already have their project paths remapped for this machine. */
  importConversations(refs: ConversationRef[]): Promise<ImportConversationsResult>;
}
