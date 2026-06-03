import { useEffect, useRef } from 'react';
import type { SessionManager } from '@app/core';
import { TerminalPane, type TerminalPaneHandle } from './TerminalPane.js';

export interface SessionTerminalProps {
  manager: SessionManager;
  sessionId: string;
  /** Register/unregister the terminal handle so the app can focus this pane. */
  onRegister?: (sessionId: string, handle: TerminalPaneHandle | null) => void;
  onFocus?: () => void;
}

/**
 * Binds one xterm pane to one session via the SessionManager. All I/O flows
 * through the manager (never the host transport directly). Output/input never
 * cross panes because everything is keyed by `sessionId` (PRD US-3.3).
 */
export function SessionTerminal({
  manager,
  sessionId,
  onRegister,
  onFocus,
}: SessionTerminalProps) {
  const handleRef = useRef<TerminalPaneHandle>(null);

  useEffect(() => {
    // Stream this session's PTY output into its xterm.
    const sub = manager.onData(sessionId, (data) =>
      handleRef.current?.write(data),
    );
    onRegister?.(sessionId, handleRef.current);
    return () => {
      sub.dispose();
      onRegister?.(sessionId, null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manager, sessionId]);

  return (
    <div
      style={{ width: '100%', height: '100%' }}
      onMouseDown={onFocus}
    >
      <TerminalPane
        ref={handleRef}
        onData={(data) => manager.write(sessionId, data)}
        onResize={(cols, rows) => manager.resize(sessionId, cols, rows)}
      />
    </div>
  );
}
