import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionManager } from '@app/core';
import { App } from '@app/ui';
import { WhisperWasmTranscriber } from '@app/voice';
import '@app/ui/styles.css';
import { WebPtyBackend } from './web-pty-backend.js';
import { WebPersistence } from './web-persistence.js';

// Host wiring: the browser dev harness provides the concrete PtyBackend over
// the websocket bridge and a localStorage-backed Persistence, then injects a
// SessionManager into the host-agnostic UI. The on-device WASM Whisper engine is
// injected for voice dictation (Epic 9); no SessionArchive here, so the UI offers
// only Layer-1 workspace export/import (Epic 11, US-11.6).
const backend = new WebPtyBackend(__PTY_WS_URL__);
const manager = new SessionManager(backend);
const persistence = new WebPersistence();
const transcribers = [new WhisperWasmTranscriber()];

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App manager={manager} persistence={persistence} transcribers={transcribers} />
  </StrictMode>,
);
