import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionManager } from '@app/core';
import { App } from '@app/ui';
import { WhisperWasmTranscriber } from '@app/voice';
import '@app/ui/styles.css';
import { ElectronPtyBackend } from './electron-pty-backend.js';
import { ElectronPersistence } from './electron-persistence.js';
import { ElectronSwarmWorkspace } from './electron-swarm-workspace.js';
import { ElectronSessionArchive } from './electron-session-archive.js';

// Host wiring: the preload exposes `paneApi` (the only IPC surface). We build a
// PtyBackend + Persistence over it and inject a SessionManager into the same
// host-agnostic <App> the web harness uses. Default new panes to the real home
// directory resolved in the (Node-capable) preload. The on-device WASM Whisper
// engine is injected for voice dictation (Epic 9); the desktop SessionArchive for
// Layer-2 memory portability is wired in M12.
const api = window.paneApi;
const backend = new ElectronPtyBackend(api);
const manager = new SessionManager(backend);
const persistence = new ElectronPersistence(api);
const transcribers = [new WhisperWasmTranscriber()];
const swarmWorkspace = new ElectronSwarmWorkspace(api);
const sessionArchive = new ElectronSessionArchive(api);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App
      manager={manager}
      persistence={persistence}
      defaultCwd={api.homeDir}
      transcribers={transcribers}
      swarmWorkspace={swarmWorkspace}
      sessionArchive={sessionArchive}
    />
  </StrictMode>,
);
