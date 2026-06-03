import type { Persistence, WorkspaceState } from '@app/core';
import type { PaneApi } from '../../shared/ipc.js';

/**
 * Renderer-side `Persistence` for Electron: load/save go to the main process,
 * which reads/writes a JSON file in userData. The same interface app-web backs
 * with localStorage — the UI is identical on both hosts (PRD §5.2).
 */
export class ElectronPersistence implements Persistence {
  constructor(private readonly api: PaneApi) {}

  load(): Promise<WorkspaceState | null> {
    return this.api.loadState();
  }

  async save(state: WorkspaceState): Promise<void> {
    await this.api.saveState(state);
  }
}
