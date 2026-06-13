import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addWorkspace,
  broadcastTo,
  buildAgentSystemPrompt,
  buildClaudeLaunch,
  buildHandoffBrief,
  buildGrid,
  buildRow,
  buildTemplate,
  buildWorkspaceBundle,
  collectSessionIds,
  countPanes,
  createSessionId,
  createSwarmId,
  createWorkspace,
  DEFAULT_VOICE_SETTINGS,
  defaultWorkspaceState,
  clampSwarmWorkers,
  getActiveWorkspace,
  planAgentWorktrees,
  reconcileImport,
  removePane,
  removeSessionConfig,
  removeSwarm,
  removeWorkspace,
  serializeBundle,
  setActiveWorkspace,
  setSizesAtPath,
  setWorkspaceLayout,
  SwarmOrchestrator,
  updateWorkspace,
  upsertSession,
  upsertSwarm,
  type ChorusBundle,
  type ClaudeLaunchConfig,
  type ContextHealth,
  type ImportMode,
  type ImportResult,
  type LayoutNode,
  type Persistence,
  type Session,
  type SessionArchive,
  type SessionConfig,
  type SessionManager,
  type SessionStatus,
  type SwarmDef,
  type SwarmMember,
  type SwarmWorkspace,
  type Transcriber,
  type TranscriberId,
  type VoiceSettings,
  type Workspace,
  type WorkspaceState,
} from '@app/core';
import { LayoutView } from './LayoutView.js';
import { TabbedView } from './TabbedView.js';
import { Sidebar } from './Sidebar.js';
import { SessionTerminal } from './SessionTerminal.js';
import { PaneLauncher } from './PaneLauncher.js';
import { StatusBadge } from './StatusBadge.js';
import { ContextHealthBadge } from './ContextHealthBadge.js';
import { MemoryControls, type ExportPayload } from './MemoryControls.js';
import {
  RecordingIndicator,
  useVoiceCapture,
  useVoiceHotkey,
  VoiceMicButton,
  VoiceSettingsButton,
} from './Voice.js';
import { HelpButton } from './Tutorial.js';
import { SwarmPanel } from './SwarmPanel.js';
import { DiffReview, type ReviewMember } from './DiffReview.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import type { TerminalPaneHandle } from './TerminalPane.js';

export interface AppProps {
  manager: SessionManager;
  /** Loads/saves workspace state across restarts (localStorage / file). */
  persistence: Persistence;
  /** Prefilled cwd for brand-new workspaces / panes. */
  defaultCwd?: string;
  /**
   * Layer-2 memory portability (PRD Epic 11). Present only on hosts that can
   * reach `~/.claude` (Electron). When absent, only workspace-level (Layer 1)
   * export/import is offered — the web harness degrades cleanly (US-11.6).
   */
  sessionArchive?: SessionArchive;
  /**
   * On-device transcription engines the host injects (PRD Epic 9). The UI probes
   * `isAvailable()` and consumes only the `Transcriber` interface; an empty/absent
   * list hides voice controls. Both hosts inject the WASM Whisper engine.
   */
  transcribers?: Transcriber[];
  /**
   * Shared-blackboard host helper for swarms (PRD Epic 10). Electron writes real
   * files; absent on web, where fan-out runs without a shared dir (US-10.4).
   */
  swarmWorkspace?: SwarmWorkspace;
}

/** Simplified manual layout: just pick how many terminals (1–6). */
const TERMINAL_COUNTS = [1, 2, 3, 4, 5, 6];

const SAVE_DEBOUNCE_MS = 400;

function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

/** Find the workspace + config holding a session, across all workspaces. */
function findSession(
  state: WorkspaceState,
  sessionId: string,
): { ws: Workspace; cfg: SessionConfig } | null {
  for (const ws of state.workspaces) {
    const cfg = ws.sessions.find((s) => s.sessionId === sessionId);
    if (cfg) return { ws, cfg };
  }
  return null;
}

/**
 * The full Chorus app: a two-tier workspace sidebar, a layout-template toolbar, a
 * resizable grid of Claude Code sessions, pane maximize, and persistence across
 * restarts. Host-agnostic — it receives a SessionManager (bound to a PtyBackend)
 * and a Persistence, and drives everything through them. See PRD Epics 3/4/6 and
 * the multi-workspace product decisions.
 */
export function App({
  manager,
  persistence,
  defaultCwd = '~',
  sessionArchive,
  transcribers,
  swarmWorkspace,
}: AppProps) {
  const [state, setState] = useState<WorkspaceState | null>(null);
  const [live, setLive] = useState<Session[]>([]);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [maximizedId, setMaximizedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Whether the whole workspace sidebar is shown or collapsed to a slim rail.
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // A pending destructive action awaiting confirmation (only raised when live
  // sessions would be lost). Cleared on confirm/cancel.
  const [pendingConfirm, setPendingConfirm] = useState<{
    message: string;
    confirmLabel: string;
    onConfirm: () => void;
  } | null>(null);

  const handles = useRef(new Map<string, TerminalPaneHandle>());

  // Git worktrees created for the active swarm fan-out (Epic 10). Torn down on a
  // reset, workspace close, or the next fan-out so they don't accumulate.
  const activeWorktrees = useRef<{ repoDir: string; worktreeDir: string }[]>([]);

  // Re-spawn a workspace's saved sessions that aren't live yet. Idempotent:
  // manager.spawn() no-ops on an id it already owns. A pane with a saved Claude
  // id relaunches with `--resume` ONLY when its transcript actually exists on
  // disk (a pinned id whose conversation never started must use `--session-id`
  // instead — `--resume` would error out). `liveClaudeIds` marks conversations
  // already running in another pane: those resume with `--fork-session`, so an
  // imported copy of a still-live session can never clobber the original.
  const ensureSpawned = useCallback(
    async (ws: Workspace, opts?: { liveClaudeIds?: Set<string> }) => {
      for (const cfg of ws.sessions) {
        if (manager.has(cfg.sessionId)) continue;
        let launch: ClaudeLaunchConfig = {};
        const cid = cfg.claudeSessionId;
        if (cid) {
          const resumable = sessionArchive
            ? await sessionArchive.hasConversation(cid, cfg.cwd)
            : true; // no archive (web): keep the legacy always-resume behavior
          launch = resumable
            ? {
                resumeSessionId: cid,
                ...(opts?.liveClaudeIds?.has(cid) ? { forkSession: true } : {}),
              }
            : { sessionId: cid };
        }
        const command = buildClaudeLaunch(launch);
        void manager.spawn(cfg, { cols: 80, rows: 24 }, { command });
      }
    },
    [manager, sessionArchive],
  );

  // Mirror live sessions (config + status) out of the manager.
  useEffect(() => {
    const sub = manager.onChange.on(setLive);
    setLive(manager.list());
    return () => sub.dispose();
  }, [manager]);

  // Load persisted state once, then re-spawn the active workspace's sessions.
  useEffect(() => {
    let cancelled = false;
    void persistence.load().then((loaded) => {
      if (cancelled) return;
      const initial = loaded ?? defaultWorkspaceState(defaultCwd);
      setState(initial);
      const active = getActiveWorkspace(initial);
      if (active) void ensureSpawned(active);
    });
    return () => {
      cancelled = true;
    };
  }, [persistence, defaultCwd, ensureSpawned]);

  // Debounced save on any state change.
  useEffect(() => {
    if (!state) return;
    const h = setTimeout(() => void persistence.save(state), SAVE_DEBOUNCE_MS);
    return () => clearTimeout(h);
  }, [state, persistence]);

  const statusById = useMemo(() => {
    const m = new Map<string, SessionStatus>();
    for (const s of live) m.set(s.config.sessionId, s.status);
    return m;
  }, [live]);
  const statusOf = useCallback(
    (id: string): SessionStatus | null => statusById.get(id) ?? null,
    [statusById],
  );

  // ---- context-window health (context-rot writeup, parts 2–3) ----
  // Per-pane occupancy read from each transcript JSONL via the SessionArchive.
  // Electron-only (web injects no archive); polled, best-effort, never blocks.
  const [healthById, setHealthById] = useState<Map<string, ContextHealth>>(
    new Map(),
  );
  // pane sessionId -> captured Claude conversation id, so we resolve the
  // transcript filename even before a Layer-2 import persists `claudeSessionId`.
  const claudeIdCache = useRef(new Map<string, string>());
  const claudeIdOf = useCallback(
    (sessionId: string): string | undefined =>
      (state ? findSession(state, sessionId)?.cfg.claudeSessionId : undefined) ??
      claudeIdCache.current.get(sessionId),
    [state],
  );
  // Persist a captured Claude id onto the pane's saved config the moment we
  // learn it: exports then carry the EXACT id instead of guessing at export
  // time, when the newest transcript in a cwd can belong to another pane (the
  // root cause of the flaky import). Only fills panes that have no saved id.
  const persistClaudeId = useCallback((paneId: string, cid: string) => {
    setState((prev) => {
      if (!prev) return prev;
      let changed = false;
      const workspaces = prev.workspaces.map((w) => {
        const i = w.sessions.findIndex(
          (s) => s.sessionId === paneId && !s.claudeSessionId,
        );
        if (i < 0) return w;
        changed = true;
        const sessions = w.sessions.slice();
        sessions[i] = { ...sessions[i], claudeSessionId: cid };
        return { ...w, sessions };
      });
      return changed ? { ...prev, workspaces } : prev;
    });
  }, []);

  useEffect(() => {
    const sa = sessionArchive;
    if (!sa || !state) return;
    let cancelled = false;
    const poll = async () => {
      const next = new Map<string, ContextHealth>();
      for (const s of live) {
        const id = s.config.sessionId;
        const cwd = findSession(state, id)?.cfg.cwd ?? s.config.cwd;
        let cid = claudeIdOf(id);
        if (!cid) {
          cid = (await sa.captureSessionId(id, cwd)) ?? undefined;
          if (cid) {
            claudeIdCache.current.set(id, cid);
            persistClaudeId(id, cid);
          }
        }
        if (!cid) continue;
        const h = await sa.readContextHealth(cid, cwd);
        if (h) next.set(id, h);
      }
      if (!cancelled) setHealthById(next);
    };
    void poll();
    const timer = setInterval(() => void poll(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionArchive, state, live, claudeIdOf, persistClaudeId]);

  // Build + copy a handoff-brief scaffold for a pane that crossed the red line.
  const handoff = useCallback(
    (sessionId: string) => {
      const health = healthById.get(sessionId);
      if (!health) return;
      const found = state ? findSession(state, sessionId) : null;
      const brief = buildHandoffBrief({
        title: found?.cfg.title,
        cwd: found?.cfg.cwd ?? '',
        sessionId: claudeIdOf(sessionId) ?? sessionId,
        health,
      });
      void navigator.clipboard?.writeText(brief);
    },
    [healthById, state, claudeIdOf],
  );

  const active = state ? getActiveWorkspace(state) : undefined;
  const swarmMode = active?.mode === 'swarm';
  const currentView: 'grid' | 'tabs' = active?.view ?? 'grid';

  // Tear down the swarm's git worktrees. Sweeps BOTH the in-memory list (this
  // session's fan-out) AND the worktrees recorded on the active workspace's
  // persisted swarm members — so a reload that lost the in-memory ref still
  // tidies up. removeWorktree is prune-first/idempotent, so the overlap is safe.
  const cleanupWorktrees = useCallback(() => {
    const seen = new Set<string>();
    const sweep = (repoDir: string, worktreeDir: string) => {
      if (!repoDir || !worktreeDir || seen.has(worktreeDir)) return;
      seen.add(worktreeDir);
      void swarmWorkspace?.removeWorktree(repoDir, worktreeDir);
    };
    const wts = activeWorktrees.current;
    activeWorktrees.current = [];
    for (const wt of wts) sweep(wt.repoDir, wt.worktreeDir);
    for (const sw of active?.swarms ?? []) {
      for (const m of sw.members) {
        if (m.repoDir && m.worktreeDir) sweep(m.repoDir, m.worktreeDir);
      }
    }
  }, [swarmWorkspace, active]);

  // How many of a workspace's sessions are actively working (running/waiting) —
  // the only states whose loss warrants a confirmation. Idle/exited don't.
  const runningCount = useCallback(
    (ws: Workspace | undefined): number =>
      ws
        ? ws.sessions.filter((s) => {
            const st = statusById.get(s.sessionId);
            return st === 'running' || st === 'waiting';
          }).length
        : 0,
    [statusById],
  );

  // Run `action`, but if the active workspace has live work, confirm first.
  const guardActive = useCallback(
    (verb: string, confirmLabel: string, action: () => void) => {
      const n = runningCount(active);
      if (n > 0) {
        setPendingConfirm({
          message: `${n} session${n > 1 ? 's are' : ' is'} still active and will be stopped. ${verb}`,
          confirmLabel,
          onConfirm: action,
        });
      } else {
        action();
      }
    },
    [active, runningCount],
  );

  // ---- workspace handlers ----

  const selectWorkspace = (id: string) => {
    if (!state) return;
    setState(setActiveWorkspace(state, id));
    const ws = state.workspaces.find((w) => w.id === id);
    if (ws) void ensureSpawned(ws);
    setFocusedId(null);
    setMaximizedId(null);
  };

  const newWorkspace = () => {
    setState((prev) => {
      if (!prev) return prev;
      const name = `Workspace ${prev.workspaces.length + 1}`;
      return addWorkspace(prev, createWorkspace({ name, defaultCwd }));
    });
    setFocusedId(null);
    setMaximizedId(null);
  };

  const closeWorkspace = (id: string) => {
    if (!state) return;
    const ws = state.workspaces.find((w) => w.id === id);
    const doClose = () => {
      const next = removeWorkspace(state, id);
      // Update state FIRST so the removal always lands, then tear down PTYs — a
      // throw in backend.kill can never strand the workspace in the sidebar.
      setState(next);
      setFocusedId(null);
      setMaximizedId(null);
      if (ws?.id === active?.id) cleanupWorktrees();
      if (ws) {
        for (const s of ws.sessions) {
          try {
            manager.remove(s.sessionId);
          } catch {
            /* PTY already gone */
          }
        }
      }
      const nextActive = getActiveWorkspace(next);
      if (nextActive) void ensureSpawned(nextActive);
    };
    // Confirm only if THIS workspace has live work (it may not be the active one).
    const n = runningCount(ws);
    if (n > 0) {
      setPendingConfirm({
        message: `${n} session${n > 1 ? 's are' : ' is'} still active in "${ws?.name ?? 'this workspace'}" and will be stopped. Close it?`,
        confirmLabel: 'Close workspace',
        onConfirm: doClose,
      });
    } else {
      doClose();
    }
  };

  const renameWorkspace = (id: string, name: string) => {
    setState((prev) => (prev ? updateWorkspace(prev, id, { name }) : prev));
  };

  const toggleCollapse = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ---- layout / session handlers (operate on the active workspace) ----

  // Lay out N empty terminals (manual mode). Tears down whatever was here —
  // including a swarm — and returns the workspace to manual mode.
  const setLayoutPanes = (n: number) => {
    if (!state || !active) return;
    for (const s of active.sessions) manager.remove(s.sessionId);
    handles.current.clear();
    cleanupWorktrees();
    setState(
      updateWorkspace(state, active.id, {
        mode: 'manual',
        layout: buildGrid(n),
        sessions: [],
      }),
    );
    setFocusedId(null);
    setMaximizedId(null);
  };

  const startSession = (
    sessionId: string,
    cwd: string,
    command?: string,
    title?: string,
  ) => {
    if (!state || !active) return;
    const isClaude = command === 'claude';
    const label = isClaude ? 'claude' : 'shell';
    // Pin the Claude conversation id at launch (--session-id) and persist it on
    // the config right away, so export/import later resumes EXACTLY this
    // conversation — never the "newest transcript in the cwd" guess, which picks
    // the wrong session when another pane shares the directory (Epic 11).
    // Web (no archive) launches unpinned, as before.
    const claudeSessionId =
      isClaude && sessionArchive ? crypto.randomUUID() : undefined;
    // The launcher's "claude" becomes a blank interactive session (no prompt
    // arg); a shell command passes through unchanged.
    const spawnCommand = isClaude
      ? buildClaudeLaunch(claudeSessionId ? { sessionId: claudeSessionId } : {})
      : command;
    const cfg: SessionConfig = {
      sessionId,
      title: title?.trim() || `${label} · ${basename(cwd)}`,
      cwd,
      ...(claudeSessionId ? { claudeSessionId } : {}),
    };
    void manager.spawn(cfg, { cols: 80, rows: 24 }, { command: spawnCommand });
    setState(upsertSession(state, active.id, cfg));
    setFocusedId(sessionId);
  };

  const closeSession = (sessionId: string) => {
    if (!state) return;
    const found = findSession(state, sessionId);
    let next = removeSessionConfig(state, sessionId);
    if (found) {
      const layout = removePane(found.ws.layout, sessionId) ?? buildTemplate(1);
      next = setWorkspaceLayout(next, found.ws.id, layout);
    }
    // State first so the row/pane always disappears, then kill the PTY.
    setState(next);
    setFocusedId((cur) => (cur === sessionId ? null : cur));
    setMaximizedId((cur) => (cur === sessionId ? null : cur));
    handles.current.delete(sessionId);
    try {
      manager.remove(sessionId);
    } catch {
      /* PTY already gone */
    }
  };

  // Close a single grid pane (the pane header ×). Removes it from the layout
  // whether or not a session was started in it, drops any config, and kills the
  // PTY. Differs from closeSession (sidebar) by always operating on the active
  // workspace layout, so empty launcher panes can be closed too.
  const closePane = (sessionId: string) => {
    if (!state || !active) return;
    const layout = removePane(active.layout, sessionId) ?? buildTemplate(1);
    let next = removeSessionConfig(state, sessionId);
    next = setWorkspaceLayout(next, active.id, layout);
    setState(next);
    setFocusedId((cur) => (cur === sessionId ? null : cur));
    setMaximizedId((cur) => (cur === sessionId ? null : cur));
    handles.current.delete(sessionId);
    try {
      manager.remove(sessionId);
    } catch {
      /* PTY already gone */
    }
  };

  // Reset the active workspace to a clean single pane (recovery from a broken
  // layout/view, or the explicit way out of swarm mode). Tears down this
  // workspace's sessions and returns to manual mode.
  const resetView = () => setLayoutPanes(1);

  const renameSession = (sessionId: string, title: string) => {
    if (!state) return;
    manager.rename(sessionId, title);
    const found = findSession(state, sessionId);
    if (found) {
      setState(upsertSession(state, found.ws.id, { ...found.cfg, title }));
    }
  };

  const focusSession = (sessionId: string) => {
    if (state) {
      const found = findSession(state, sessionId);
      if (found && found.ws.id !== state.activeWorkspaceId) {
        setState(setActiveWorkspace(state, found.ws.id));
        void ensureSpawned(found.ws);
      }
    }
    setFocusedId(sessionId);
    setMaximizedId(null);
    handles.current.get(sessionId)?.focus();
  };

  const onSizes = (path: number[], sizes: number[]) => {
    if (!state || !active) return;
    // Allotment reports sizes in PIXELS; we store them as PERCENTAGES. Normalize
    // before comparing/writing, otherwise the units never match, every onChange
    // writes a new layout, and that re-fires onChange → infinite update loop
    // ("Maximum update depth exceeded") — fatal during a fan-out where spawning
    // panes resize continuously. Skip changes that are proportionally a no-op.
    const total = sizes.reduce((a, b) => a + b, 0) || 1;
    const norm = sizes.map((s) => (s / total) * 100);
    let node: LayoutNode | undefined = active.layout;
    for (const i of path) {
      node = node && node.type === 'split' ? node.children[i] : undefined;
    }
    const current = node && node.type === 'split' ? node.sizes : null;
    if (
      current &&
      current.length === norm.length &&
      current.every((v, i) => Math.abs(v - norm[i]) < 0.5)
    ) {
      return;
    }
    setState(
      setWorkspaceLayout(
        state,
        active.id,
        setSizesAtPath(active.layout, path, norm),
      ),
    );
  };

  const toggleMaximize = (sessionId: string) => {
    setMaximizedId((cur) => (cur === sessionId ? null : sessionId));
    setFocusedId(sessionId);
  };

  // ---- view mode: grid (default, all panes at once) vs tabs (one at a time) ----

  // Switch the active workspace between the split grid and the tab strip. The
  // panes themselves are untouched — only their presentation changes — so no
  // terminal is torn down. Re-fit the visible terminal once the new view lays out.
  const setView = (view: 'grid' | 'tabs') => {
    if (!state || !active || currentView === view) return;
    setState(updateWorkspace(state, active.id, { view }));
    setMaximizedId(null);
    requestAnimationFrame(() => {
      const id = focusedId ?? collectSessionIds(active.layout)[0];
      if (id) handles.current.get(id)?.fit();
    });
  };

  // Activate a tab: it becomes the visible pane. Re-fit xterm after it un-hides
  // (going display:none -> block resizes it from 0; fit catches up immediately).
  const activateTab = (sessionId: string) => {
    setFocusedId(sessionId);
    requestAnimationFrame(() => handles.current.get(sessionId)?.fit());
  };

  // Append one empty terminal without disturbing the others (the tab strip "+").
  // Existing panes keep their sessionIds, so their terminals stay mounted; only
  // the split geometry is rebuilt (invisible in tabs view anyway).
  const addPane = () => {
    if (!state || !active) return;
    const ids = collectSessionIds(active.layout);
    const newId = createSessionId();
    setState(
      updateWorkspace(state, active.id, {
        layout: buildGrid(ids.length + 1, [...ids, newId]),
      }),
    );
    setFocusedId(newId);
    setMaximizedId(null);
  };

  // Drag-to-reorder tabs (browser-style). Rebuilds the layout in the new order;
  // every sessionId is preserved, so terminals stay mounted — only their
  // position changes. No-op unless `orderedIds` is a permutation of the current
  // panes. (Custom grid sash sizes reset, an acceptable trade for reordering.)
  const reorderPanes = (orderedIds: string[]) => {
    if (!state || !active) return;
    const current = collectSessionIds(active.layout);
    if (orderedIds.length !== current.length) return;
    const set = new Set(current);
    if (!orderedIds.every((id) => set.has(id))) return;
    setState(
      updateWorkspace(state, active.id, {
        layout: buildGrid(orderedIds.length, orderedIds),
      }),
    );
  };

  // ---- memory import/export (PRD Epic 11) ----

  const exportSetup = useCallback(
    async (
      layer: 'workspace' | 'full',
    ): Promise<ExportPayload | { error: string }> => {
      if (!state) return { error: 'Nothing to export yet.' };
      const stamp = new Date()
        .toISOString()
        .slice(0, 16)
        .replace(/[:T]/g, '-');
      if (layer === 'workspace' || !sessionArchive) {
        const bundle = buildWorkspaceBundle(state);
        return {
          filename: `chorus-workspace-${stamp}.chorus`,
          body: serializeBundle(bundle),
        };
      }
      // Layer 2 (full): capture any missing Claude ids, annotate + persist the
      // state, then gather each pane's transcript via the SessionArchive.
      const sa = sessionArchive;
      const workspaces = await Promise.all(
        state.workspaces.map(async (w) => ({
          ...w,
          sessions: await Promise.all(
            w.sessions.map(async (s) => {
              if (s.claudeSessionId) return s;
              const cid = await sa.captureSessionId(s.sessionId, s.cwd);
              return cid ? { ...s, claudeSessionId: cid } : s;
            }),
          ),
        })),
      );
      const annotated: WorkspaceState = { ...state, workspaces };
      setState(annotated); // persist the captured ids onto the session records
      const items = workspaces
        .flatMap((w) => w.sessions)
        .filter((s) => s.claudeSessionId)
        .map((s) => ({ sessionId: s.claudeSessionId as string, cwd: s.cwd }));
      const conversations = await sa.exportConversations(items);
      const bundle: ChorusBundle = {
        ...buildWorkspaceBundle(annotated),
        conversations,
      };
      return {
        filename: `chorus-full-${stamp}.chorus`,
        body: serializeBundle(bundle),
      };
    },
    [state, sessionArchive],
  );

  const importSetup = useCallback(
    async (bundle: ChorusBundle, mode: ImportMode): Promise<ImportResult> => {
      const base = state ?? defaultWorkspaceState(defaultCwd);
      // On replace, tear down every current live PTY before swapping state in.
      if (mode === 'replace') {
        for (const ws of base.workspaces) {
          for (const s of ws.sessions) manager.remove(s.sessionId);
        }
        handles.current.clear();
      }
      // Conversations still LIVE in the current list after the teardown (merge
      // mode keeps them running). An imported pane pointing at one of these must
      // resume with --fork-session: resuming the same conversation in a second
      // pane would replace the live session's state with the transcript replay.
      const liveClaudeIds = new Set(
        base.workspaces
          .flatMap((w) => w.sessions)
          .filter((s) => s.claudeSessionId && manager.has(s.sessionId))
          .map((s) => s.claudeSessionId as string),
      );
      const { state: next, result } = reconcileImport(base, bundle, mode);

      // Layer-2: write transcripts under this machine's slug BEFORE respawning,
      // so each pane's `--resume` finds its conversation. Identity remap for now
      // (same path); cross-machine relocation is a documented follow-up (US-11.7).
      let finalResult = result;
      if (bundle.conversations && bundle.conversations.length > 0) {
        if (sessionArchive) {
          const r = await sessionArchive.importConversations(
            bundle.conversations,
            (p) => p,
          );
          finalResult = {
            ...result,
            conversationsImported: r.imported,
            conversationsSkipped: r.skipped,
            warnings: [...result.warnings, ...r.warnings],
          };
        } else {
          finalResult = {
            ...result,
            warnings: [
              ...result.warnings,
              'This bundle has conversations, which need the desktop app to restore.',
            ],
          };
        }
      }

      // A forked pane continues the conversation under a NEW id, so its saved
      // claudeSessionId is stale the moment it spawns. Drop it from the
      // persisted state (the health poll re-captures and persists the fork's id
      // on its next tick); the spawn below still resumes from the original.
      const persisted: WorkspaceState = {
        ...next,
        workspaces: next.workspaces.map((w) => ({
          ...w,
          sessions: w.sessions.map((s) => {
            if (
              !s.claudeSessionId ||
              !liveClaudeIds.has(s.claudeSessionId) ||
              manager.has(s.sessionId)
            ) {
              return s;
            }
            const { claudeSessionId: _stale, ...rest } = s;
            return rest;
          }),
        })),
      };
      setState(persisted);
      const active = getActiveWorkspace(next);
      if (active) void ensureSpawned(active, { liveClaudeIds });
      setFocusedId(null);
      setMaximizedId(null);
      return finalResult;
    },
    [state, manager, defaultCwd, ensureSpawned, sessionArchive],
  );

  // ---- voice dictation (PRD Epic 9) ----

  const engines = useMemo(() => transcribers ?? [], [transcribers]);
  const [availableEngines, setAvailableEngines] = useState<Set<TranscriberId>>(
    new Set(),
  );
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      engines.map(async (t) => ((await t.isAvailable()) ? t.id : null)),
    ).then((ids) => {
      if (!cancelled) {
        setAvailableEngines(new Set(ids.filter((x): x is TranscriberId => !!x)));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [engines]);

  const voiceSettings: VoiceSettings = state?.settings?.voice ?? DEFAULT_VOICE_SETTINGS;
  const setVoiceSettings = useCallback((next: VoiceSettings) => {
    setState((prev) =>
      prev ? { ...prev, settings: { ...prev.settings, voice: next } } : prev,
    );
  }, []);

  const activeTranscriber = useMemo(() => {
    const avail = engines.filter((t) => availableEngines.has(t.id));
    return avail.find((t) => t.id === voiceSettings.engineId) ?? avail[0] ?? null;
  }, [engines, availableEngines, voiceSettings.engineId]);

  const writeToSession = useCallback(
    (sid: string, data: string) => manager.write(sid, data),
    [manager],
  );
  const focusedIsLive = focusedId != null && manager.has(focusedId);
  const voice = useVoiceCapture({
    transcriber: activeTranscriber,
    mode: voiceSettings.mode,
    focusedSessionId: focusedId,
    canCapture: focusedIsLive,
    write: writeToSession,
  });
  useVoiceHotkey(voiceSettings.hotkey, voice);
  const voiceEnabled = engines.length > 0;

  // ---- swarm (PRD Epic 10) ----

  const [swarmOpen, setSwarmOpen] = useState(false);
  const swarmWriter = useMemo(
    () => ({ write: (id: string, d: string) => manager.write(id, d) }),
    [manager],
  );
  const swarmLookup = useCallback(
    (swarmId: string): SwarmDef | undefined => {
      if (!state) return undefined;
      for (const ws of state.workspaces) {
        const s = ws.swarms?.find((x) => x.swarmId === swarmId);
        if (s) return s;
      }
      return undefined;
    },
    [state],
  );
  const orchestrator = useMemo(
    () => new SwarmOrchestrator(swarmWriter, swarmLookup),
    [swarmWriter, swarmLookup],
  );

  const adHocBroadcast = useCallback(
    (sessionIds: string[], text: string, submit: boolean) =>
      broadcastTo(swarmWriter, sessionIds, text, submit),
    [swarmWriter],
  );

  // Probe whether a chosen fan-out directory is a git repo (worktree isolation
  // needs one). Stable identity so the panel's debounced check doesn't re-fire
  // every render. Resolves false when the host can't check (web).
  const checkGitRepo = useCallback(
    (dir: string): Promise<boolean> =>
      swarmWorkspace?.isGitRepo(dir) ?? Promise.resolve(false),
    [swarmWorkspace],
  );

  const createSwarm = useCallback(
    (name: string, task: string, members: { sessionId: string; role?: string }[]) => {
      if (!state || !active) return;
      const def: SwarmDef = {
        swarmId: createSwarmId(),
        workspaceId: active.id,
        name,
        task: task.trim() || undefined,
        members,
      };
      setState(upsertSwarm(state, active.id, def));
    },
    [state, active],
  );

  const removeSwarmById = useCallback(
    (swarmId: string) => {
      if (!state || !active) return;
      setState(removeSwarm(state, active.id, swarmId));
    },
    [state, active],
  );

  const runFanOut = useCallback(
    async (
      name: string,
      task: string,
      requestedWorkers: { role: string; task: string; dir?: string }[],
      autoStart: boolean,
      dir: string,
    ) => {
      if (!state || !active) return;
      // Never fan out more agents than the layout can show: one pane per agent,
      // grid caps at MAX_SWARM_AGENTS. The UI already disables adding past it; this
      // is the backstop so no caller can build an unrenderable swarm.
      const workers = clampSwarmWorkers(requestedWorkers);
      // The default directory; each worker may override it with its own (its own
      // repo), so one swarm can span several repos.
      const defaultDir = dir.trim() || active.defaultCwd;
      const sharedTask = task.trim() || undefined;
      // Collapse newlines so a task stays a single positional CLI arg.
      const oneLine = (s: string) => s.replace(/\s*\n\s*/g, ' ').trim();

      // Tear down the current sessions + any prior worktrees before re-laying out.
      for (const s of active.sessions) {
        try {
          manager.remove(s.sessionId);
        } catch {
          /* already gone */
        }
      }
      handles.current.clear();
      cleanupWorktrees();

      const host = swarmWorkspace;

      const members: SwarmMember[] = workers.map((w) => ({
        sessionId: createSessionId(),
        role: w.role.trim() || undefined,
        task: oneLine(w.task) || undefined,
      }));
      // The directory each worker runs in (its own repo, or the default),
      // parallel to members.
      const workerDirs = workers.map((w) => w.dir?.trim() || defaultDir);
      const ids = members.map((m) => m.sessionId);
      const swarmId = createSwarmId();
      const def: SwarmDef = {
        swarmId,
        workspaceId: active.id,
        name,
        task: sharedTask,
        members,
      };

      // Create an isolated worktree + branch per worker (best-effort). The run id
      // (from the unique swarmId) keeps re-runs of a same-named swarm from
      // colliding with the previous run's branches.
      const plan = planAgentWorktrees(
        name,
        members.map((m) => m.role ?? ''),
        swarmId.slice(-6),
      );
      // Per worker: if its directory is a git repo, isolate it in a worktree +
      // branch inside that repo; otherwise it runs directly in the directory
      // (shared if several agents point at the same non-repo dir). Checking the
      // repo per worker is what lets a swarm span several repos.
      const workerCwds: string[] = [];
      for (let i = 0; i < members.length; i++) {
        const wdir = workerDirs[i];
        let wcwd = wdir;
        if (host?.available && (await host.isGitRepo(wdir))) {
          const wt = await host.createWorktree(
            wdir,
            plan[i].worktreeSubdir,
            plan[i].branch,
          );
          if (wt) {
            wcwd = wt;
            activeWorktrees.current.push({ repoDir: wdir, worktreeDir: wt });
            // Record the worktree identity on the member so the review/merge
            // view can act on this branch (persisted; survives reload).
            members[i].repoDir = wdir;
            members[i].branch = plan[i].branch;
            members[i].worktreeDir = wt;
          }
        }
        workerCwds.push(wcwd);
      }

      // Each agent gets a pinned Claude id too (same Epic-11 exactness as
      // startSession), so swarm panes export/resume their own conversations.
      const configs: SessionConfig[] = members.map((m, i) => ({
        sessionId: m.sessionId,
        title: `${m.role ?? 'agent'} · ${name}`,
        cwd: workerCwds[i],
        ...(sessionArchive ? { claudeSessionId: crypto.randomUUID() } : {}),
      }));
      let next = updateWorkspace(state, active.id, {
        mode: 'swarm',
        layout: buildRow(ids),
        sessions: configs,
      });
      next = upsertSwarm(next, active.id, def);
      setState(next);
      setFocusedId(ids[0] ?? null);
      setMaximizedId(null);

      // Permission posture: hands-off (permissionless skips the trust dialog +
      // tool prompts) when auto-starting, else keep approval prompts so the human
      // gates each tool call.
      const permissionMode = autoStart ? 'permissionless' : 'default';

      // Spawn each worker with its task as the positional prompt — it auto-submits
      // as the first user turn and stays interactive. No typing into the TUI. Each
      // agent is told to self-verify (see buildAgentSystemPrompt), so there is no
      // separate verifier agent.
      for (let i = 0; i < members.length; i++) {
        const m = members[i];
        // `isolated` is true only when a worktree was actually created (the cwd
        // moved off the worker's dir) — tell the agent the truth and pin its dir.
        const isolated = workerCwds[i] !== workerDirs[i];
        const command = buildClaudeLaunch({
          prompt: m.task,
          systemPrompt: buildAgentSystemPrompt(
            name,
            m.role,
            sharedTask,
            workerCwds[i],
            isolated,
          ),
          permissionMode,
          ...(configs[i].claudeSessionId
            ? { sessionId: configs[i].claudeSessionId }
            : {}),
        });
        await manager.spawn(configs[i], { cols: 80, rows: 24 }, { command });
      }
    },
    [state, active, manager, swarmWorkspace, cleanupWorktrees, sessionArchive],
  );

  // Fan out, confirming first if the current workspace has live work (the swarm
  // replaces the whole layout).
  const fanOut = useCallback(
    (
      name: string,
      task: string,
      workers: { role: string; task: string; dir?: string }[],
      autoStart: boolean,
      dir: string,
    ) => {
      guardActive(
        'Replace the current terminals with this swarm?',
        'Fan out',
        () => void runFanOut(name, task, workers, autoStart, dir),
      );
    },
    [guardActive, runFanOut],
  );

  // Explicit exit from swarm "board mode": tear the swarm down and return to a
  // clean manual single pane (confirming if agents are still working).
  // setLayoutPanes already clears the worktrees and mode.
  const endSwarm = () =>
    guardActive('End the swarm and return to manual terminals?', 'End swarm', () =>
      setLayoutPanes(1),
    );

  // ---- swarm review / merge (the payoff of worktree isolation) ----

  const [reviewOpen, setReviewOpen] = useState(false);

  // Agents that produced an isolated branch+worktree (review/merge targets),
  // gathered across the active workspace's swarms. Empty when agents shared a dir.
  const reviewMembers: ReviewMember[] = useMemo(() => {
    const out: ReviewMember[] = [];
    for (const sw of active?.swarms ?? []) {
      for (const m of sw.members) {
        if (m.repoDir && m.branch && m.worktreeDir) {
          out.push({
            sessionId: m.sessionId,
            role: m.role,
            repoDir: m.repoDir,
            branch: m.branch,
            worktreeDir: m.worktreeDir,
          });
        }
      }
    }
    return out;
  }, [active]);

  const reviewMember = useCallback(
    (m: ReviewMember) =>
      swarmWorkspace?.reviewWorktree(m.repoDir, m.branch, m.worktreeDir) ??
      Promise.reject(new Error('Review unavailable on this host.')),
    [swarmWorkspace],
  );

  const mergeMember = useCallback(
    (m: ReviewMember, squash: boolean) =>
      swarmWorkspace?.mergeWorktree(m.repoDir, m.branch, m.worktreeDir, { squash }) ??
      Promise.resolve({ ok: false, conflict: false, message: 'Merge unavailable on this host.' }),
    [swarmWorkspace],
  );

  // Discard = remove the worktree + delete the branch, then drop the worktree
  // identity off the member so its review row disappears. Confirmed first.
  const discardMember = useCallback(
    (m: ReviewMember) =>
      new Promise<void>((resolve) => {
        guardActive(
          `Discard the "${m.role ?? 'agent'}" agent's branch and its work?`,
          'Discard',
          () => {
            void (async () => {
              await swarmWorkspace?.discardWorktree(m.repoDir, m.worktreeDir, m.branch);
              activeWorktrees.current = activeWorktrees.current.filter(
                (wt) => wt.worktreeDir !== m.worktreeDir,
              );
              setState((prev) => {
                if (!prev) return prev;
                return {
                  ...prev,
                  workspaces: prev.workspaces.map((ws) => ({
                    ...ws,
                    swarms: ws.swarms?.map((sw) => ({
                      ...sw,
                      members: sw.members.map((mem) =>
                        mem.sessionId === m.sessionId
                          ? { ...mem, repoDir: undefined, branch: undefined, worktreeDir: undefined }
                          : mem,
                      ),
                    })),
                  })),
                };
              });
              resolve();
            })();
          },
        );
      }),
    [guardActive, swarmWorkspace],
  );

  // ---- rendering ----

  const renderPane = (sessionId: string) => {
    const focused = focusedId === sessionId;
    const isLive = manager.has(sessionId);
    const status = statusOf(sessionId);
    const title = state ? findSession(state, sessionId)?.cfg.title : undefined;
    const maximized = maximizedId === sessionId;

    return (
      <div
        onMouseDown={() => setFocusedId(sessionId)}
        style={{
          width: '100%',
          height: '100%',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          border: '2px solid',
          borderColor: focused ? 'var(--accent)' : 'var(--border)',
          background: 'var(--bg)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '3px 8px',
            background: 'var(--bg-elevated)',
            borderBottom: '1px solid var(--border)',
            minHeight: 24,
          }}
        >
          {status && <StatusBadge status={status} pulse={status === 'waiting'} />}
          {healthById.get(sessionId) && (
            <ContextHealthBadge
              health={healthById.get(sessionId)!}
              onHandoff={() => handoff(sessionId)}
            />
          )}
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: 11,
              color: 'var(--fg-muted)',
            }}
          >
            {title ?? 'empty pane'}
          </span>
          {currentView !== 'tabs' && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                toggleMaximize(sessionId);
              }}
              title={maximized ? 'Restore' : 'Maximize'}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--fg-muted)',
                cursor: 'pointer',
                fontSize: 13,
                lineHeight: 1,
                padding: '0 2px',
              }}
            >
              {maximized ? '🗗' : '🗖'}
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              closePane(sessionId);
            }}
            title="Close pane"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--fg-muted)',
              cursor: 'pointer',
              fontSize: 14,
              lineHeight: 1,
              padding: '0 2px',
            }}
          >
            ✕
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0 }}>
          {isLive ? (
            <SessionTerminal
              manager={manager}
              sessionId={sessionId}
              onFocus={() => setFocusedId(sessionId)}
              onRegister={(id, h) => {
                if (h) handles.current.set(id, h);
                else handles.current.delete(id);
              }}
            />
          ) : (
            <PaneLauncher
              defaultCwd={active?.defaultCwd ?? defaultCwd}
              onStart={(cwd, command, title) =>
                startSession(sessionId, cwd, command, title)
              }
            />
          )}
        </div>
      </div>
    );
  };

  if (!state || !active) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          background: 'var(--bg)',
          color: 'var(--fg-muted)',
        }}
      >
        Loading…
      </div>
    );
  }

  const paneCount = countPanes(active.layout);
  const showMaximized =
    maximizedId !== null && collectSessionIds(active.layout).includes(maximizedId);

  return (
    <div
      style={{
        display: 'flex',
        height: '100%',
        background: 'var(--bg)',
        color: 'var(--fg)',
      }}
    >
      {sidebarOpen ? (
        <Sidebar
          state={state}
          statusOf={statusOf}
          collapsed={collapsed}
          focusedId={focusedId}
          onSelectWorkspace={selectWorkspace}
          onToggleCollapse={toggleCollapse}
          onNewWorkspace={newWorkspace}
          onRenameWorkspace={renameWorkspace}
          onCloseWorkspace={closeWorkspace}
          onFocusSession={focusSession}
          onRenameSession={renameSession}
          onCloseSession={closeSession}
          onCollapse={() => setSidebarOpen(false)}
        />
      ) : (
        <div
          style={{
            width: 40,
            flexShrink: 0,
            height: '100%',
            background: 'var(--bg-elevated)',
            borderRight: '1px solid var(--border)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 10,
            padding: '11px 0',
          }}
        >
          <button
            onClick={() => setSidebarOpen(true)}
            title="Expand sidebar"
            aria-label="Expand sidebar"
            style={{
              background: 'transparent',
              color: 'var(--fg-muted)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: '3px 7px',
              cursor: 'pointer',
              fontSize: 12,
              lineHeight: 1,
            }}
          >
            »
          </button>
          <button
            onClick={() => {
              setSidebarOpen(true);
              newWorkspace();
            }}
            title="New workspace"
            aria-label="New workspace"
            style={{
              background: 'transparent',
              color: 'var(--fg-muted)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: '3px 7px',
              cursor: 'pointer',
              fontSize: 13,
              lineHeight: 1,
            }}
          >
            +
          </button>
          <span
            className="eyebrow"
            title={`${state.workspaces.length} workspaces`}
            style={{
              writingMode: 'vertical-rl',
              transform: 'rotate(180deg)',
              marginTop: 6,
              letterSpacing: '0.28em',
            }}
          >
            Workspaces · {state.workspaces.length}
          </span>
        </div>
      )}

      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '8px 12px',
            background: 'var(--bg-elevated)',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <strong
            className="disp"
            style={{
              color: 'var(--accent)',
              fontWeight: 700,
              fontSize: 16,
              letterSpacing: '-0.02em',
            }}
          >
            chorus
          </strong>
          <span
            style={{
              color: 'var(--fg)',
              fontSize: 12,
              fontWeight: 600,
              maxWidth: 220,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {active.name}
          </span>
          <div
            role="group"
            aria-label="View mode"
            title="Grid shows every terminal at once; Tabs shows one at a time"
            style={{
              display: 'inline-flex',
              padding: 2,
              gap: 2,
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: 'var(--bg)',
            }}
          >
            {(['grid', 'tabs'] as const).map((v) => {
              const on = currentView === v;
              return (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  title={v === 'grid' ? 'Grid view' : 'Tabs view'}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    background: on ? 'var(--bg-elevated)' : 'transparent',
                    color: on ? 'var(--accent)' : 'var(--fg-muted)',
                    border: '1px solid',
                    borderColor: on ? 'var(--border)' : 'transparent',
                    borderRadius: 6,
                    padding: '3px 9px',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    fontSize: 11,
                    fontWeight: on ? 600 : 400,
                  }}
                >
                  {v === 'grid' ? '⊞' : '◫'} {v === 'grid' ? 'Grid' : 'Tabs'}
                </button>
              );
            })}
          </div>
          {swarmMode ? (
            <>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'var(--accent)',
                  border: '1px solid var(--accent)',
                  borderRadius: 6,
                  padding: '3px 10px',
                }}
                title="This workspace is running a swarm. Manual terminal controls are locked."
              >
                ⚇ Swarm active
              </span>
              {swarmWorkspace?.available && reviewMembers.length > 0 && (
                <button
                  onClick={() => setReviewOpen(true)}
                  title="Review each agent's branch and merge or discard it"
                  style={{
                    background: 'var(--bg)',
                    color: 'var(--fg)',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    padding: '4px 12px',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  ⎇ Review ({reviewMembers.length})
                </button>
              )}
              <button
                onClick={endSwarm}
                title="Tear down the swarm and return to manual terminals"
                style={{
                  background: 'var(--bg)',
                  color: 'var(--fg)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: '4px 12px',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                End swarm
              </button>
            </>
          ) : (
            <>
              <label
                htmlFor="terminal-count"
                style={{ color: 'var(--fg-muted)', fontSize: 12 }}
              >
                Terminals
              </label>
              <select
                id="terminal-count"
                value={paneCount}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (n === paneCount) return;
                  guardActive(
                    `Lay out ${n} terminal${n > 1 ? 's' : ''}?`,
                    'Change layout',
                    () => setLayoutPanes(n),
                  );
                }}
                title="How many terminals to lay out"
                style={{
                  background: 'var(--bg)',
                  color: 'var(--fg)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: '4px 8px',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {TERMINAL_COUNTS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <button
                onClick={() =>
                  guardActive(
                    'Reset to a single clean pane?',
                    'Reset',
                    () => resetView(),
                  )
                }
                title="Reset to a single clean pane (recover a broken view)"
                style={{
                  background: 'var(--bg)',
                  color: 'var(--fg)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: '4px 12px',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                ↺ Reset
              </button>
            </>
          )}
          <div
            style={{
              marginLeft: 'auto',
              display: 'flex',
              gap: 8,
              alignItems: 'center',
            }}
          >
            {maximizedId !== null && (
              <button
                onClick={() => setMaximizedId(null)}
                title="Restore grid"
                style={{
                  background: 'var(--bg)',
                  color: 'var(--fg)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: '4px 12px',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                🗗 Restore
              </button>
            )}
            <HelpButton />
            <button
              onClick={() => setSwarmOpen(true)}
              title="Coordinate several sessions on one task"
              style={{
                background: 'var(--bg)',
                color: 'var(--fg)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: '4px 10px',
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              ⚇ Swarm
            </button>
            {voiceEnabled && (
              <>
                <VoiceMicButton
                  status={voice.status}
                  disabled={!activeTranscriber || !focusedIsLive}
                  disabledReason={
                    !activeTranscriber
                      ? 'No voice engine available'
                      : 'Focus a running session to dictate'
                  }
                  onToggle={voice.toggle}
                />
                <VoiceSettingsButton
                  transcribers={engines}
                  availableIds={availableEngines}
                  settings={voiceSettings}
                  onChange={setVoiceSettings}
                />
              </>
            )}
            <MemoryControls
              onExport={exportSetup}
              onImport={importSetup}
              fullSupported={!!sessionArchive}
            />
          </div>
        </header>

        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          <ErrorBoundary resetKey={active.id}>
            {currentView === 'tabs' ? (
              <TabbedView
                sessionIds={collectSessionIds(active.layout)}
                activeId={focusedId}
                onActivate={activateTab}
                onClose={closePane}
                onAdd={paneCount < 6 && !swarmMode ? addPane : undefined}
                onReorder={reorderPanes}
                titleOf={(id) =>
                  state ? findSession(state, id)?.cfg.title : undefined
                }
                statusOf={statusOf}
                renderPane={renderPane}
              />
            ) : showMaximized ? (
              renderPane(maximizedId!)
            ) : (
              <LayoutView
                node={active.layout}
                renderPane={renderPane}
                onSizes={onSizes}
              />
            )}
          </ErrorBoundary>
        </div>
      </div>

      {swarmOpen && active && (
        <SwarmPanel
          workspace={active}
          statusOf={statusOf}
          worktreesAvailable={!!swarmWorkspace?.available}
          checkGitRepo={checkGitRepo}
          onClose={() => setSwarmOpen(false)}
          onBroadcast={adHocBroadcast}
          onCreateSwarm={createSwarm}
          onRemoveSwarm={removeSwarmById}
          onSwarmBroadcast={(id, text, submit) =>
            orchestrator.broadcast(id, text, { submit })
          }
          onSwarmStopAll={(id) => orchestrator.stopAll(id)}
          onFanOut={fanOut}
          onFocusSession={focusSession}
        />
      )}

      {reviewOpen && (
        <DiffReview
          members={reviewMembers}
          statusOf={statusOf}
          review={reviewMember}
          merge={mergeMember}
          discard={discardMember}
          onFocusSession={focusSession}
          onClose={() => setReviewOpen(false)}
        />
      )}

      {voiceEnabled && (
        <RecordingIndicator
          status={voice.status}
          onStop={voice.stop}
          onCancel={voice.cancel}
        />
      )}
      {voice.error && (
        <div
          onClick={voice.clearError}
          role="alert"
          style={{
            position: 'fixed',
            bottom: 16,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 61,
            background: 'var(--status-waiting)',
            color: 'var(--crust)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: '8px 14px',
            fontSize: 12,
            cursor: 'pointer',
            maxWidth: 420,
          }}
        >
          {voice.error} · click to dismiss
        </div>
      )}

      {pendingConfirm && (
        <div
          onClick={() => setPendingConfirm(null)}
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 70,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              borderRadius: 10,
              padding: 20,
              width: 420,
              maxWidth: '92%',
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
              color: 'var(--fg)',
            }}
          >
            <div style={{ fontSize: 13, lineHeight: 1.5 }}>
              {pendingConfirm.message}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setPendingConfirm(null)}
                style={{
                  background: 'var(--bg)',
                  color: 'var(--fg)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: '7px 14px',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontSize: 12,
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const action = pendingConfirm.onConfirm;
                  setPendingConfirm(null);
                  action();
                }}
                style={{
                  background: 'var(--status-waiting)',
                  color: 'var(--crust)',
                  border: 'none',
                  borderRadius: 6,
                  padding: '7px 14px',
                  cursor: 'pointer',
                  fontWeight: 600,
                  fontFamily: 'inherit',
                  fontSize: 12,
                }}
              >
                {pendingConfirm.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
