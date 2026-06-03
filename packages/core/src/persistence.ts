import type { WorkspaceState } from './models.js';

/**
 * Persistence — workspace state across restarts. See PRD §5.2.
 *
 * app-web persists to a local JSON store; app-electron to a JSON file in
 * userData. Both behind this single interface.
 */
export interface Persistence {
  load(): Promise<WorkspaceState | null>;
  save(state: WorkspaceState): Promise<void>;
}
