import type { SwarmWorkspace } from '@app/core';
import type { PaneApi } from '../../shared/ipc.js';

/**
 * Renderer-side `SwarmWorkspace` for Electron: creating the shared blackboard
 * directory + `CHORUS_SWARM.md` goes to the main process (real fs) over `paneApi`.
 * The web harness injects nothing, so fan-out there runs without a shared dir.
 */
export class ElectronSwarmWorkspace implements SwarmWorkspace {
  readonly available = true;
  constructor(private readonly api: PaneApi) {}

  createBlackboard(
    swarmId: string,
    baseCwd: string,
    doc: string,
  ): Promise<string | null> {
    return this.api.createBlackboard(swarmId, baseCwd, doc);
  }
}
