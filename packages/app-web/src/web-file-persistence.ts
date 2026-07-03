import {
  parseWorkspaceState,
  type Persistence,
  type WorkspaceState,
} from '@app/core';

/** The pre-profile localStorage blob, and where it is parked after import. */
const LEGACY_KEY = 'pane.workspace-state.v2';
const RETIRED_KEY = 'pane.workspace-state.v2.migrated';

/**
 * Browser-side Persistence for the dev harness, backed by the server's
 * /state routes — the same ~/.chorus profile tree the Electron host writes.
 * Replaces the old localStorage store; a lingering legacy blob is pushed up
 * once when the server store is empty, then the key is retired (renamed, not
 * deleted, so the data stays recoverable). Network/corrupt state degrades to
 * null and the app falls back to a default workspace (PRD US-6.1).
 */
export class WebFilePersistence implements Persistence {
  constructor(private readonly baseUrl: string) {}

  async load(): Promise<WorkspaceState | null> {
    try {
      const res = await fetch(`${this.baseUrl}/state`);
      if (res.status === 204) return this.migrateLegacy();
      if (!res.ok) return null;
      const state = parseWorkspaceState(await res.json());
      // The server already has state — any legacy blob is stale; retire it.
      if (state) this.retireLegacyKey();
      return state;
    } catch {
      return null;
    }
  }

  async save(state: WorkspaceState): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/state`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(state),
      });
    } catch {
      // server down — non-fatal for an in-memory session
    }
  }

  /**
   * Empty server store: import the legacy localStorage blob once. Returning
   * it even if the PUT failed is safe — the state is live in memory and the
   * next debounced save retries. Idempotent under StrictMode's double load
   * (second call sees a populated server or a retired key).
   */
  private async migrateLegacy(): Promise<WorkspaceState | null> {
    const legacy = this.readLegacy();
    if (!legacy) return null;
    await this.save(legacy);
    this.retireLegacyKey();
    return legacy;
  }

  private readLegacy(): WorkspaceState | null {
    try {
      const raw = localStorage.getItem(LEGACY_KEY);
      return raw ? parseWorkspaceState(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }

  private retireLegacyKey(): void {
    try {
      const raw = localStorage.getItem(LEGACY_KEY);
      if (raw === null) return;
      localStorage.setItem(RETIRED_KEY, raw);
      localStorage.removeItem(LEGACY_KEY);
    } catch {
      // storage unavailable — ignore for the dev harness
    }
  }
}
