import { useState } from 'react';
import type { Session } from '@app/core';
import { StatusBadge } from './StatusBadge.js';

export interface SidebarProps {
  sessions: Session[];
  focusedId: string | null;
  onFocus: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => void;
  onClose: (sessionId: string) => void;
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

function Row({
  session,
  focused,
  onFocus,
  onRename,
  onClose,
}: {
  session: Session;
  focused: boolean;
  onFocus: () => void;
  onRename: (title: string) => void;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.config.title);
  const waiting = session.status === 'waiting';

  const commit = () => {
    const t = draft.trim();
    if (t) onRename(t);
    else setDraft(session.config.title);
    setEditing(false);
  };

  return (
    <div
      onClick={onFocus}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '8px 10px',
        cursor: 'pointer',
        borderRadius: 8,
        border: '1px solid',
        borderColor: focused ? 'var(--accent)' : 'transparent',
        background: focused
          ? 'color-mix(in srgb, var(--accent) 12%, transparent)'
          : waiting
            ? 'color-mix(in srgb, var(--status-waiting) 12%, transparent)'
            : 'transparent',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 6,
        }}
      >
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') {
                setDraft(session.config.title);
                setEditing(false);
              }
            }}
            style={{
              flex: 1,
              minWidth: 0,
              background: 'var(--bg)',
              color: 'var(--fg)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              padding: '1px 4px',
              fontFamily: 'inherit',
              fontSize: 12,
            }}
          />
        ) : (
          <span
            onDoubleClick={(e) => {
              e.stopPropagation();
              setDraft(session.config.title);
              setEditing(true);
            }}
            title="Double-click to rename"
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontWeight: 600,
              fontSize: 12,
              color: 'var(--fg)',
            }}
          >
            {session.config.title}
          </span>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          title="Close session"
          style={{
            background: 'transparent',
            color: 'var(--fg-muted)',
            border: 'none',
            cursor: 'pointer',
            fontSize: 14,
            lineHeight: 1,
            padding: '0 2px',
          }}
        >
          ×
        </button>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 6,
        }}
      >
        <span
          title={session.config.cwd}
          style={{
            color: 'var(--fg-muted)',
            fontSize: 11,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {basename(session.config.cwd)}
        </span>
        <StatusBadge status={session.status} pulse={waiting} />
      </div>
    </div>
  );
}

/**
 * Left sidebar listing every session with a live status badge. Click focuses
 * the pane; double-click the title to rename; × closes. Waiting sessions are
 * emphasized and sorted to the top (PRD US-4.1, US-4.2, US-5.2).
 */
export function Sidebar({
  sessions,
  focusedId,
  onFocus,
  onRename,
  onClose,
}: SidebarProps) {
  // Emphasize attention: waiting sessions float to the top, order otherwise
  // stable.
  const ordered = [...sessions].sort((a, b) => {
    const aw = a.status === 'waiting' ? 0 : 1;
    const bw = b.status === 'waiting' ? 0 : 1;
    return aw - bw;
  });

  return (
    <div
      style={{
        width: 240,
        flexShrink: 0,
        height: '100%',
        background: 'var(--bg-elevated)',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          padding: '10px 12px',
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          color: 'var(--fg-muted)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        Sessions · {sessions.length}
      </div>
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 6,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        {ordered.length === 0 ? (
          <div style={{ color: 'var(--fg-muted)', fontSize: 12, padding: 8 }}>
            No sessions yet — start one in a pane.
          </div>
        ) : (
          ordered.map((s) => (
            <Row
              key={s.config.sessionId}
              session={s}
              focused={s.config.sessionId === focusedId}
              onFocus={() => onFocus(s.config.sessionId)}
              onRename={(t) => onRename(s.config.sessionId, t)}
              onClose={() => onClose(s.config.sessionId)}
            />
          ))
        )}
      </div>
    </div>
  );
}
