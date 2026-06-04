import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addWorkspace,
  broadcastTo,
  buildBlackboardDoc,
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
  getActiveWorkspace,
  planFanOut,
  reconcileImport,
  removePane,
  removeSessionConfig,
  removeSwarm,
  removeWorkspace,
  resumeArgs,
  serializeBundle,
  setActiveWorkspace,
  setSizesAtPath,
  setWorkspaceLayout,
  SwarmOrchestrator,
  updateWorkspace,
  upsertSession,
  upsertSwarm,
  type ChorusBundle,
  type ImportMode,
  type ImportResult,
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

  // Re-spawn a workspace's saved sessions that aren't live yet. Idempotent:
  // manager.spawn() no-ops on an id it already owns.
  const ensureSpawned = useCallback(
    (ws: Workspace) => {
      for (const cfg of ws.sessions) {
        if (!manager.has(cfg.sessionId)) {
          // A pane with a captured Claude id (from a Layer-2 import) relaunches
          // with `--resume` so it restores its prior conversation (PRD US-11.5).
          const command = cfg.claudeSessionId
            ? `claude ${resumeArgs(cfg.claudeSessionId).join(' ')}`
            : 'claude';
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
    const label = command === 'claude' ? 'claude' : 'shell';
    const cfg: SessionConfig = {
      sessionId,
      title: title?.trim() || `${label} · ${basename(cwd)}`,
      cwd,
    };
    void manager.spawn(cfg, { cols: 80, rows: 24 }, { command });
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
    setState(
      setWorkspaceLayout(
        state,
        active.id,
        setSizesAtPath(active.layout, path, sizes),
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
    async (name: string, task: string, roles: string[]) => {
      if (!state || !active) return;
      const ids = roles.map(() => createSessionId());
      const members = ids.map((id, i) => ({ sessionId: id, role: roles[i] || undefined }));
      const swarmId = createSwarmId();
      let def: SwarmDef = {
        swarmId,
        workspaceId: active.id,
        name,
        task: task.trim() || undefined,
        members,
      };

      // Tear down the current sessions in this workspace before re-laying it out.
      for (const s of active.sessions) {
        try {
          manager.remove(s.sessionId);
        } catch {
          /* already gone */
        }
      }
      handles.current.clear();

      // Create the shared blackboard if the host supports it (Electron).
      let sharedDir: string | null = null;
      if (swarmWorkspace?.available) {
        sharedDir = await swarmWorkspace.createBlackboard(
          swarmId,
          active.defaultCwd,
          buildBlackboardDoc(def),
        );
        if (sharedDir) def = { ...def, sharedDir };
      }

      const configs: SessionConfig[] = members.map((m) => ({
        sessionId: m.sessionId,
        title: `${m.role ?? 'agent'} · ${name}`,
        cwd: active.defaultCwd,
      }));
      let next = updateWorkspace(state, active.id, {
        layout: buildRow(ids),
        sessions: configs,
      });
      next = upsertSwarm(next, active.id, def);
      setState(next);
      setFocusedId(ids[0] ?? null);
      setMaximizedId(null);

      // Spawn each member, then seed it (insert; the user reviews and sends).
      for (const cfg of configs) {
        await manager.spawn(cfg, { cols: 80, rows: 24 }, { command: 'claude' });
      }
      const plan = planFanOut(def, sharedDir);
      // Give the Claude TUIs a beat to render before typing the seed in.
      window.setTimeout(() => {
        for (const p of plan) {
          if (manager.has(p.sessionId)) manager.write(p.sessionId, p.seed);
        }
      }, 1500);
    },
    [state, active, manager, swarmWorkspace],
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
          {showMaximized ? (
            renderPane(maximizedId!)
          ) : (
            <LayoutView
              node={active.layout}
              renderPane={renderPane}
              onSizes={onSizes}
            />
          )}
        </div>
      </div>

      {swarmOpen && active && (
        <SwarmPanel
          workspace={active}
          statusOf={statusOf}
          sharedDirAvailable={!!swarmWorkspace?.available}
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
        <RecordingIndicator status={voice.status} onCancel={voice.cancel} />
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
