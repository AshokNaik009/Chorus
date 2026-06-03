import { StrictMode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionManager, type SessionStatus } from '@app/core';
import { TerminalPane, type TerminalPaneHandle } from '@app/ui';
import '@app/ui/styles.css';
import { WebPtyBackend } from './web-pty-backend.js';

const SESSION_ID = 'main';

const STATUS_COLOR: Record<SessionStatus, string> = {
  spawning: 'var(--status-spawning)',
  running: 'var(--status-running)',
  waiting: 'var(--status-waiting)',
  idle: 'var(--status-idle)',
  exited: 'var(--status-exited)',
};

function Harness() {
  const termRef = useRef<TerminalPaneHandle>(null);
  const sizeRef = useRef<{ cols: number; rows: number }>({ cols: 80, rows: 24 });

  // One backend + manager for the whole harness. The UI drives sessions ONLY
  // through the manager — it never talks to the ws/pty bridge directly.
  const manager = useMemo(() => {
    const backend = new WebPtyBackend(__PTY_WS_URL__);
    return new SessionManager(backend);
  }, []);

  const [cwd, setCwd] = useState('~');
  const [spawned, setSpawned] = useState(false);
  const [status, setStatus] = useState<SessionStatus | null>(null);

  useEffect(() => {
    // Render PTY output into xterm.
    const dataSub = manager.onData(SESSION_ID, (d) => termRef.current?.write(d));
    // Reflect status changes from the core state machine.
    const changeSub = manager.onChange.on(() => {
      setStatus(manager.get(SESSION_ID)?.status ?? null);
    });
    return () => {
      dataSub.dispose();
      changeSub.dispose();
      manager.dispose();
    };
  }, [manager]);

  const spawn = (command?: string) => {
    if (spawned) return;
    void manager.spawn(
      { sessionId: SESSION_ID, title: command ?? 'shell', cwd: cwd.trim() || '~' },
      sizeRef.current,
      { command },
    );
    setSpawned(true);
    termRef.current?.focus();
  };

  return (
    <div style={layout}>
      <header style={header}>
        <strong style={{ color: 'var(--accent)' }}>Pane</strong>
        <span style={{ color: 'var(--fg-muted)' }}>dev harness · core-driven</span>
        {status && (
          <span style={badge(STATUS_COLOR[status])}>{status}</span>
        )}
        <label style={{ marginLeft: 12, color: 'var(--fg-muted)' }}>cwd</label>
        <input
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          disabled={spawned}
          placeholder="/path/to/project or ~"
          style={input}
        />
        <button onClick={() => spawn()} disabled={spawned} style={btn}>
          Open shell
        </button>
        <button
          onClick={() => spawn('claude')}
          disabled={spawned}
          style={{ ...btn, borderColor: 'var(--accent)' }}
        >
          Run claude
        </button>
      </header>

      <main style={{ flex: 1, minHeight: 0, padding: 8 }}>
        <TerminalPane
          ref={termRef}
          onData={(data) => manager.write(SESSION_ID, data)}
          onResize={(cols, rows) => {
            sizeRef.current = { cols, rows };
            manager.resize(SESSION_ID, cols, rows);
          }}
        />
      </main>
    </div>
  );
}

const layout: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  background: 'var(--bg)',
};
const header: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 12px',
  background: 'var(--bg-elevated)',
  borderBottom: '1px solid var(--border)',
};
const input: React.CSSProperties = {
  flex: 1,
  background: 'var(--bg)',
  color: 'var(--fg)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '4px 8px',
  fontFamily: 'inherit',
};
const btn: React.CSSProperties = {
  background: 'var(--bg)',
  color: 'var(--fg)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '4px 12px',
  cursor: 'pointer',
  fontFamily: 'inherit',
};
const badge = (color: string): React.CSSProperties => ({
  display: 'inline-block',
  padding: '2px 8px',
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 600,
  color: '#0e1116',
  background: color,
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
