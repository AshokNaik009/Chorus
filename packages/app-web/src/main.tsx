import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionManager } from '@app/core';
import { App } from '@app/ui';
import { WhisperWasmTranscriber } from '@app/voice';
import '@app/ui/styles.css';
import { WebPtyBackend } from './web-pty-backend.js';
import { WebFilePersistence } from './web-file-persistence.js';
import { WebTraceSource } from './web-trace-source.js';

// Host wiring: the browser dev harness provides the concrete PtyBackend over
// the websocket bridge and a Persistence over the server's /state routes
// (the shared ~/.chorus profile tree), then injects a SessionManager into the
// host-agnostic UI. The on-device WASM Whisper engine is injected for voice
// dictation (Epic 9); no SessionArchive here, so the UI offers only Layer-1
// workspace export/import (Epic 11, US-11.6). The server's /trace route backs
// the SESSION TRACE panel, so the browser host traces a pane just like Electron
// does — same core parser, different transport.
const backend = new WebPtyBackend(__PTY_WS_URL__);
const manager = new SessionManager(backend);
const persistence = new WebFilePersistence(__STATE_HTTP_URL__);
const transcribers = [new WhisperWasmTranscriber()];
const traceSource = new WebTraceSource(__TRACE_HTTP_URL__);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App
      manager={manager}
      persistence={persistence}
      transcribers={transcribers}
      traceSource={traceSource}
    />
  </StrictMode>,
);
