import type {
  AppSettings,
  LayoutNode,
  SessionConfig,
  SwarmDef,
  SwarmMember,
  VoiceSettings,
  Workspace,
  WorkspaceState,
} from './models.js';
import { buildTemplate, isLayoutNode, type LayoutTemplate } from './layout.js';

let wsCounter = 0;

export function createWorkspaceId(): string {
  wsCounter += 1;
  return `ws-${Date.now().toString(36)}-${wsCounter}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

export interface CreateWorkspaceOptions {
  name?: string;
  defaultCwd?: string;
  template?: LayoutTemplate;
}

/** Create a fresh workspace with a layout but no started sessions. */
export function createWorkspace(opts: CreateWorkspaceOptions = {}): Workspace {
  return {
    id: createWorkspaceId(),
    name: opts.name ?? 'Workspace',
    defaultCwd: opts.defaultCwd ?? '~',
    layout: buildTemplate(opts.template ?? 1),
    sessions: [],
  };
}

/** Default single-workspace state used on first launch / corrupt state. */
export function defaultWorkspaceState(defaultCwd = '~'): WorkspaceState {
  const ws = createWorkspace({ name: 'Workspace 1', defaultCwd });
  return { version: 2, workspaces: [ws], activeWorkspaceId: ws.id };
}

export function getActiveWorkspace(state: WorkspaceState): Workspace | undefined {
  return state.workspaces.find((w) => w.id === state.activeWorkspaceId);
}

// ---- pure, immutable state operations ----

export function addWorkspace(
  state: WorkspaceState,
  ws: Workspace,
  activate = true,
): WorkspaceState {
  return {
    ...state,
    workspaces: [...state.workspaces, ws],
    activeWorkspaceId: activate ? ws.id : state.activeWorkspaceId,
  };
}

export function removeWorkspace(
  state: WorkspaceState,
  id: string,
): WorkspaceState {
  const workspaces = state.workspaces.filter((w) => w.id !== id);
  if (workspaces.length === 0) return defaultWorkspaceState();
  const activeWorkspaceId =
    state.activeWorkspaceId === id
      ? workspaces[0].id
      : state.activeWorkspaceId;
  return { ...state, workspaces, activeWorkspaceId };
}

export function setActiveWorkspace(
  state: WorkspaceState,
  id: string,
): WorkspaceState {
  if (!state.workspaces.some((w) => w.id === id)) return state;
  return { ...state, activeWorkspaceId: id };
}

/** Immutably patch one workspace by id. */
export function updateWorkspace(
  state: WorkspaceState,
  id: string,
  patch: Partial<Omit<Workspace, 'id'>>,
): WorkspaceState {
  return {
    ...state,
    workspaces: state.workspaces.map((w) =>
      w.id === id ? { ...w, ...patch } : w,
    ),
  };
}

export function setWorkspaceLayout(
  state: WorkspaceState,
  id: string,
  layout: LayoutNode,
): WorkspaceState {
  return updateWorkspace(state, id, { layout });
}

/** Add or replace a started session's config within a workspace. */
export function upsertSession(
  state: WorkspaceState,
  workspaceId: string,
  config: SessionConfig,
): WorkspaceState {
  return {
    ...state,
    workspaces: state.workspaces.map((w) => {
      if (w.id !== workspaceId) return w;
      const others = w.sessions.filter(
        (s) => s.sessionId !== config.sessionId,
      );
      return { ...w, sessions: [...others, { ...config }] };
    }),
  };
}

/** Add or replace a swarm definition within a workspace (PRD US-10.6). */
export function upsertSwarm(
  state: WorkspaceState,
  workspaceId: string,
  def: SwarmDef,
): WorkspaceState {
  return {
    ...state,
    workspaces: state.workspaces.map((w) => {
      if (w.id !== workspaceId) return w;
      const others = (w.swarms ?? []).filter((s) => s.swarmId !== def.swarmId);
      return { ...w, swarms: [...others, def] };
    }),
  };
}

/** Remove a swarm definition from a workspace. */
export function removeSwarm(
  state: WorkspaceState,
  workspaceId: string,
  swarmId: string,
): WorkspaceState {
  return {
    ...state,
    workspaces: state.workspaces.map((w) =>
      w.id === workspaceId
        ? { ...w, swarms: (w.swarms ?? []).filter((s) => s.swarmId !== swarmId) }
        : w,
    ),
  };
}

/** Remove a session config from whichever workspace holds it. */
export function removeSessionConfig(
  state: WorkspaceState,
  sessionId: string,
): WorkspaceState {
  return {
    ...state,
    workspaces: state.workspaces.map((w) => ({
      ...w,
      sessions: w.sessions.filter((s) => s.sessionId !== sessionId),
    })),
  };
}

function isSessionConfig(v: unknown): v is SessionConfig {
  if (!v || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.sessionId === 'string' &&
    typeof c.title === 'string' &&
    typeof c.cwd === 'string' &&
    (c.claudeSessionId === undefined || typeof c.claudeSessionId === 'string')
  );
}

function isSwarmMember(v: unknown): v is SwarmMember {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.sessionId === 'string' &&
    (m.role === undefined || typeof m.role === 'string') &&
    (m.task === undefined || typeof m.task === 'string') &&
    (m.repoDir === undefined || typeof m.repoDir === 'string') &&
    (m.branch === undefined || typeof m.branch === 'string') &&
    (m.worktreeDir === undefined || typeof m.worktreeDir === 'string')
  );
}

function isSwarmDef(v: unknown): v is SwarmDef {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.swarmId === 'string' &&
    typeof s.workspaceId === 'string' &&
    typeof s.name === 'string' &&
    (s.task === undefined || typeof s.task === 'string') &&
    (s.sharedDir === undefined || typeof s.sharedDir === 'string') &&
    Array.isArray(s.members) &&
    s.members.every(isSwarmMember)
  );
}

function isWorkspace(v: unknown): v is Workspace {
  if (!v || typeof v !== 'object') return false;
  const w = v as Record<string, unknown>;
  return (
    typeof w.id === 'string' &&
    typeof w.name === 'string' &&
    typeof w.defaultCwd === 'string' &&
    (w.mode === undefined || w.mode === 'manual' || w.mode === 'swarm') &&
    (w.view === undefined || w.view === 'grid' || w.view === 'tabs') &&
    isLayoutNode(w.layout) &&
    Array.isArray(w.sessions) &&
    w.sessions.every(isSessionConfig) &&
    (w.swarms === undefined ||
      (Array.isArray(w.swarms) && w.swarms.every(isSwarmDef)))
  );
}

/** Best-effort parse of persisted voice settings; returns undefined if absent. */
function parseVoiceSettings(raw: unknown): VoiceSettings | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const v = raw as Record<string, unknown>;
  const engineId =
    v.engineId === 'whisper-wasm' || v.engineId === 'whisper-local'
      ? v.engineId
      : undefined;
  const mode = v.mode === 'insert' || v.mode === 'submit' ? v.mode : undefined;
  if (!engineId || !mode) return undefined;
  return {
    engineId,
    mode,
    hotkey: typeof v.hotkey === 'string' ? v.hotkey : 'CmdOrCtrl+Shift+D',
    ...(typeof v.language === 'string' ? { language: v.language } : {}),
  };
}

/** Best-effort parse of app settings. A bad blob is dropped, never fatal. */
function parseAppSettings(raw: unknown): AppSettings | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as Record<string, unknown>;
  const voice = parseVoiceSettings(s.voice);
  return voice ? { voice } : undefined;
}

/**
 * Validate untrusted persisted state. Returns a normalized WorkspaceState, or
 * null if it is missing/corrupt/old — callers fall back to a default 1-pane
 * workspace without crashing (PRD US-6.1). A malformed `settings` blob is
 * dropped (best-effort) rather than failing the whole load.
 */
export function parseWorkspaceState(raw: unknown): WorkspaceState | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (s.version !== 2) return null;
  if (!Array.isArray(s.workspaces) || s.workspaces.length === 0) return null;
  if (!s.workspaces.every(isWorkspace)) return null;
  const workspaces = s.workspaces as Workspace[];
  const activeWorkspaceId =
    typeof s.activeWorkspaceId === 'string' &&
    workspaces.some((w) => w.id === s.activeWorkspaceId)
      ? s.activeWorkspaceId
      : workspaces[0].id;
  const settings = parseAppSettings(s.settings);
  return {
    version: 2,
    workspaces,
    activeWorkspaceId,
    ...(settings ? { settings } : {}),
  };
}
