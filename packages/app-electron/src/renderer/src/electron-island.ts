import type {
  Disposable,
  IslandAction,
  IslandBridge,
  IslandViewModel,
} from '@app/core';
import type { PaneApi } from '../../shared/ipc.js';

/**
 * Renderer-side `IslandBridge` for Electron: marshals the UI's Dynamic Island
 * view-model to the main process (which owns the notch window) over the
 * preload's `paneApi`, and fans header actions back. On a non-notch Mac the
 * main side is a no-op, so this stays harmless — the UI drives it either way.
 */
export class ElectronIsland implements IslandBridge {
  constructor(private readonly api: PaneApi) {}

  update(vm: IslandViewModel): void {
    this.api.islandUpdate(vm);
  }

  onAction(cb: (action: IslandAction) => void): Disposable {
    const off = this.api.onIslandAction(cb);
    return { dispose: off };
  }
}
