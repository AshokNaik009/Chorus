import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  assembleProfile,
  diffProfileFiles,
  isSafeEntityId,
  planProfileFiles,
  type Persistence,
  type ProfileFiles,
  type WorkspaceState,
} from '@app/core';

/** The profile root: `$CHORUS_HOME` when set, else `~/.chorus`. */
export function resolveChorusHome(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.CHORUS_HOME?.trim();
  return override ? override : path.join(os.homedir(), '.chorus');
}

/**
 * `Persistence` backed by the `~/.chorus` file tree (@app/core's profile
 * format). One instance per host process.
 *
 * - Reads only managed paths; anything else in the tree (user notes,
 *   dotfiles) is invisible and never deleted.
 * - Saves diff against the last tree THIS instance read or wrote, rewrite
 *   only changed files (atomic tmp + rename), and delete files for removed
 *   entities. No re-reads, no locks: when two hosts share the profile the
 *   last writer wins per file, and divergence resolves on next load.
 * - Like the stores it replaces, load/save never throw — a broken disk
 *   degrades to the in-memory session.
 */
export class FileTreeStore implements Persistence {
  /** The last tree this instance read or wrote (null = never loaded). */
  private snapshot: ProfileFiles | null = null;
  /** Set when the profile declares a future storeVersion — never save then. */
  private incompatible = false;

  constructor(private readonly root: string) {}

  async load(): Promise<WorkspaceState | null> {
    const files = await this.readTree();
    this.snapshot = files;
    const { state, incompatible } = assembleProfile(files);
    this.incompatible = incompatible;
    return state;
  }

  async save(state: WorkspaceState): Promise<void> {
    if (this.incompatible) return;
    const next = planProfileFiles(state);
    const { writes, deletes } = diffProfileFiles(this.snapshot, next);

    // Track per-file outcomes so a failed write stays "dirty" in the
    // snapshot and is retried by the next debounced save.
    const applied: ProfileFiles = { ...(this.snapshot ?? {}) };
    for (const [rel, content] of Object.entries(writes)) {
      const abs = path.join(this.root, rel);
      const tmp = `${abs}.tmp-${process.pid}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      try {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(tmp, content, 'utf8');
        await fs.rename(tmp, abs); // same dir -> atomic on POSIX
        applied[rel] = content;
      } catch {
        await fs.unlink(tmp).catch(() => {});
      }
    }
    for (const rel of deletes) {
      try {
        await fs.unlink(path.join(this.root, rel));
        delete applied[rel];
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          delete applied[rel];
        }
      }
    }
    await this.pruneWorkspaceDirs(deletes, next);
    this.snapshot = applied;
  }

  /**
   * Remove the now-empty directories of workspaces that vanished. Plain
   * `rmdir` only (never recursive): a stray unmanaged file keeps its
   * directory alive rather than being destroyed.
   */
  private async pruneWorkspaceDirs(
    deletes: string[],
    next: ProfileFiles,
  ): Promise<void> {
    const gone = new Set<string>();
    for (const rel of deletes) {
      const m = /^workspaces\/([^/]+)\//.exec(rel);
      if (!m) continue;
      const prefix = `workspaces/${m[1]}/`;
      if (!Object.keys(next).some((p) => p.startsWith(prefix))) gone.add(m[1]);
    }
    for (const id of gone) {
      const dir = path.join(this.root, 'workspaces', id);
      for (const sub of ['sessions', 'swarms']) {
        await fs.rmdir(path.join(dir, sub)).catch(() => {});
      }
      await fs.rmdir(dir).catch(() => {});
    }
  }

  /** Read the managed paths into a ProfileFiles map. Missing root -> {}. */
  private async readTree(): Promise<ProfileFiles> {
    const files: ProfileFiles = {};
    const read = async (rel: string): Promise<void> => {
      try {
        files[rel] = await fs.readFile(path.join(this.root, rel), 'utf8');
      } catch {
        // missing/unreadable -> simply not part of the tree
      }
    };

    await read('state.json');
    await read('settings.json');

    let wsIds: string[] = [];
    try {
      wsIds = (
        await fs.readdir(path.join(this.root, 'workspaces'), {
          withFileTypes: true,
        })
      )
        .filter((e) => e.isDirectory() && isSafeEntityId(e.name))
        .map((e) => e.name);
    } catch {
      // no workspaces dir yet
    }

    for (const id of wsIds) {
      await read(`workspaces/${id}/workspace.json`);
      for (const kind of ['sessions', 'swarms'] as const) {
        let names: string[] = [];
        try {
          names = (
            await fs.readdir(path.join(this.root, 'workspaces', id, kind), {
              withFileTypes: true,
            })
          )
            .filter(
              (e) =>
                e.isFile() &&
                e.name.endsWith('.json') &&
                isSafeEntityId(e.name.slice(0, -'.json'.length)),
            )
            .map((e) => e.name);
        } catch {
          // no such subdir
        }
        for (const name of names) {
          await read(`workspaces/${id}/${kind}/${name}`);
        }
      }
    }
    return files;
  }
}
