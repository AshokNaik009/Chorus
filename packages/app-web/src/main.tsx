import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TerminalPane, type TerminalPaneHandle } from '@app/ui';
import '@app/ui/styles.css';
import type { ClientMsg, ServerMsg } from './protocol.js';

const SESSION_ID = 'main';

function Harness() {
  const termRef = useRef<TerminalPaneHandle>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const sizeRef = useRef<{ cols: number; rows: number }>({ cols: 80, rows: 24 });
  const spawnedRef = useRef(false);

  const [cwd, setCwd] = useState<string>('~');
  const [connected, setConnected] = useState(false);
  const [spawned, setSpawned] = useState(false);

  useEffect(() => {
    const ws = new WebSocket(__PTY_WS_URL__);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string) as ServerMsg;
      if (msg.sessionId !== SESSION_ID) return;
      if (msg.type === 'data') {
        termRef.current?.write(msg.data);
      } else if (msg.type === 'exit') {
        termRef.current?.write(
          `\r\n\x1b[90m[process exited with code ${msg.exitCode}]\x1b[0m\r\n`,
        );
        spawnedRef.current = false;
        setSpawned(false);
      }
    };

    return () => ws.close();
  }, []);

  const sendMsg = (msg: ClientMsg) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  };

  const spawn = (command?: string) => {
    if (spawnedRef.current) return;
    const { cols, rows } = sizeRef.current;
    sendMsg({
      type: 'spawn',
      sessionId: SESSION_ID,
      cwd: cwd.trim() || '~',
      cols,
      rows,
      command,
    });
    spawnedRef.current = true;
    setSpawned(true);
    termRef.current?.focus();
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'var(--bg)',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          background: 'var(--bg-elevated)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <strong style={{ color: 'var(--accent)' }}>Pane</strong>
        <span style={{ color: 'var(--fg-muted)' }}>dev harness</span>
        <span
          title={connected ? 'ws connected' : 'ws disconnected'}
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: connected
              ? 'var(--status-running)'
              : 'var(--status-exited)',
          }}
        />
        <label style={{ marginLeft: 12, color: 'var(--fg-muted)' }}>cwd</label>
        <input
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          disabled={spawned}
          placeholder="/path/to/project or ~"
          style={{
            flex: 1,
            background: 'var(--bg)',
            color: 'var(--fg)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '4px 8px',
            fontFamily: 'inherit',
          }}
        />
        <button
          onClick={() => spawn()}
          disabled={!connected || spawned}
          style={btnStyle}
        >
          Open shell
        </button>
        <button
          onClick={() => spawn('claude')}
          disabled={!connected || spawned}
          style={{ ...btnStyle, borderColor: 'var(--accent)' }}
        >
          Run claude
        </button>
      </header>

      <main style={{ flex: 1, minHeight: 0, padding: 8 }}>
        <TerminalPane
          ref={termRef}
          onData={(data) =>
            sendMsg({ type: 'input', sessionId: SESSION_ID, data })
          }
          onResize={(cols, rows) => {
            sizeRef.current = { cols, rows };
            if (spawnedRef.current) {
              sendMsg({ type: 'resize', sessionId: SESSION_ID, cols, rows });
            }
          }}
        />
      </main>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  background: 'var(--bg)',
  color: 'var(--fg)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '4px 12px',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
