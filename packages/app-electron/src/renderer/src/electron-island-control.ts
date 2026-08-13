import type { IslandControl, IslandStatus } from '@app/core';
import type { PaneApi } from '../../shared/ipc.js';

/**
 * Renderer-side `IslandControl` for Electron: the sidebar's ISLAND row toggling
 * CodeIsland on and off, and keeping its allow-list in step with the active
 * workspace. All the real work (files, `open`, `defaults`) is main's; this only
 * marshals over `paneApi`. Sibling of `ElectronTraceSource`.
 */
export class ElectronIslandControl implements IslandControl {
  constructor(private readonly api: PaneApi) {}

  setEnabled(enabled: boolean, appPath?: string): Promise<IslandStatus> {
    return this.api.islandSetEnabled(enabled, appPath);
  }

  writeGate(claudeSessionIds: string[]): Promise<void> {
    return this.api.islandWriteGate(claudeSessionIds);
  }

  probe(appPath?: string): Promise<IslandStatus> {
    return this.api.islandProbe(appPath);
  }
}
