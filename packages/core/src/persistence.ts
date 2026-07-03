import type { WorkspaceState } from './models.js';

/**
 * Persistence — workspace state across restarts. See PRD §5.2.
 *
 * Both hosts persist to the shared ~/.chorus profile tree (one JSON file per
 * workspace/session/swarm — see profile.ts for the format, @app/store for the
 * fs shell): app-electron from its main process, app-web through the dev
 * server's /state routes. Both behind this single interface.
 */
export interface Persistence {
  load(): Promise<WorkspaceState | null>;
  save(state: WorkspaceState): Promise<void>;
}
