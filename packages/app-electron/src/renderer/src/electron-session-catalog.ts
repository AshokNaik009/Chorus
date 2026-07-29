import type { LiveSession, SessionCatalog, SessionMeta } from '@app/core';
import type { PaneApi } from '../../shared/ipc.js';

/**
 * Renderer-side `SessionCatalog` for Electron: the SESSIONS panel's window onto
 * the machine's Claude Code transcript store. All the `~/.claude` work happens
 * in main; this only marshals over `paneApi`. The web harness injects nothing,
 * so the panel doesn't render there.
 */
export class ElectronSessionCatalog implements SessionCatalog {
  constructor(private readonly api: PaneApi) {}

  listSessions(opts?: { limit?: number }): Promise<SessionMeta[]> {
    return this.api.listSessions(opts?.limit);
  }

  liveSessions(): Promise<LiveSession[]> {
    return this.api.liveSessions();
  }
}
