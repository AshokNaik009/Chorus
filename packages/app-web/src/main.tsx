import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionManager } from '@app/core';
import { App } from '@app/ui';
import '@app/ui/styles.css';
import { WebPtyBackend } from './web-pty-backend.js';

// Host wiring: the browser dev harness provides the concrete PtyBackend over
// the websocket bridge and injects a SessionManager into the host-agnostic UI.
const backend = new WebPtyBackend(__PTY_WS_URL__);
const manager = new SessionManager(backend);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App manager={manager} />
  </StrictMode>,
);
