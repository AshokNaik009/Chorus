import { useState, type ReactNode } from 'react';
import type { SessionStatus } from '@app/core';

export interface TabbedViewProps {
  /** Pane session ids, left-to-right (collectSessionIds order). */
  sessionIds: string[];
  /** The currently visible tab (falls back to the first id when null/stale). */
  activeId: string | null;
  onActivate: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  /** Append a new empty terminal tab (the "+" affordance). Omit to hide it. */
  onAdd?: () => void;
  /**
   * Commit a new left-to-right tab order (drag-to-reorder, like browser tabs).
   * Receives the full reordered id list. Omit to disable reordering.
   */
  onReorder?: (orderedIds: string[]) => void;
  titleOf: (sessionId: string) => string | undefined;
  statusOf: (sessionId: string) => SessionStatus | null;
  /** Renders a pane's body; reused verbatim from the grid so behavior matches. */
  renderPane: (sessionId: string) => ReactNode;
}

/** Move `dragId` to sit immediately before `targetId` in the list. */
function reordered(ids: string[], dragId: string, targetId: string): string[] {
  const without = ids.filter((id) => id !== dragId);
  const at = without.indexOf(targetId);
  if (at < 0) return ids;
  return [...without.slice(0, at), dragId, ...without.slice(at)];
}

const STATUS_COLOR: Record<SessionStatus, string> = {
  spawning: 'var(--status-spawning)',
  running: 'var(--status-running)',
  waiting: 'var(--status-waiting)',
  idle: 'var(--status-idle)',
  exited: 'var(--status-exited)',
};

/**
 * Chrome / native-terminal-style tabs: one terminal visible at a time behind a
 * horizontal tab strip. Crucially, EVERY pane stays mounted — inactive ones are
 * hidden with `display:none`, not unmounted — so a tab switch never tears down
 * xterm and loses scrollback. The same `renderPane` the grid uses renders each
 * body, so a session behaves identically in either view.
 */
export function TabbedView({
  sessionIds,
  activeId,
  onActivate,
  onClose,
  onAdd,
  onReorder,
  titleOf,
  statusOf,
  renderPane,
}: TabbedViewProps) {
  const active =
    activeId && sessionIds.includes(activeId) ? activeId : sessionIds[0] ?? null;
  // Drag-to-reorder state: the tab being dragged and the one hovered over.
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'var(--bg)',
      }}
    >
      {/* tab strip */}
      <div
        role="tablist"
        style={{
          display: 'flex',
          alignItems: 'stretch',
          gap: 2,
          padding: '6px 8px 0',
          background: 'var(--bg-elevated)',
          borderBottom: '1px solid var(--border)',
          overflowX: 'auto',
        }}
      >
        {sessionIds.map((id) => {
          const isActive = id === active;
          const status = statusOf(id);
          const isDropTarget = !!dragId && overId === id && dragId !== id;
          return (
            <div
              key={id}
              role="tab"
              aria-selected={isActive}
              draggable={!!onReorder}
              onMouseDown={() => onActivate(id)}
              onDragStart={(e) => {
                setDragId(id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                if (!onReorder || !dragId) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (overId !== id) setOverId(id);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (onReorder && dragId && dragId !== id) {
                  onReorder(reordered(sessionIds, dragId, id));
                }
                setDragId(null);
                setOverId(null);
              }}
              onDragEnd={() => {
                setDragId(null);
                setOverId(null);
              }}
              title={titleOf(id) ?? 'empty pane'}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '7px 10px 8px',
                cursor: 'pointer',
                maxWidth: 220,
                minWidth: 96,
                borderRadius: '8px 8px 0 0',
                border: '1px solid',
                borderColor: isActive ? 'var(--border)' : 'transparent',
                borderBottom: 'none',
                borderLeft: isDropTarget
                  ? '2px solid var(--accent)'
                  : isActive
                    ? '1px solid var(--border)'
                    : '1px solid transparent',
                marginBottom: -1,
                background: isActive ? 'var(--bg)' : 'transparent',
                color: isActive ? 'var(--fg)' : 'var(--fg-muted)',
                opacity: dragId === id ? 0.5 : 1,
                position: 'relative',
              }}
            >
              {isActive && (
                <span
                  style={{
                    position: 'absolute',
                    left: 8,
                    right: 8,
                    top: 0,
                    height: 2,
                    borderRadius: 2,
                    background: 'var(--accent)',
                  }}
                />
              )}
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  flex: 'none',
                  background: status
                    ? STATUS_COLOR[status]
                    : 'var(--unknown)',
                  boxShadow:
                    status === 'waiting'
                      ? '0 0 0 0 var(--status-waiting)'
                      : undefined,
                  animation:
                    status === 'waiting'
                      ? 'pane-pulse 1.4s ease-out infinite'
                      : undefined,
                }}
              />
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: 12,
                }}
              >
                {titleOf(id) ?? 'empty pane'}
              </span>
              <button
                onMouseDown={(e) => {
                  e.stopPropagation();
                  onClose(id);
                }}
                title="Close tab"
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--fg-muted)',
                  cursor: 'pointer',
                  fontSize: 13,
                  lineHeight: 1,
                  padding: '0 2px',
                  borderRadius: 4,
                }}
              >
                ✕
              </button>
            </div>
          );
        })}
        {onAdd && (
          <button
            onClick={onAdd}
            title="New terminal tab"
            style={{
              alignSelf: 'center',
              background: 'transparent',
              border: 'none',
              color: 'var(--fg-muted)',
              cursor: 'pointer',
              fontSize: 16,
              lineHeight: 1,
              padding: '4px 10px',
              borderRadius: 6,
            }}
          >
            +
          </button>
        )}
      </div>

      {/* body — every pane stays mounted AND laid out at full size; inactive ones
          are `visibility:hidden` (NOT `display:none`). display:none collapses the
          container to 0 width, so xterm's fit addon resizes the PTY down to a
          couple of columns and the terminal wraps to a thin strip. visibility
          keeps the real box, so fit always sees the true width. */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {sessionIds.map((id) => {
          const isActive = id === active;
          return (
            <div
              key={id}
              style={{
                position: 'absolute',
                inset: 0,
                visibility: isActive ? 'visible' : 'hidden',
                pointerEvents: isActive ? 'auto' : 'none',
                zIndex: isActive ? 1 : 0,
              }}
            >
              {renderPane(id)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
