/**
 * Git worktree helpers for swarm agents (run in the Electron main process). Each
 * fan-out agent gets its own branch + working tree off the chosen repo's HEAD,
 * so the agents never trample each other's files. The worktrees live UNDER the
 * user's repo at `<repo>/.chorus/<…>` so they are visible where the work was
 * asked for; `.chorus/` is added to the repo's LOCAL ignore (`.git/info/exclude`)
 * so the main tree doesn't show them as untracked noise (without touching the
 * user's tracked `.gitignore`).
 *
 * Pure `git` over child_process; the renderer reaches these via IPC. Mirrors the
 * agent-orchestrator (MIT) worktree-per-agent pattern.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Directory (under the repo) that holds all Chorus worktrees. */
const CHORUS_DIR = '.chorus';

/** True if `dir` is inside a git work tree. Never throws. */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const { stdout } = await exec('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree']);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Ensure `.chorus/` is in the repo's local ignore so the worktrees we nest under
 * the repo don't pollute `git status` in the main tree. Uses `.git/info/exclude`
 * (machine-local, untracked) — never edits the user's `.gitignore`. Best-effort.
 */
async function ensureChorusExcluded(repoDir: string): Promise<void> {
  try {
    const { stdout } = await exec('git', ['-C', repoDir, 'rev-parse', '--git-common-dir']);
    let gitDir = stdout.trim();
    if (!path.isAbsolute(gitDir)) gitDir = path.resolve(repoDir, gitDir);
    const excludeFile = path.join(gitDir, 'info', 'exclude');
    let content = '';
    try {
      content = await fs.readFile(excludeFile, 'utf8');
    } catch {
      /* file may not exist yet */
    }
    const has = content.split('\n').some((l) => l.trim() === `${CHORUS_DIR}/`);
    if (!has) {
      await fs.mkdir(path.dirname(excludeFile), { recursive: true });
      const sep = content && !content.endsWith('\n') ? '\n' : '';
      await fs.appendFile(excludeFile, `${sep}${CHORUS_DIR}/\n`);
    }
  } catch {
    /* best-effort: a missing exclude just means the worktrees show as untracked */
  }
}

/**
 * Create a worktree + branch off `repoDir`'s current HEAD at
 * `<repoDir>/.chorus/<worktreeSubdir>`. Returns the absolute worktree path, or
 * null on failure (the caller falls back to sharing the repo dir). `worktreeSubdir`
 * carries a per-fan-out run id, so re-running a swarm never collides on branches.
 */
export async function createWorktree(
  repoDir: string,
  worktreeSubdir: string,
  branch: string,
): Promise<string | null> {
  try {
    await ensureChorusExcluded(repoDir);
    const worktreeDir = path.join(repoDir, CHORUS_DIR, worktreeSubdir);
    await exec('git', ['-C', repoDir, 'worktree', 'add', '-b', branch, worktreeDir]);
    return worktreeDir;
  } catch {
    return null;
  }
}

/** Remove a worktree (best-effort) and prune the now-empty swarm dir above it. */
export async function removeWorktree(
  repoDir: string,
  worktreeDir: string,
): Promise<void> {
  try {
    await exec('git', ['-C', repoDir, 'worktree', 'remove', '--force', worktreeDir]);
  } catch {
    /* already removed / never created */
  }
  // Tidy the empty `<repo>/.chorus/<swarm-runid>/` parent if nothing's left.
  try {
    await fs.rmdir(path.dirname(worktreeDir));
  } catch {
    /* parent not empty or gone — fine */
  }
}
