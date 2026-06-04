/**
 * Session memory import/export — the portable `.chorus` bundle. See PRD Epic 11.
 *
 * Two layers:
 *  - Layer 1 (all hosts): the Chorus WorkspaceState (layouts, panes, cwds, names,
 *    swarms). A backup/share/move file. Pure (de)serialize + reconcile lives here
 *    and is exercised by both renderers through the DOM file APIs.
 *  - Layer 2 (Electron): the underlying Claude Code conversations + memory files,
 *    captured/replayed through the `SessionArchive` host seam (declared here,
 *    implemented in app-electron; the web harness no-ops).
 *
 * Everything in this module is framework- and host-agnostic, so the bundle shape,
 * validation, and merge/replace reconciliation are unit-testable in isolation.
 */
import type { LayoutNode, SessionConfig, Workspace, WorkspaceState } from './models.js';
import { collectSessionIds, createSessionId } from './layout.js';
import { createWorkspaceId, parseWorkspaceState } from './workspace.js';

/** A single Claude Code conversation, captured for Layer-2 export. */
export interface ConversationRef {
  /** The Claude Code conversation/session id (NOT the Chorus pane id). */
  sessionId: string;
  /** Absolute project path at export time, for slug remap on import. */
  originalProjectPath: string;
  name?: string;
  /** JSONL contents of the session transcript file. */
  transcript: string;
}

/** A memory file carried alongside a full bundle (MEMORY.md, CLAUDE.md, …). */
export interface MemoryFile {
  relPath: string;
  contents: string;
}

export const BUNDLE_VERSION = 1 as const;

/** The on-disk `.chorus` bundle. Layer 1 is always present; Layer 2 optional. */
export interface ChorusBundle {
  version: typeof BUNDLE_VERSION;
  exportedAt: number;
  /** Layer 1 — always present. */
  workspace: WorkspaceState;
  /** Layer 2 — Electron full export only. */
  conversations?: ConversationRef[];
  /** Layer 2 — optional MEMORY.md / CLAUDE.md etc. */
  memoryFiles?: MemoryFile[];
}

/** Summary returned after an import, surfaced to the user (US-11.5). */
export interface ImportResult {
  workspaceImported: boolean;
  conversationsImported: number;
  /** e.g. a transcript already present on disk and not overwritten. */
  conversationsSkipped: number;
  warnings: string[];
}

export type ImportMode = 'merge' | 'replace';

/** Outcome of writing conversation transcripts into `~/.claude` on import. */
export interface ImportConversationsResult {
  imported: number;
  skipped: number;
  warnings: string[];
}

/**
 * Host seam for Layer 2 (conversations + `~/.claude`). Electron implements it
 * fully; the web harness injects nothing, so the UI hides full-export features
 * and Layer 1 still works (US-11.6). `@app/ui` consumes only this interface.
 */
export interface SessionArchive {
  /**
   * Best-effort resolve of the Claude Code conversation id for a pane Chorus
   * launched (e.g. via `--name <paneId>` then a `~/.claude` lookup). Returns null
   * when it cannot be determined; never throws so it can't block a launch.
   */
  captureSessionId(paneSessionId: string, cwd: string): Promise<string | null>;
  /** Read each conversation's JSONL transcript for a full export. */
  exportConversations(
    items: { sessionId: string; cwd: string }[],
  ): Promise<ConversationRef[]>;
  /**
   * Write transcripts under the target machine's project slug. `remap` maps an
   * exported `originalProjectPath` to a local absolute path. Never overwrites an
   * existing transcript without the host having confirmed/backed it up.
   */
  importConversations(
    refs: ConversationRef[],
    remap: (origPath: string) => string,
  ): Promise<ImportConversationsResult>;
  /** argv to resume a conversation in a pane PTY, e.g. ['--resume', id]. */
  resumeArgs(sessionId: string): string[];
}

// ---- Layer 1: pure bundle build / (de)serialize ----

/** Build a Layer-1 (workspace-only) bundle from the current state. */
export function buildWorkspaceBundle(state: WorkspaceState): ChorusBundle {
  return { version: BUNDLE_VERSION, exportedAt: Date.now(), workspace: state };
}

/** Serialize a bundle to the `.chorus` file body (human-readable JSON). */
export function serializeBundle(bundle: ChorusBundle): string {
  return JSON.stringify(bundle, null, 2);
}

export type ParseBundleResult =
  | { ok: true; bundle: ChorusBundle }
  | { ok: false; error: string };

function isConversationRef(v: unknown): v is ConversationRef {
  if (!v || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.sessionId === 'string' &&
    typeof c.originalProjectPath === 'string' &&
    typeof c.transcript === 'string' &&
    (c.name === undefined || typeof c.name === 'string')
  );
}

function isMemoryFile(v: unknown): v is MemoryFile {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  return typeof m.relPath === 'string' && typeof m.contents === 'string';
}

/**
 * Validate an untrusted bundle (raw JSON string or parsed object). Fails safely
 * with a human-readable reason so a malformed/old-version file never corrupts the
 * running state (US-11.2). Unknown future top-level keys are ignored.
 */
export function parseBundle(raw: unknown): ParseBundleResult {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'File is not valid JSON.' };
    }
  }
  if (!obj || typeof obj !== 'object') {
    return { ok: false, error: 'Bundle is empty or not an object.' };
  }
  const b = obj as Record<string, unknown>;
  if (b.version !== BUNDLE_VERSION) {
    return {
      ok: false,
      error: `Unsupported bundle version ${JSON.stringify(b.version)} (expected ${BUNDLE_VERSION}).`,
    };
  }
  const workspace = parseWorkspaceState(b.workspace);
  if (!workspace) {
    return { ok: false, error: 'Bundle workspace state is missing or invalid.' };
  }
  if (
    b.conversations !== undefined &&
    !(Array.isArray(b.conversations) && b.conversations.every(isConversationRef))
  ) {
    return { ok: false, error: 'Bundle conversations are malformed.' };
  }
  if (
    b.memoryFiles !== undefined &&
    !(Array.isArray(b.memoryFiles) && b.memoryFiles.every(isMemoryFile))
  ) {
    return { ok: false, error: 'Bundle memory files are malformed.' };
  }
  const bundle: ChorusBundle = {
    version: BUNDLE_VERSION,
    exportedAt: typeof b.exportedAt === 'number' ? b.exportedAt : 0,
    workspace,
  };
  if (b.conversations) bundle.conversations = b.conversations as ConversationRef[];
  if (b.memoryFiles) bundle.memoryFiles = b.memoryFiles as MemoryFile[];
  return { ok: true, bundle };
}

// ---- Layer 1: import reconciliation ----

function remapLayoutIds(node: LayoutNode, idMap: Map<string, string>): LayoutNode {
  if (node.type === 'pane') {
    return { type: 'pane', sessionId: idMap.get(node.sessionId) ?? node.sessionId };
  }
  return { ...node, children: node.children.map((c) => remapLayoutIds(c, idMap)) };
}

/**
 * Clone a workspace with fresh workspace + session ids, keeping the layout tree
 * and session configs internally consistent. Used when MERGING an imported
 * workspace so its ids can never collide with the current ones (which would make
 * two panes share a PTY). The Claude conversation linkage rides on each
 * SessionConfig, not on the pane id, so resume survives the remap.
 */
export function remapWorkspaceIds(ws: Workspace): Workspace {
  const idMap = new Map<string, string>();
  const ids = new Set<string>([
    ...collectSessionIds(ws.layout),
    ...ws.sessions.map((s) => s.sessionId),
  ]);
  for (const id of ids) idMap.set(id, createSessionId());
  const sessions: SessionConfig[] = ws.sessions.map((s) => ({
    ...s,
    sessionId: idMap.get(s.sessionId) ?? createSessionId(),
  }));
  // Swarm members reference session ids too — keep them in lockstep.
  const newWorkspaceId = createWorkspaceId();
  const swarms = ws.swarms?.map((sw) => ({
    ...sw,
    workspaceId: newWorkspaceId,
    members: sw.members.map((m) => ({
      ...m,
      sessionId: idMap.get(m.sessionId) ?? m.sessionId,
    })),
  }));
  return {
    ...ws,
    id: newWorkspaceId,
    layout: remapLayoutIds(ws.layout, idMap),
    sessions,
    ...(swarms ? { swarms } : {}),
  };
}

function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let candidate = `${base} (imported)`;
  let i = 2;
  while (taken.has(candidate)) candidate = `${base} (imported ${i++})`;
  return candidate;
}

/**
 * Reconcile an imported bundle against the current state (US-11.2).
 *  - 'replace': the imported workspace state becomes the whole state.
 *  - 'merge': imported workspaces are appended with fresh ids; a name that
 *    collides with an existing workspace is renamed (never silently overwritten)
 *    and the rename is surfaced as a warning.
 * Pure — never mutates inputs. Layer-2 conversation counts are filled in by the
 * caller after it runs the `SessionArchive` import.
 */
export function reconcileImport(
  current: WorkspaceState,
  bundle: ChorusBundle,
  mode: ImportMode,
): { state: WorkspaceState; result: ImportResult } {
  const incoming = bundle.workspace;
  if (mode === 'replace') {
    return {
      state: incoming,
      result: {
        workspaceImported: true,
        conversationsImported: 0,
        conversationsSkipped: 0,
        warnings: [],
      },
    };
  }

  const warnings: string[] = [];
  const takenNames = new Set(current.workspaces.map((w) => w.name));
  const merged = incoming.workspaces.map((ws) => {
    const name = uniqueName(ws.name, takenNames);
    if (name !== ws.name) {
      warnings.push(`Workspace "${ws.name}" already exists — imported as "${name}".`);
    }
    takenNames.add(name);
    return remapWorkspaceIds({ ...ws, name });
  });

  const state: WorkspaceState = {
    version: 2,
    workspaces: [...current.workspaces, ...merged],
    activeWorkspaceId: merged[0]?.id ?? current.activeWorkspaceId,
  };
  return {
    state,
    result: {
      workspaceImported: true,
      conversationsImported: 0,
      conversationsSkipped: 0,
      warnings,
    },
  };
}
