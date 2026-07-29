import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  groupSessionsByProject,
  matchesSessionFilter,
  sessionDisplayTitle,
  type LiveSession,
  type SessionCatalog,
  type SessionMeta,
} from '@app/core';

export interface SessionsPanelProps {
  /** Absent on hosts that can't read `~/.claude` — the panel then isn't rendered. */
  catalog: SessionCatalog;
  open: boolean;
  onToggleOpen: () => void;
  /** Project folders whose group is unfolded (persisted in AppSettings). */
  expanded: Set<string>;
  onToggleProject: (dir: string) => void;
  /**
   * Open a past conversation in a new workspace. `fork` continues it under a new
   * id, which is what a session that is live somewhere else needs — two
   * terminals resuming one conversation interleave into a single transcript.
   */
  onOpenSession: (meta: SessionMeta, fork: boolean) => void;
  /**
   * Conversations that already have a workspace. Their rows say so, so a second
   * click reads as "go back to it" rather than "open another one".
   */
  openSessionIds?: ReadonlySet<string>;
  /** The active workspace's folder — its group starts unfolded. */
  currentCwd?: string;
}

/** How many of the newest transcripts we ask the host to parse. */
const SESSION_LIMIT = 400;
/** Liveness is a hint that goes stale on its own; re-ask while the panel is open. */
const LIVE_POLL_MS = 15_000;

function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

/** Compact "how long ago" — the row has no room for a date. */
function relativeTime(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  const w = Math.round(d / 7);
  if (w < 5) return `${w}w`;
  return `${Math.round(d / 30)}mo`;
}

function SessionRow({
  meta,
  live,
  alreadyOpen,
  onOpen,
}: {
  meta: SessionMeta;
  live?: LiveSession;
  alreadyOpen: boolean;
  onOpen: (fork: boolean) => void;
}) {
  // A live conversation is forked (a new id off the same history); a dormant one
  // is resumed in place. Clicking the row does the right one of the two.
  const fork = !!live;
  // A conversation with a workspace already open is not opened twice: the click
  // switches to it (resume) or asks first (fork). The label says which.
  const label = alreadyOpen ? (fork ? 'Fork +' : 'Switch') : fork ? 'Fork' : 'Resume';
  return (
    <div
      className="sb-row"
      onClick={() => onOpen(fork)}
      title={`${meta.cwd}\n${meta.claudeSessionId}${
        live ? `\nlive · ${live.status ?? 'running'}` : ''
      }${alreadyOpen ? '\nalready open in a workspace' : ''}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        padding: '6px 8px',
        cursor: 'pointer',
        borderRadius: 8,
        border: '1px solid',
        borderColor: alreadyOpen
          ? 'color-mix(in srgb, var(--accent) 40%, transparent)'
          : 'transparent',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          title={live ? 'running now' : 'not running'}
          style={{
            width: 6,
            height: 6,
            flexShrink: 0,
            borderRadius: '50%',
            background: live ? 'var(--status-idle)' : 'var(--surface1)',
          }}
        />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12,
            color: 'var(--fg)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {sessionDisplayTitle(meta)}
        </span>
        <button
          className="sb-act"
          onClick={(e) => {
            e.stopPropagation();
            onOpen(fork);
          }}
          title={
            alreadyOpen
              ? fork
                ? 'Already open — fork it again into another workspace'
                : 'Already open — switch to its workspace'
              : fork
                ? 'Fork into a new workspace (the original stays live)'
                : 'Resume into a new workspace'
          }
          style={{
            flexShrink: 0,
            background: 'transparent',
            border: '1px solid var(--line-strong)',
            borderRadius: 'var(--radius-inline)',
            color: alreadyOpen ? 'var(--accent)' : 'var(--fg-muted)',
            cursor: 'pointer',
            fontFamily: 'inherit',
            fontSize: 10,
            padding: '1px 5px',
          }}
        >
          {label}
        </button>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          color: 'var(--fg-muted)',
          fontSize: 10.5,
        }}
      >
        <span style={{ flexShrink: 0 }}>{relativeTime(meta.mtime)}</span>
        {meta.gitBranch && (
          <span
            style={{
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            ⑂ {meta.gitBranch}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * SESSIONS — every Claude Code conversation on this machine, grouped by the
 * folder it ran in and resumable into a fresh workspace in one click. A
 * VS-Code-style bottom panel: collapsed it is just a header; expanded it takes
 * the space the workspace tree gives up.
 *
 * Rows come from the CLI's own transcript store, so sessions Chorus never
 * launched are here too — that is the point of the panel.
 */
export function SessionsPanel({
  catalog,
  open,
  onToggleOpen,
  expanded,
  onToggleProject,
  onOpenSession,
  openSessionIds,
  currentCwd,
}: SessionsPanelProps) {
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null);
  const [live, setLive] = useState<LiveSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');

  // A host that can't answer leaves an empty panel, never a stuck spinner or an
  // unhandled rejection — the catalog is a convenience, not load-bearing.
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [metas, running] = await Promise.all([
        catalog.listSessions({ limit: SESSION_LIMIT }),
        catalog.liveSessions(),
      ]);
      setSessions(metas);
      setLive(running);
    } catch {
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, [catalog]);

  // Nothing is read until the panel is first opened — a collapsed panel costs
  // no disk walk. Afterwards only liveness is re-polled; the list itself is
  // refreshed on demand.
  useEffect(() => {
    if (!open) return;
    if (sessions === null) void refresh();
    const timer = setInterval(() => {
      void catalog.liveSessions().then(setLive, () => setLive([]));
    }, LIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [open, sessions, refresh, catalog]);

  const liveById = useMemo(() => {
    const m = new Map<string, LiveSession>();
    for (const l of live) m.set(l.sessionId, l);
    return m;
  }, [live]);

  const groups = useMemo(() => {
    const filtered = (sessions ?? []).filter((s) => matchesSessionFilter(s, query));
    return groupSessionsByProject(filtered);
  }, [sessions, query]);

  const total = sessions?.length ?? 0;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        ...(open ? { flex: '1 1 0' } : { flexShrink: 0 }),
        borderTop: '1px solid var(--border)',
      }}
    >
      <div
        className="sb-row"
        onClick={onToggleOpen}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px',
          flexShrink: 0,
          cursor: 'pointer',
        }}
      >
        <span style={{ color: 'var(--fg-muted)', fontSize: 10, width: 8 }}>
          {open ? '▾' : '▸'}
        </span>
        <span className="eyebrow">Sessions</span>
        {total > 0 && <span className="sb-count">{total}</span>}
        {open && (
          <button
            className="sb-act"
            onClick={(e) => {
              e.stopPropagation();
              void refresh();
            }}
            title="Rescan ~/.claude"
            aria-label="Rescan sessions"
            style={{
              marginLeft: 'auto',
              background: 'transparent',
              border: 'none',
              color: 'var(--fg-muted)',
              cursor: 'pointer',
              fontSize: 12,
              padding: 0,
            }}
          >
            ⟳
          </button>
        )}
      </div>

      {open && (
        <>
          <div style={{ padding: '0 12px 8px', flexShrink: 0 }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter title, folder, branch…"
              style={{
                width: '100%',
                boxSizing: 'border-box',
                background: 'var(--bg)',
                color: 'var(--fg)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-inline)',
                padding: '4px 7px',
                fontFamily: 'inherit',
                fontSize: 11,
              }}
            />
          </div>

          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              padding: '0 8px 10px',
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            {sessions === null ? (
              <div style={{ color: 'var(--fg-muted)', fontSize: 11, padding: '6px 8px' }}>
                {loading ? 'reading ~/.claude…' : ''}
              </div>
            ) : groups.length === 0 ? (
              <div style={{ color: 'var(--fg-muted)', fontSize: 11, padding: '6px 8px' }}>
                {total === 0
                  ? 'no Claude Code sessions found'
                  : 'nothing matches that filter'}
              </div>
            ) : (
              groups.map((g) => {
                // A filter narrows the list to what the user is hunting for, so
                // every surviving group unfolds; otherwise only the folder the
                // user is working in does, plus whatever they've opened.
                const unfolded =
                  query.trim() !== '' || expanded.has(g.dir) || g.dir === currentCwd;
                return (
                  <div key={g.dir} style={{ display: 'flex', flexDirection: 'column' }}>
                    <div
                      className="sb-row"
                      onClick={() => onToggleProject(g.dir)}
                      title={g.dir}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '6px 8px 6px 4px',
                        cursor: 'pointer',
                        borderRadius: 8,
                      }}
                    >
                      <span
                        style={{
                          color: 'var(--fg-muted)',
                          fontSize: 10,
                          width: 12,
                          flexShrink: 0,
                        }}
                      >
                        {unfolded ? '▾' : '▸'}
                      </span>
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          fontSize: 12,
                          fontWeight: 600,
                          color: 'var(--fg)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {basename(g.dir)}
                      </span>
                      <span className="sb-count">{g.sessions.length}</span>
                    </div>

                    {unfolded && (
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 2,
                          margin: '2px 0 2px 11px',
                          paddingLeft: 10,
                          borderLeft: '1px solid var(--border)',
                        }}
                      >
                        {g.sessions.map((s) => (
                          <SessionRow
                            key={s.claudeSessionId}
                            meta={s}
                            live={liveById.get(s.claudeSessionId)}
                            alreadyOpen={
                              openSessionIds?.has(s.claudeSessionId) ?? false
                            }
                            onOpen={(fork) => onOpenSession(s, fork)}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
}
