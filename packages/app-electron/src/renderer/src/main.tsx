import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionManager } from '@app/core';
import { App } from '@app/ui';
import '@app/ui/styles.css';
import { ElectronPtyBackend } from './electron-pty-backend.js';
import { ElectronPersistence } from './electron-persistence.js';

// Host wiring: the preload exposes `paneApi` (the only IPC surface). We build a
// PtyBackend + Persistence over it and inject a SessionManager into the same
// host-agnostic <App> the web harness uses. Default new panes to the real home
// directory resolved in the (Node-capable) preload.
const api = window.paneApi;
const backend = new ElectronPtyBackend(api);
const manager = new SessionManager(backend);
const persistence = new ElectronPersistence(api);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App manager={manager} persistence={persistence} defaultCwd={api.homeDir} />
  </StrictMode>,
);
