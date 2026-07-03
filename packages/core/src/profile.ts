import type {
  AppSettings,
  LayoutNode,
  SessionConfig,
  SwarmDef,
  Workspace,
  WorkspaceState,
} from './models.js';
import { isLayoutNode } from './layout.js';
import {
  isSessionConfig,
  isSwarmDef,
  parseAppSettings,
  parseWorkspaceState,
} from './workspace.js';

/**
 * Profile format — the `~/.chorus/` on-disk layout, as pure data.
 *
 * Like `bundle.ts`, this module only maps `WorkspaceState` to/from a set of
 * JSON file bodies; it never touches a filesystem. The Node shell that reads
 * and writes the actual tree lives in `@app/store`.
 *
 * Layout (one file per entity, Claude-Code-style):
 *
 *   state.json                        storeVersion, activeWorkspaceId, order
 *   settings.json                     AppSettings (only when defined)
 *   workspaces/<ws-id>/workspace.json meta + layout + session/swarm order
 *   workspaces/<ws-id>/sessions/<session-id>.json
 *   workspaces/<ws-id>/swarms/<swarm-id>.json
 */

export const STORE_VERSION = 1;

/** Relative POSIX path -> JSON file body. The whole managed tree. */
export type ProfileFiles = Record<string, string>;

export interface ProfileDiff {
  /** Files that are new or whose content changed. */
  writes: Record<string, string>;
  /** Files present in `prev` but absent from `next`. */
  deletes: string[];
}

export interface AssembledProfile {
  /** null when the tree held no usable workspace. */
  state: WorkspaceState | null;
  /**
   * True when state.json declares a storeVersion this code does not
   * understand — the caller must refuse to save (never clobber a future
   * format).
   */
  incompatible: boolean;
}

/**
 * Ids become path segments. Today's generators (`ws-*`, `s-*`, `swarm-*`) are
 * always safe; this guard is defense against hand-edited files.
 */
export function isSafeEntityId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && !id.includes('..');
}

/** Pretty-printed body — the store is meant to be read with `cat`. */
function body(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

/** The shape of `workspace.json`: workspace meta + explicit entity order. */
interface WorkspaceMeta {
  id: string;
  name: string;
  defaultCwd: string;
  mode?: 'manual' | 'swarm';
  view?: 'grid' | 'tabs';
  layout: LayoutNode;
  sessionOrder: string[];
  /** Present iff the workspace has a `swarms` array (round-trip fidelity). */
  swarmOrder?: string[];
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}

function isWorkspaceMeta(v: unknown): v is WorkspaceMeta {
  if (!v || typeof v !== 'object') return false;
  const w = v as Record<string, unknown>;
  return (
    typeof w.id === 'string' &&
    typeof w.name === 'string' &&
    typeof w.defaultCwd === 'string' &&
    (w.mode === undefined || w.mode === 'manual' || w.mode === 'swarm') &&
    (w.view === undefined || w.view === 'grid' || w.view === 'tabs') &&
    isLayoutNode(w.layout) &&
    isStringArray(w.sessionOrder) &&
    (w.swarmOrder === undefined || isStringArray(w.swarmOrder))
  );
}

/**
 * WorkspaceState -> the exact set of files that should exist. Deterministic:
 * identical states produce byte-identical bodies (fixed key order by
 * construction). Entities with path-unsafe ids are skipped.
 */
export function planProfileFiles(state: WorkspaceState): ProfileFiles {
  const files: ProfileFiles = {};
  const workspaces = state.workspaces.filter((w) => isSafeEntityId(w.id));

  for (const w of workspaces) {
    const dir = `workspaces/${w.id}`;
    const sessions = w.sessions.filter((s) => isSafeEntityId(s.sessionId));
    const swarms = (w.swarms ?? []).filter((s) => isSafeEntityId(s.swarmId));

    const meta: WorkspaceMeta = {
      id: w.id,
      name: w.name,
      defaultCwd: w.defaultCwd,
      ...(w.mode !== undefined ? { mode: w.mode } : {}),
      ...(w.view !== undefined ? { view: w.view } : {}),
      layout: w.layout,
      sessionOrder: sessions.map((s) => s.sessionId),
      ...(w.swarms !== undefined
        ? { swarmOrder: swarms.map((s) => s.swarmId) }
        : {}),
    };
    files[`${dir}/workspace.json`] = body(meta);

    for (const s of sessions) {
      files[`${dir}/sessions/${s.sessionId}.json`] = body(s);
    }
    for (const s of swarms) {
      files[`${dir}/swarms/${s.swarmId}.json`] = body(s);
    }
  }

  files['state.json'] = body({
    storeVersion: STORE_VERSION,
    activeWorkspaceId: state.activeWorkspaceId,
    workspaceOrder: workspaces.map((w) => w.id),
  });
  if (state.settings !== undefined) {
    files['settings.json'] = body(state.settings);
  }
  return files;
}

/**
 * Which files to write/delete to turn the `prev` tree into `next`.
 * `prev === null` (first save into an unknown tree) writes everything and
 * deletes nothing.
 */
export function diffProfileFiles(
  prev: ProfileFiles | null,
  next: ProfileFiles,
): ProfileDiff {
  const writes: Record<string, string> = {};
  for (const [path, content] of Object.entries(next)) {
    if (prev?.[path] !== content) writes[path] = content;
  }
  const deletes = prev
    ? Object.keys(prev).filter((path) => !(path in next))
    : [];
  return { writes, deletes };
}

/** Parse one JSON body; null on any syntax error. */
function parseBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * Reassemble a WorkspaceState from file bodies. Tolerant: every file is
 * validated individually, and a corrupt file loses only its own entity — a
 * bad session file is skipped, a bad workspace.json skips that workspace, a
 * bad state.json falls back to sorted order. NOTE the flip side: once loaded,
 * memory is the source of truth, so the next save deletes skipped files.
 */
export function assembleProfile(files: ProfileFiles): AssembledProfile {
  const stateRaw = 'state.json' in files ? parseBody(files['state.json']) : null;
  const stateMeta =
    stateRaw && typeof stateRaw === 'object'
      ? (stateRaw as Record<string, unknown>)
      : null;

  if (
    stateMeta &&
    typeof stateMeta.storeVersion === 'number' &&
    stateMeta.storeVersion !== STORE_VERSION
  ) {
    return { state: null, incompatible: true };
  }

  // Group the managed files by workspace directory.
  const metaPaths = Object.keys(files)
    .filter((p) => /^workspaces\/[^/]+\/workspace\.json$/.test(p))
    .sort();

  const byId = new Map<string, Workspace>();
  for (const metaPath of metaPaths) {
    const dirId = metaPath.split('/')[1];
    const meta = parseBody(files[metaPath]);
    // A workspace.json that is corrupt, malformed, or inconsistent with its
    // directory name invalidates the whole workspace (we always write them
    // consistent).
    if (!isWorkspaceMeta(meta) || meta.id !== dirId || !isSafeEntityId(dirId)) {
      continue;
    }

    const collect = <T>(
      kind: 'sessions' | 'swarms',
      order: string[],
      guard: (v: unknown) => v is T,
      idOf: (v: T) => string,
    ): T[] => {
      const prefix = `workspaces/${dirId}/${kind}/`;
      const valid = new Map<string, T>();
      for (const path of Object.keys(files)) {
        if (!path.startsWith(prefix) || !path.endsWith('.json')) continue;
        const fileId = path.slice(prefix.length, -'.json'.length);
        if (fileId.includes('/') || !isSafeEntityId(fileId)) continue;
        const parsed = parseBody(files[path]);
        if (guard(parsed) && idOf(parsed) === fileId) valid.set(fileId, parsed);
      }
      // Declared order first, then stragglers (hand-added files) sorted.
      const ordered: T[] = [];
      for (const id of order) {
        const v = valid.get(id);
        if (v) {
          ordered.push(v);
          valid.delete(id);
        }
      }
      for (const id of [...valid.keys()].sort()) ordered.push(valid.get(id)!);
      return ordered;
    };

    const sessions = collect<SessionConfig>(
      'sessions',
      meta.sessionOrder,
      isSessionConfig,
      (s) => s.sessionId,
    );
    const swarms = collect<SwarmDef>(
      'swarms',
      meta.swarmOrder ?? [],
      isSwarmDef,
      (s) => s.swarmId,
    );

    byId.set(dirId, {
      id: meta.id,
      name: meta.name,
      defaultCwd: meta.defaultCwd,
      ...(meta.mode !== undefined ? { mode: meta.mode } : {}),
      ...(meta.view !== undefined ? { view: meta.view } : {}),
      layout: meta.layout,
      sessions,
      // A workspace has a `swarms` array iff workspace.json declared
      // swarmOrder or swarm files exist (round-trips the optional field).
      ...(meta.swarmOrder !== undefined || swarms.length > 0 ? { swarms } : {}),
    });
  }

  if (byId.size === 0) return { state: null, incompatible: false };

  // Order: state.json's workspaceOrder first, stragglers appended sorted.
  const declaredOrder = isStringArray(stateMeta?.workspaceOrder)
    ? (stateMeta!.workspaceOrder as string[])
    : [];
  const workspaces: Workspace[] = [];
  for (const id of declaredOrder) {
    const w = byId.get(id);
    if (w) {
      workspaces.push(w);
      byId.delete(id);
    }
  }
  for (const id of [...byId.keys()].sort()) workspaces.push(byId.get(id)!);

  const activeWorkspaceId =
    typeof stateMeta?.activeWorkspaceId === 'string' &&
    workspaces.some((w) => w.id === stateMeta.activeWorkspaceId)
      ? (stateMeta.activeWorkspaceId as string)
      : workspaces[0].id;

  const settings: AppSettings | undefined =
    'settings.json' in files
      ? parseAppSettings(parseBody(files['settings.json']))
      : undefined;

  // Belt-and-braces: the assembled state must still pass the same validator
  // that gates every other untrusted load.
  const state = parseWorkspaceState({
    version: 2,
    workspaces,
    activeWorkspaceId,
    ...(settings ? { settings } : {}),
  });
  return { state, incompatible: false };
}
