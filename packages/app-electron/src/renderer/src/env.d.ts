/// <reference types="vite/client" />
import type { PaneApi } from '../../shared/ipc.js';

declare global {
  interface Window {
    /** Exposed by the preload via contextBridge — the only IPC surface. */
    paneApi: PaneApi;
  }
}

export {};
