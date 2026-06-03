import { useEffect, useRef, useState } from 'react';
import {
  buildTemplate,
  removePane,
  setSizesAtPath,
  type LayoutNode,
  type LayoutTemplate,
  type Session,
  type SessionManager,
} from '@app/core';
import { LayoutView } from './LayoutView.js';
import { Sidebar } from './Sidebar.js';
import { SessionTerminal } from './SessionTerminal.js';
import { PaneLauncher } from './PaneLauncher.js';
import type { TerminalPaneHandle } from './TerminalPane.js';

export interface AppProps {
  manager: SessionManager;
  /** Prefilled cwd for new panes (host may pass cwd of the workspace). */
  defaultCwd?: string;
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

const TEMPLATES: LayoutTemplate[] = [1, 2, 4];

/**
 * The full Pane workspace: a layout-template toolbar, a resizable grid of
 * Claude Code sessions, and a live session sidebar. Host-agnostic — it receives
 * a SessionManager (already bound to a PtyBackend) and drives everything through
 * it. See PRD Epics 3 & 4.
 */
export function App({ manager, defaultCwd = '~' }: AppProps) {
  const [layout, setLayout] = useState<LayoutNode>(() => buildTemplate(1));
  const [sessions, setSessions] = useState<Session[]>([]);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const handles = useRef(new Map<string, TerminalPaneHandle>());

  useEffect(() => {
    const sub = manager.onChange.on(setSessions);
    setSessions(manager.list());
    return () => sub.dispose();
  }, [manager]);

  const activeIds = new Set(sessions.map((s) => s.config.sessionId));

  const selectTemplate = (n: LayoutTemplate) => {
    for (const s of manager.list()) manager.remove(s.config.sessionId);
    handles.current.clear();
    setLayout(buildTemplate(n));
    setFocusedId(null);
  };

  const startSession = (sessionId: string, cwd: string, command?: string) => {
    const label = command === 'claude' ? 'claude' : 'shell';
    void manager.spawn(
      { sessionId, title: `${label} · ${basename(cwd)}`, cwd },
      { cols: 80, rows: 24 }, // corrected by the pane's first fit/resize
      { command },
    );
    setFocusedId(sessionId);
  };

  const closeSession = (sessionId: string) => {
    manager.remove(sessionId);
    handles.current.delete(sessionId);
    setLayout((prev) => removePane(prev, sessionId) ?? buildTemplate(1));
    setFocusedId((cur) => (cur === sessionId ? null : cur));
  };

  const focusSession = (sessionId: string) => {
    setFocusedId(sessionId);
    handles.current.get(sessionId)?.focus();
  };

  const renderPane = (sessionId: string) => {
    const focused = focusedId === sessionId;
    return (
      <div
        onMouseDown={() => setFocusedId(sessionId)}
        style={{
          width: '100%',
          height: '100%',
          boxSizing: 'border-box',
          border: '2px solid',
          borderColor: focused ? 'var(--accent)' : 'var(--border)',
          background: 'var(--bg)',
        }}
      >
        {activeIds.has(sessionId) ? (
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
            defaultCwd={defaultCwd}
            onStart={(cwd, command) => startSession(sessionId, cwd, command)}
          />
        )}
      </div>
    );
  };

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
        sessions={sessions}
        focusedId={focusedId}
        onFocus={focusSession}
        onRename={(id, title) => manager.rename(id, title)}
        onClose={closeSession}
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
          <strong style={{ color: 'var(--accent)' }}>Pane</strong>
          <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>Layout</span>
          <div style={{ display: 'flex', gap: 4 }}>
            {TEMPLATES.map((n) => (
              <button
                key={n}
                onClick={() => selectTemplate(n)}
                title={`${n}-pane layout`}
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
                {n === 1 ? '1' : n === 2 ? '1×2' : '2×2'}
              </button>
            ))}
          </div>
        </header>

        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          <LayoutView
            node={layout}
            renderPane={renderPane}
            onSizes={(path, sizes) =>
              setLayout((prev) => setSizesAtPath(prev, path, sizes))
            }
          />
        </div>
      </div>
    </div>
  );
}
