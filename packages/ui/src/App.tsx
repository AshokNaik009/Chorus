import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addWorkspace,
  broadcastTo,
  buildAgentSystemPrompt,
  buildClaudeLaunch,
  buildRow,
  buildTemplate,
  buildVerifierTask,
  buildWorkspaceBundle,
  collectSessionIds,
  countPanes,
  createSessionId,
  createSwarmId,
  createWorkspace,
  DEFAULT_VOICE_SETTINGS,
  defaultWorkspaceState,
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
  workersReleaseVerifier,
  type ChorusBundle,
  type ImportMode,
  type ImportResult,
  type LayoutNode,
  type LayoutTemplate,
  type Persistence,
  type Session,
  type SessionArchive,
  type SessionConfig,
  type SessionManager,
  type SessionStatus,
  type SwarmDef,
  type SwarmWorkspace,
  type Transcriber,
  type TranscriberId,
  type VoiceSettings,
  type Workspace,
  type WorkspaceState,
} from '@app/core';
import { LayoutView } from './LayoutView.js';
import { Sidebar } from './Sidebar.js';
import { SessionTerminal } from './SessionTerminal.js';
import { PaneLauncher } from './PaneLauncher.js';
import { StatusBadge } from './StatusBadge.js';
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

const TEMPLATES: LayoutTemplate[] = [1, 2, 3, 4, 6];
const TEMPLATE_LABELS: Record<LayoutTemplate, string> = {
  1: '1',
  2: '1×2',
  3: '1×3',
  4: '2×2',
  6: '2×3',
};

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

  const handles = useRef(new Map<string, TerminalPaneHandle>());

  // Git worktrees created for the active swarm fan-out (Epic 10). Torn down on a
  // reset, workspace close, or the next fan-out so they don't accumulate.
  const activeWorktrees = useRef<{ repoDir: string; worktreeDir: string }[]>([]);
  const cleanupWorktrees = useCallback(() => {
    const wts = activeWorktrees.current;
    activeWorktrees.current = [];
    for (const wt of wts) {
      void swarmWorkspace?.removeWorktree(wt.repoDir, wt.worktreeDir);
    }
  }, [swarmWorkspace]);

  // Re-spawn a workspace's saved sessions that aren't live yet. Idempotent:
  // manager.spawn() no-ops on an id it already owns.
  const ensureSpawned = useCallback(
    (ws: Workspace) => {
      for (const cfg of ws.sessions) {
        if (!manager.has(cfg.sessionId)) {
          // A pane with a captured Claude id (from a Layer-2 import) relaunches
          // with `--resume` so it restores its prior conversation (PRD US-11.5).
          const command = buildClaudeLaunch({
            resumeSessionId: cfg.claudeSessionId,
          });
          void manager.spawn(cfg, { cols: 80, rows: 24 }, { command });
        }
      }
    },
    [manager],
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
      if (active) ensureSpawned(active);
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
  // Completed turns (Stop hooks) per session — the verifier gate reads this, not
  // `status`, because CLI-arg agents never enter `running`.
  const turnsById = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of live) m.set(s.config.sessionId, s.turnsCompleted);
    return m;
  }, [live]);
  const statusOf = useCallback(
    (id: string): SessionStatus | null => statusById.get(id) ?? null,
    [statusById],
  );

  const active = state ? getActiveWorkspace(state) : undefined;

  // ---- workspace handlers ----

  const selectWorkspace = (id: string) => {
    if (!state) return;
    setState(setActiveWorkspace(state, id));
    const ws = state.workspaces.find((w) => w.id === id);
    if (ws) ensureSpawned(ws);
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
    const next = removeWorkspace(state, id);
    // Update state FIRST so the removal always lands, then tear down PTYs — a
    // throw in backend.kill can never strand the workspace in the sidebar.
    setState(next);
    setFocusedId(null);
    setMaximizedId(null);
    cleanupWorktrees();
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
    if (nextActive) ensureSpawned(nextActive);
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

  const selectTemplate = (n: LayoutTemplate) => {
    if (!state || !active) return;
    for (const s of active.sessions) manager.remove(s.sessionId);
    handles.current.clear();
    cleanupWorktrees();
    pendingFanOut.current = null;
    setQueuedVerifierId(null);
    setState(
      updateWorkspace(state, active.id, {
        layout: buildTemplate(n),
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
    // The launcher's "claude" becomes a blank interactive session (no prompt
    // arg); a shell command passes through unchanged.
    const spawnCommand = isClaude ? buildClaudeLaunch() : command;
    const cfg: SessionConfig = {
      sessionId,
      title: title?.trim() || `${label} · ${basename(cwd)}`,
      cwd,
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
  // layout/view). Tears down this workspace's sessions, like selecting the
  // 1-pane template.
  const resetView = () => selectTemplate(1);

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
        ensureSpawned(found.ws);
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

      setState(next);
      const active = getActiveWorkspace(next);
      if (active) ensureSpawned(active);
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
  // The deferred verifier's pane id, while it is held. Drives a "queued"
  // placeholder so the pane never looks like a dead agent that lost its prompt.
  const [queuedVerifierId, setQueuedVerifierId] = useState<string | null>(null);
  // In-flight fan-out with a deferred verifier: the verifier pane is held until
  // every worker has finished its first turn, then spawned by the effect below.
  // The workers' prompts are CLI args (auto-submit), so there is no seed-typing.
  const pendingFanOut = useRef<{
    workerIds: string[];
    verifier: { config: SessionConfig; command: string };
  } | null>(null);
  const workerHasRun = useRef<Set<string>>(new Set());
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

  const fanOut = useCallback(
    async (
      name: string,
      task: string,
      workers: { role: string; task: string; dir?: string }[],
      verifier: { task: string } | null,
      autoStart: boolean,
      dir: string,
    ) => {
      if (!state || !active) return;
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
      // Drop any verifier still queued from a previous fan-out.
      pendingFanOut.current = null;
      setQueuedVerifierId(null);

      const host = swarmWorkspace;

      const workerMembers = workers.map((w) => ({
        sessionId: createSessionId(),
        role: w.role.trim() || undefined,
        task: oneLine(w.task) || undefined,
        gated: false,
      }));
      // The directory each worker runs in (its own repo, or the default),
      // parallel to workerMembers. Kept off the persisted member.
      const workerDirs = workers.map((w) => w.dir?.trim() || defaultDir);
      const verifierMember = verifier
        ? {
            sessionId: createSessionId(),
            role: 'verifier',
            // The (possibly edited) verifier prompt is stored as a full override.
            seedPrompt: oneLine(verifier.task) || undefined,
            gated: true,
          }
        : null;
      const members = verifierMember
        ? [...workerMembers, verifierMember]
        : workerMembers;
      const ids = members.map((m) => m.sessionId);
      const swarmId = createSwarmId();
      const def: SwarmDef = {
        swarmId,
        workspaceId: active.id,
        name,
        task: sharedTask,
        members,
      };

      // Create an isolated worktree + branch per worker (best-effort). The branch
      // names are appended to the verifier's prompt so it knows where to review.
      // The run id (from the unique swarmId) keeps re-runs of a same-named swarm
      // from colliding with the previous run's branches.
      const plan = planAgentWorktrees(
        name,
        workerMembers.map((m) => m.role ?? ''),
        swarmId.slice(-6),
      );
      // Per worker: if its directory is a git repo, isolate it in a worktree +
      // branch inside that repo; otherwise it runs directly in the directory
      // (shared if several agents point at the same non-repo dir). Checking the
      // repo per worker is what lets a swarm span several repos.
      const branches: string[] = [];
      const workerCwds: string[] = [];
      for (let i = 0; i < workerMembers.length; i++) {
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
            branches.push(plan[i].branch);
            activeWorktrees.current.push({ repoDir: wdir, worktreeDir: wt });
          }
        }
        workerCwds.push(wcwd);
      }

      const configs: SessionConfig[] = members.map((m, i) => ({
        sessionId: m.sessionId,
        title: `${m.role ?? 'agent'} · ${name}`,
        // Workers run in their own worktree/dir; the verifier reviews from the
        // default directory (the integration point).
        cwd: m.gated ? defaultDir : workerCwds[i],
      }));
      let next = updateWorkspace(state, active.id, {
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
      // as the first user turn and stays interactive. No typing into the TUI.
      for (let i = 0; i < workerMembers.length; i++) {
        const m = workerMembers[i];
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
        });
        await manager.spawn(configs[i], { cols: 80, rows: 24 }, { command });
      }

      if (verifierMember) {
        const verifierCfg = configs[configs.length - 1];
        const verifierCommand = buildClaudeLaunch({
          prompt: buildVerifierTask(
            oneLine(verifier!.task) || undefined,
            branches,
          ),
          permissionMode,
        });
        if (autoStart) {
          // Defer: the verifier pane shows a "queued" placeholder until every
          // worker has finished its first turn, then the effect below spawns it.
          workerHasRun.current = new Set();
          pendingFanOut.current = {
            workerIds: workerMembers.map((m) => m.sessionId),
            verifier: { config: verifierCfg, command: verifierCommand },
          };
          setQueuedVerifierId(verifierCfg.sessionId);
        } else {
          // Without auto-start nothing settles the workers to release the gate,
          // so run the verifier alongside them (its prompt still auto-submits).
          pendingFanOut.current = null;
          setQueuedVerifierId(null);
          await manager.spawn(verifierCfg, { cols: 80, rows: 24 }, {
            command: verifierCommand,
          });
        }
      } else {
        pendingFanOut.current = null;
        setQueuedVerifierId(null);
      }
    },
    [state, active, manager, swarmWorkspace, cleanupWorktrees],
  );

  // Defer-spawn the verifier off worker turn-completion: once every worker has
  // finished its first turn (a Stop hook → `turnsCompleted >= 1`) or exited,
  // spawn the verifier pane with its task. CLI-arg agents never enter `running`,
  // so the gate reads completed turns, not status. Progress is tracked in refs
  // and the spawn is idempotent (`manager.has` guard), so this never loops on its
  // own state (see the Allotment depth bug in memory).
  useEffect(() => {
    const pf = pendingFanOut.current;
    if (!pf) return;
    if (manager.has(pf.verifier.config.sessionId)) return; // already spawned

    // A worker is "done" with its first turn once it has a completed turn (Stop
    // hook) — or it crashed/exited (don't hang the verifier on a dead worker).
    for (const id of pf.workerIds) {
      const turns = turnsById.get(id) ?? 0;
      if (turns >= 1 || statusById.get(id) === 'exited') {
        workerHasRun.current.add(id);
      }
    }

    const workerStates = pf.workerIds.map((id) => {
      const st = statusById.get(id) ?? 'spawning';
      // A crashed worker counts as settled so it can't stall the verifier.
      return { hasRun: workerHasRun.current.has(id), status: st === 'exited' ? 'idle' : st };
    });
    if (workersReleaseVerifier(workerStates)) {
      const { config, command } = pf.verifier;
      pendingFanOut.current = null;
      setQueuedVerifierId(null);
      void manager.spawn(config, { cols: 80, rows: 24 }, { command });
      setFocusedId(config.sessionId);
    }
  }, [statusById, turnsById, manager]);

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
          ) : sessionId === queuedVerifierId ? (
            <div
              style={{
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                textAlign: 'center',
                padding: 16,
                color: 'var(--fg-muted)',
              }}
            >
              <div style={{ fontSize: 22 }}>⏳</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>
                Verifier queued
              </div>
              <div style={{ fontSize: 11.5, maxWidth: 280, lineHeight: 1.5 }}>
                Waiting for the worker agents to finish their first turn. The
                verifier starts automatically — its prompt will run then.
              </div>
            </div>
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
      />

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
          <strong style={{ color: 'var(--accent)' }}>Chorus</strong>
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
          <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>Layout</span>
          <div style={{ display: 'flex', gap: 4 }}>
            {TEMPLATES.map((n) => {
              const selected = paneCount === n;
              return (
                <button
                  key={n}
                  onClick={() => selectTemplate(n)}
                  title={`${n}-pane layout`}
                  style={{
                    background: selected ? 'var(--accent)' : 'var(--bg)',
                    color: selected ? '#0e1116' : 'var(--fg)',
                    border: '1px solid',
                    borderColor: selected ? 'var(--accent)' : 'var(--border)',
                    borderRadius: 6,
                    padding: '4px 12px',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    fontWeight: selected ? 600 : 400,
                  }}
                >
                  {TEMPLATE_LABELS[n]}
                </button>
              );
            })}
          </div>
          <button
            onClick={resetView}
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
            {showMaximized ? (
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
            color: '#1a1a1a',
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
    </div>
  );
}
