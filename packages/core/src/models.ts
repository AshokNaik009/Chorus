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

/** One agent in a swarm: a session plus its role + seed prompt (PRD Epic 10). */
export interface SwarmMember {
  sessionId: string;
  /** 'frontend' | 'backend' | 'tests' | free text. */
  role?: string;
  /** The prompt the member was/should be seeded with. */
  seedPrompt?: string;
}

/**
 * A swarm: a coordinated group of sessions working one task, scoped to a single
 * workspace, optionally sharing a blackboard directory (PRD Epic 10).
 */
export interface SwarmDef {
  swarmId: string;
  workspaceId: string;
  name: string;
  /** The shared objective. */
  task?: string;
  /** Absolute path of the blackboard directory (Electron only). */
  sharedDir?: string;
  members: SwarmMember[];
}

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
  /** Swarms defined within this workspace (PRD Epic 10). Optional. */
  swarms?: SwarmDef[];
}

/** The transcription engines a host may inject (PRD Epic 9). */
export type TranscriberId = 'whisper-wasm' | 'whisper-local';

/** Persisted voice-dictation preferences (PRD §9.1, US-9.3). */
export interface VoiceSettings {
  engineId: TranscriberId;
  /** submit appends a newline (sends the prompt); insert lets the user edit. */
  mode: 'insert' | 'submit';
  /** Global push-to-talk hotkey, e.g. "CmdOrCtrl+Shift+D". */
  hotkey: string;
  /** Optional BCP-47 language hint for the engine (e.g. "en"). */
  language?: string;
}

/** App-wide settings persisted alongside the workspaces. */
export interface AppSettings {
  voice?: VoiceSettings;
}

/** The full persisted state: many workspaces plus which one is active. */
export interface WorkspaceState {
  version: 2;
  workspaces: Workspace[];
  activeWorkspaceId: string;
  /** App-wide settings (voice, …). Optional; absent on older saves. */
  settings?: AppSettings;
}
