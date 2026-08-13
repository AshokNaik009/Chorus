import { useCallback, useEffect, useState } from 'react';
import type { IslandControl, IslandStatus } from '@app/core';

export interface IslandRowProps {
  /** Host capability. Absent (web) renders the row disabled. */
  control?: IslandControl;
  /** Persisted on/off, from AppSettings.islandMode. */
  enabled: boolean;
  /** Persisted override for CodeIsland's location, used when the bundle id misses. */
  appPath?: string;
  onChange(next: { enabled: boolean; appPath?: string }): void;
  /** How many panes are currently streamed (the gate file's line count). */
  paneCount: number;
}

const DOT = 8;

/**
 * The sidebar's ISLAND row: one switch that sends the active workspace's Claude
 * panes to CodeIsland's notch panel and takes approvals back from it.
 *
 * It sits below the SESSIONS / SESSION TRACE accordion but is NOT part of it —
 * a mode is not a panel, so turning it on must never fold away whatever the
 * user was reading. It has nothing to expand either, hence a state dot where
 * those panels put their chevron.
 *
 * Everything the row can report comes from `control.probe()`: whether the app is
 * installed, whether its bridge binary is there, and whether it is actually
 * listening. A miss on any of those is shown inline rather than thrown — with
 * the mode off (or the island absent) every pane just prompts in-pane as usual.
 */
export function IslandRow({
  control,
  enabled,
  appPath,
  onChange,
  paneCount,
}: IslandRowProps) {
  const [status, setStatus] = useState<IslandStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingPath, setEditingPath] = useState(false);
  const [pathDraft, setPathDraft] = useState(appPath ?? '');

  // Probe on mount and whenever the persisted path changes, so a row restored as
  // "on" still tells the truth if CodeIsland was uninstalled or force-quit since.
  useEffect(() => {
    if (!control) return;
    let cancelled = false;
    void control.probe(appPath).then((s) => {
      if (!cancelled) setStatus(s);
    });
    return () => {
      cancelled = true;
    };
  }, [control, appPath]);

  const toggle = useCallback(async () => {
    if (!control || busy) return;
    setBusy(true);
    try {
      const next = await control.setEnabled(!enabled, appPath);
      setStatus(next);
      // The host is the authority on whether it actually came up: a failed
      // launch reports `enabled: false` and the row must not claim otherwise.
      onChange({ enabled: next.enabled, ...(appPath ? { appPath } : {}) });
      // A miss on the bundle id is the one failure the user can fix from here.
      if (!next.appFound) setEditingPath(true);
    } finally {
      setBusy(false);
    }
  }, [control, busy, enabled, appPath, onChange]);

  const unsupported = !control;
  const on = enabled && (status?.enabled ?? enabled);
  const dotColor = unsupported
    ? 'var(--surface1)'
    : on
      ? status && !status.socketFound
        ? 'var(--status-waiting)' // gate is live but nothing is listening
        : 'var(--status-idle)'
      : 'var(--surface1)';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        borderTop: '1px solid var(--border)',
      }}
    >
      <div
        className="sb-row"
        onClick={unsupported ? undefined : () => void toggle()}
        title={
          unsupported
            ? 'ISLAND mode drives the CodeIsland macOS app — desktop only.'
            : on
              ? 'Streaming this workspace to CodeIsland. Click to stop.'
              : 'Send this workspace to the CodeIsland notch panel.'
        }
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px',
          cursor: unsupported ? 'default' : busy ? 'progress' : 'pointer',
          opacity: unsupported ? 0.45 : 1,
        }}
      >
        <span
          style={{
            width: DOT,
            height: DOT,
            flexShrink: 0,
            borderRadius: '50%',
            background: dotColor,
            boxShadow: on ? `0 0 6px ${dotColor}` : 'none',
            transition: 'background 150ms ease',
          }}
        />
        <span className="eyebrow">Island</span>
        {on && paneCount > 0 && <span className="sb-count">{paneCount}</span>}
        <span
          style={{
            marginLeft: 'auto',
            color: 'var(--fg-muted)',
            fontSize: 9.5,
            whiteSpace: 'nowrap',
          }}
        >
          {unsupported ? 'macOS app only' : busy ? '…' : on ? 'on' : 'off'}
        </span>
      </div>

      {/* Inline diagnosis. Only shown when there is something to act on: an
          island that isn't installed, or one whose socket never came up. */}
      {!unsupported && status?.error && (
        <div
          style={{
            padding: '0 12px 8px 28px',
            color: 'var(--status-waiting)',
            fontSize: 9.5,
            lineHeight: 1.5,
          }}
        >
          {status.error}
        </div>
      )}
      {!unsupported && on && status && !status.socketFound && !status.error && (
        <div
          style={{
            padding: '0 12px 8px 28px',
            color: 'var(--fg-muted)',
            fontSize: 9.5,
            lineHeight: 1.5,
          }}
        >
          CodeIsland isn’t listening yet — panes prompt in-pane until it is.
        </div>
      )}

      {!unsupported && (editingPath || (appPath && !status?.appFound)) && (
        <div style={{ padding: '0 12px 10px 28px', display: 'flex', gap: 6 }}>
          <input
            value={pathDraft}
            onChange={(e) => setPathDraft(e.target.value)}
            placeholder="/Applications/CodeIsland.app"
            spellCheck={false}
            style={{
              flex: 1,
              minWidth: 0,
              padding: '3px 6px',
              background: 'var(--bg-deep)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-inline)',
              color: 'var(--fg)',
              font: 'inherit',
              fontSize: 10,
            }}
          />
          <button
            onClick={() => {
              const p = pathDraft.trim();
              onChange({ enabled, ...(p ? { appPath: p } : {}) });
              setEditingPath(false);
            }}
            style={{
              padding: '3px 8px',
              background: 'var(--surface0)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-inline)',
              color: 'var(--fg)',
              font: 'inherit',
              fontSize: 10,
              cursor: 'pointer',
            }}
          >
            set
          </button>
        </div>
      )}
    </div>
  );
}
