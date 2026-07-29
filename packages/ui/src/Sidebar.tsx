import { useState } from 'react';
import {
  orderWorkspaces,
  type SessionStatus,
  type Workspace,
  type WorkspaceState,
} from '@app/core';
import { StatusBadge } from './StatusBadge.js';
import { BrandLockup } from './Brand.js';

export interface SidebarProps {
  state: WorkspaceState;
  statusOf: (sessionId: string) => SessionStatus | null;
  collapsed: Set<string>;
  focusedId: string | null;
  onSelectWorkspace: (id: string) => void;
  onToggleCollapse: (id: string) => void;
  onNewWorkspace: () => void;
  onRenameWorkspace: (id: string, name: string) => void;
  /** Pin/unpin: pinned workspaces sort to the top and confirm before closing. */
  onTogglePinned: (id: string) => void;
  onCloseWorkspace: (id: string) => void;
  onFocusSession: (id: string) => void;
  onRenameSession: (id: string, title: string) => void;
  onCloseSession: (id: string) => void;
  /** Collapse the whole sidebar to a slim rail (handled by the parent). */
  onCollapse?: () => void;
  /**
   * Bottom panel (SESSIONS), composed by the parent so the sidebar stays
   * ignorant of `~/.claude`. Absent on hosts that can't read the session store.
   */
  bottomPanel?: React.ReactNode;
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

/** Inline-editable label: double-click to edit, Enter/blur to commit. */
function EditableLabel({
  value,
  onCommit,
  style,
}: {
  value: string;
  onCommit: (next: string) => void;
  style?: React.CSSProperties;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onBlur={() => {
          if (draft.trim()) onCommit(draft.trim());
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            if (draft.trim()) onCommit(draft.trim());
            setEditing(false);
          }
          if (e.key === 'Escape') {
            setDraft(value);
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
          ...style,
        }}
      />
    );
  }
  const startEditing = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDraft(value);
    setEditing(true);
  };
  return (
    <span
      style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 4 }}
    >
      <span
        onDoubleClick={startEditing}
        title="Double-click or ✎ to rename"
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          ...style,
        }}
      >
        {value}
      </span>
      <button
        className="sb-act"
        onClick={startEditing}
        aria-label="Rename"
        title="Rename"
        style={{
          background: 'transparent',
          border: 'none',
          color: 'var(--fg-muted)',
          cursor: 'pointer',
          fontSize: 11,
          lineHeight: 1,
          padding: 0,
        }}
      >
        ✎
      </button>
    </span>
  );
}

function CloseButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button
      className="sb-act"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      aria-label={title}
      title={title}
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
  );
}

function WorkspaceGroup({
  ws,
  active,
  collapsed,
  props,
}: {
  ws: Workspace;
  active: boolean;
  collapsed: boolean;
  props: SidebarProps;
}) {
  const anyWaiting = ws.sessions.some(
    (s) => props.statusOf(s.sessionId) === 'waiting',
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div
        className="sb-row"
        onClick={() => props.onSelectWorkspace(ws.id)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 8px 8px 4px',
          cursor: 'pointer',
          borderRadius: 8,
          background: active
            ? 'color-mix(in srgb, var(--accent) 12%, transparent)'
            : undefined,
          border: '1px solid',
          borderColor: active
            ? 'color-mix(in srgb, var(--accent) 55%, transparent)'
            : 'transparent',
        }}
      >
        <button
          onClick={(e) => {
            e.stopPropagation();
            props.onToggleCollapse(ws.id);
          }}
          aria-label={collapsed ? 'Expand workspace' : 'Collapse workspace'}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--fg-muted)',
            cursor: 'pointer',
            width: 16,
            flexShrink: 0,
            padding: 0,
            fontSize: 10,
          }}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <EditableLabel
          value={ws.name}
          onCommit={(n) => props.onRenameWorkspace(ws.id, n)}
          style={{ fontWeight: 600, fontSize: 12.5, color: 'var(--fg)' }}
        />
        {anyWaiting && (
          <span
            title="a session needs attention"
            style={{
              width: 6,
              height: 6,
              flexShrink: 0,
              borderRadius: '50%',
              background: 'var(--status-waiting)',
            }}
          />
        )}
        <span className="sb-count" title={`${ws.sessions.length} session(s)`}>
          {ws.sessions.length}
        </span>
        <button
          className="sb-act"
          onClick={(e) => {
            e.stopPropagation();
            props.onTogglePinned(ws.id);
          }}
          aria-label={ws.pinned ? 'Unpin workspace' : 'Pin workspace'}
          aria-pressed={!!ws.pinned}
          title={
            ws.pinned
              ? 'Unpin (returns to its place in the list)'
              : 'Pin to the top of the list'
          }
          style={{
            background: 'transparent',
            border: 'none',
            color: ws.pinned ? 'var(--accent)' : 'var(--fg-muted)',
            cursor: 'pointer',
            fontSize: 11,
            lineHeight: 1,
            padding: '0 2px',
            // A pinned workspace keeps its marker visible; an unpinned one only
            // shows the affordance on hover, like the other row actions.
            opacity: ws.pinned ? 1 : undefined,
          }}
        >
          {ws.pinned ? '📌' : '📍'}
        </button>
        <CloseButton
          onClick={() => props.onCloseWorkspace(ws.id)}
          title="Close workspace"
        />
      </div>

      {!collapsed && (
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
          {ws.sessions.length === 0 ? (
            <div
              style={{
                color: 'var(--fg-muted)',
                fontSize: 11,
                padding: '6px 8px',
              }}
            >
              no sessions started
            </div>
          ) : (
            ws.sessions.map((s) => {
              const status = props.statusOf(s.sessionId);
              const focused = s.sessionId === props.focusedId;
              return (
                <div
                  key={s.sessionId}
                  className="sb-row"
                  onClick={() => props.onFocusSession(s.sessionId)}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 3,
                    padding: '6px 8px',
                    cursor: 'pointer',
                    borderRadius: 8,
                    border: '1px solid',
                    borderColor: focused
                      ? 'color-mix(in srgb, var(--accent) 55%, transparent)'
                      : 'transparent',
                    background:
                      status === 'waiting'
                        ? 'color-mix(in srgb, var(--status-waiting) 12%, transparent)'
                        : focused
                          ? 'color-mix(in srgb, var(--accent) 10%, transparent)'
                          : undefined,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <EditableLabel
                      value={s.title}
                      onCommit={(t) => props.onRenameSession(s.sessionId, t)}
                      style={{ fontWeight: 600, fontSize: 12, color: 'var(--fg)' }}
                    />
                    <CloseButton
                      onClick={() => props.onCloseSession(s.sessionId)}
                      title="Close session"
                    />
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
                      title={s.cwd}
                      style={{
                        color: 'var(--fg-muted)',
                        fontSize: 11,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {basename(s.cwd)}
                    </span>
                    {status && (
                      <StatusBadge status={status} pulse={status === 'waiting'} />
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Two-tier sidebar: workspaces as collapsible groups, each session nested
 * underneath with a live status badge. Workspaces with a waiting session show
 * an attention dot. See the product decisions (workspace = top-level unit).
 */
export function Sidebar(props: SidebarProps) {
  return (
    <div
      style={{
        width: 272,
        flexShrink: 0,
        height: '100%',
        background: 'var(--bg-elevated)',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Brand band — same height as the main header so the two read as one bar. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          height: 45,
          flexShrink: 0,
          padding: '0 12px',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <BrandLockup />
        {props.onCollapse && (
          <button
            className="sb-icon-btn"
            onClick={props.onCollapse}
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
          >
            «
          </button>
        )}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '14px 12px 8px',
        }}
      >
        <span className="eyebrow" style={{ whiteSpace: 'nowrap' }}>
          Workspaces
        </span>
        <span className="sb-count">{props.state.workspaces.length}</span>
        <button
          className="sb-new-btn"
          onClick={props.onNewWorkspace}
          title="New workspace"
          style={{ marginLeft: 'auto' }}
        >
          + New
        </button>
      </div>

      {/* minHeight:0 is what lets this flex child actually give up space to the
       *  bottom panel — without it the tree refuses to shrink below its content
       *  and pushes the panel off the sidebar. */}
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
        {orderWorkspaces(props.state.workspaces).map((ws) => (
          <WorkspaceGroup
            key={ws.id}
            ws={ws}
            active={ws.id === props.state.activeWorkspaceId}
            collapsed={props.collapsed.has(ws.id)}
            props={props}
          />
        ))}
      </div>

      {props.bottomPanel}
    </div>
  );
}
