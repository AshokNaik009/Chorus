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
 *
 * A pane is unmounted whenever its workspace is left, so mounting is a
 * *re*attach as often as not: the session's recent output is replayed into the
 * new terminal, and live output that lands before the terminal is ready is
 * queued behind it so the screen is rebuilt in the order it was produced.
 */
export function SessionTerminal({
  manager,
  sessionId,
  onRegister,
  onFocus,
}: SessionTerminalProps) {
  const handleRef = useRef<TerminalPaneHandle>(null);
  // Output waits here until the terminal has been sized; see `flush` below.
  const pendingRef = useRef<string[]>([]);
  const readyRef = useRef(false);

  useEffect(() => {
    readyRef.current = false;
    pendingRef.current = [];
    const sub = manager.onData(sessionId, (data) => {
      if (readyRef.current) handleRef.current?.write(data);
      else pendingRef.current.push(data);
    });
    // Snapshot the backlog immediately after subscribing: both calls are
    // synchronous, so no chunk can slip between them and be written twice.
    const backlog = manager.replayText(sessionId);
    if (backlog) pendingRef.current.unshift(backlog);
    onRegister?.(sessionId, handleRef.current);
    return () => {
      sub.dispose();
      onRegister?.(sessionId, null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manager, sessionId]);

  // Written only once the pane has been sized, so the backlog is laid out at the
  // width it was produced at rather than xterm's 80-column default — replaying
  // earlier would wrap every line and leave the resize to reflow them back.
  // Idempotent, and driven from both signals that follow a fit: the resize (the
  // precise one) and ready (which still fires for a pane that has no size yet,
  // e.g. a background tab, so nothing can be stranded unwritten).
  const flush = () => {
    const handle = handleRef.current;
    if (!handle || readyRef.current) return;
    readyRef.current = true;
    for (const chunk of pendingRef.current) handle.write(chunk);
    pendingRef.current = [];
  };

  return (
    <div
      style={{ width: '100%', height: '100%' }}
      onMouseDown={onFocus}
    >
      <TerminalPane
        ref={handleRef}
        onReady={flush}
        onData={(data) => manager.write(sessionId, data)}
        onResize={(cols, rows) => {
          manager.resize(sessionId, cols, rows);
          flush();
        }}
      />
    </div>
  );
}
