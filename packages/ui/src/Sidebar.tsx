import { useState } from 'react';
import type { SessionStatus, Workspace, WorkspaceState } from '@app/core';
import { StatusBadge } from './StatusBadge.js';

export interface SidebarProps {
  state: WorkspaceState;
  statusOf: (sessionId: string) => SessionStatus | null;
  collapsed: Set<string>;
  focusedId: string | null;
  onSelectWorkspace: (id: string) => void;
  onToggleCollapse: (id: string) => void;
  onNewWorkspace: () => void;
  onRenameWorkspace: (id: string, name: string) => void;
  onCloseWorkspace: (id: string) => void;
  onFocusSession: (id: string) => void;
  onRenameSession: (id: string, title: string) => void;
  onCloseSession: (id: string) => void;
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
  return (
    <span
      onDoubleClick={(e) => {
        e.stopPropagation();
        setDraft(value);
        setEditing(true);
      }}
      title="Double-click to rename"
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
  );
}

function CloseButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
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
        onClick={() => props.onSelectWorkspace(ws.id)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '6px 8px',
          cursor: 'pointer',
          borderRadius: 6,
          background: active
            ? 'color-mix(in srgb, var(--accent) 14%, transparent)'
            : 'transparent',
          border: '1px solid',
          borderColor: active ? 'var(--accent)' : 'transparent',
        }}
      >
        <button
          onClick={(e) => {
            e.stopPropagation();
            props.onToggleCollapse(ws.id);
          }}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--fg-muted)',
            cursor: 'pointer',
            width: 14,
            padding: 0,
            fontSize: 10,
          }}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <EditableLabel
          value={ws.name}
          onCommit={(n) => props.onRenameWorkspace(ws.id, n)}
          style={{ fontWeight: 700, fontSize: 12, color: 'var(--fg)' }}
        />
        {anyWaiting && (
          <span
            title="a session needs attention"
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: 'var(--status-waiting)',
            }}
          />
        )}
        <span style={{ color: 'var(--fg-muted)', fontSize: 10 }}>
          {ws.sessions.length}
        </span>
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
            paddingLeft: 18,
          }}
        >
          {ws.sessions.length === 0 ? (
            <div style={{ color: 'var(--fg-muted)', fontSize: 11, padding: '4px 8px' }}>
              no sessions started
            </div>
          ) : (
            ws.sessions.map((s) => {
              const status = props.statusOf(s.sessionId);
              const focused = s.sessionId === props.focusedId;
              return (
                <div
                  key={s.sessionId}
                  onClick={() => props.onFocusSession(s.sessionId)}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                    padding: '5px 8px',
                    cursor: 'pointer',
                    borderRadius: 6,
                    border: '1px solid',
                    borderColor: focused ? 'var(--accent)' : 'transparent',
                    background:
                      status === 'waiting'
                        ? 'color-mix(in srgb, var(--status-waiting) 12%, transparent)'
                        : focused
                          ? 'color-mix(in srgb, var(--accent) 10%, transparent)'
                          : 'transparent',
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
        width: 250,
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
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 12px',
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          color: 'var(--fg-muted)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <span>Workspaces · {props.state.workspaces.length}</span>
        <button
          onClick={props.onNewWorkspace}
          title="New workspace"
          style={{
            background: 'var(--bg)',
            color: 'var(--fg)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '2px 8px',
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          + new
        </button>
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
        {props.state.workspaces.map((ws) => (
          <WorkspaceGroup
            key={ws.id}
            ws={ws}
            active={ws.id === props.state.activeWorkspaceId}
            collapsed={props.collapsed.has(ws.id)}
            props={props}
          />
        ))}
      </div>
    </div>
  );
}
