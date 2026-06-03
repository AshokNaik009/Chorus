import {
  parseWorkspaceState,
  type Persistence,
  type WorkspaceState,
} from '@app/core';

const KEY = 'pane.workspace-state.v2';

/**
 * Browser-side Persistence backed by localStorage. Corrupt/missing/old state
 * returns null so the app falls back to a default 1-pane workspace (PRD US-6.1).
 * app-electron will implement the same interface against a userData JSON file.
 */
export class WebPersistence implements Persistence {
  async load(): Promise<WorkspaceState | null> {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      return parseWorkspaceState(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  async save(state: WorkspaceState): Promise<void> {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      // storage full / unavailable — ignore for the dev harness
    }
  }
}
