import type { LayoutNode, SessionConfig, Workspace, WorkspaceState } from './models.js';
import { buildTemplate, type LayoutTemplate } from './layout.js';

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
