import type { SwarmWorkspace } from '@app/core';
import type { PaneApi } from '../../shared/ipc.js';

/**
 * Renderer-side `SwarmWorkspace` for Electron: git worktree isolation + the
 * legacy shared-blackboard helper, all delegated to the main process (real
 * git/fs) over `paneApi`. The web harness injects nothing, so fan-out there
 * degrades to all agents sharing one dir.
 */
export class ElectronSwarmWorkspace implements SwarmWorkspace {
  readonly available = true;
  constructor(private readonly api: PaneApi) {}

  isGitRepo(dir: string): Promise<boolean> {
    return this.api.isGitRepo(dir);
  }

  createWorktree(
    repoDir: string,
    worktreeSubdir: string,
    branch: string,
  ): Promise<string | null> {
    return this.api.createWorktree(repoDir, worktreeSubdir, branch);
  }

  removeWorktree(repoDir: string, worktreeDir: string): Promise<void> {
    return this.api.removeWorktree(repoDir, worktreeDir);
  }

  createBlackboard(
    swarmId: string,
    baseCwd: string,
    doc: string,
  ): Promise<string | null> {
    return this.api.createBlackboard(swarmId, baseCwd, doc);
  }
}
