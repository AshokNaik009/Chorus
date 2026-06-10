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
import type { MergeResult, WorktreeReview } from '@app/core';

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

/** True if `worktreeDir` is still a registered worktree of `repoDir`. */
async function isRegisteredWorktree(
  repoDir: string,
  worktreeDir: string,
): Promise<boolean> {
  try {
    const { stdout } = await exec('git', [
      '-C',
      repoDir,
      'worktree',
      'list',
      '--porcelain',
    ]);
    const target = path.resolve(worktreeDir);
    return stdout
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .some((l) => path.resolve(l.slice('worktree '.length).trim()) === target);
  } catch {
    return false;
  }
}

/**
 * Remove a worktree (best-effort) and prune the now-empty swarm dir above it.
 * Hardened the way agent-orchestrator's worktree plugin learned to: prune first
 * (clears trees whose directory vanished out from under git), then only call
 * `worktree remove` when the path is still registered, so an already-gone tree
 * is a silent no-op rather than relying on the throw. Idempotent — safe to call
 * twice (e.g. the live ref AND the persisted-member cleanup sweep both fire).
 */
export async function removeWorktree(
  repoDir: string,
  worktreeDir: string,
): Promise<void> {
  // Prune dangling registrations first (dir deleted manually, etc.).
  try {
    await exec('git', ['-C', repoDir, 'worktree', 'prune']);
  } catch {
    /* not a repo / git missing — nothing to prune */
  }
  if (await isRegisteredWorktree(repoDir, worktreeDir)) {
    try {
      await exec('git', ['-C', repoDir, 'worktree', 'remove', '--force', worktreeDir]);
    } catch {
      /* race / locked — leave it for the next prune */
    }
  }
  // Tidy the empty `<repo>/.chorus/<swarm-runid>/` parent if nothing's left.
  try {
    await fs.rmdir(path.dirname(worktreeDir));
  } catch {
    /* parent not empty or gone — fine */
  }
}

/** Prune dangling worktree registrations for `repoDir` (best-effort). */
export async function pruneWorktrees(repoDir: string): Promise<void> {
  try {
    await exec('git', ['-C', repoDir, 'worktree', 'prune']);
  } catch {
    /* not a repo / git missing */
  }
}

/**
 * The repo's currently-checked-out branch — the merge target. Falls back to the
 * short HEAD sha on a detached HEAD. Empty string if git can't answer.
 */
async function currentBranch(repoDir: string): Promise<string> {
  try {
    const { stdout } = await exec('git', [
      '-C',
      repoDir,
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
    ]);
    const b = stdout.trim();
    if (b && b !== 'HEAD') return b;
  } catch {
    /* fall through to sha */
  }
  try {
    const { stdout } = await exec('git', ['-C', repoDir, 'rev-parse', '--short', 'HEAD']);
    return stdout.trim();
  } catch {
    return '';
  }
}

/** True if the worktree has uncommitted (staged or unstaged) changes. */
async function isDirty(worktreeDir: string): Promise<boolean> {
  try {
    const { stdout } = await exec('git', [
      '-C',
      worktreeDir,
      'status',
      '--porcelain',
    ]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Summarize an agent branch's work vs the repo's current branch. Uses a three-dot
 * diff (`base...branch`) so a base that moved on after the worktree was created
 * still shows only the branch's own changes. Best-effort; never throws.
 */
export async function reviewWorktree(
  repoDir: string,
  branch: string,
  worktreeDir: string,
): Promise<WorktreeReview> {
  const baseBranch = await currentBranch(repoDir);
  const dirty = await isDirty(worktreeDir);
  const empty: WorktreeReview = {
    branch,
    baseBranch,
    hasChanges: dirty,
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
    files: [],
    commits: [],
    dirty,
  };
  if (!baseBranch) return empty;

  const range = `${baseBranch}...${branch}`;
  const files: WorktreeReview['files'] = [];
  let insertions = 0;
  let deletions = 0;
  try {
    const { stdout } = await exec('git', [
      '-C',
      repoDir,
      'diff',
      '--numstat',
      range,
    ]);
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [a, d, ...rest] = trimmed.split('\t');
      const filePath = rest.join('\t');
      if (!filePath) continue;
      // Binary files report '-' for both counts.
      const added = a === '-' ? 0 : Number(a) || 0;
      const deleted = d === '-' ? 0 : Number(d) || 0;
      files.push({ path: filePath, added, deleted });
      insertions += added;
      deletions += deleted;
    }
  } catch {
    /* diff failed (branch gone?) — leave files empty */
  }

  const commits: WorktreeReview['commits'] = [];
  try {
    const { stdout } = await exec('git', [
      '-C',
      repoDir,
      'log',
      '--format=%h%x09%s',
      `${baseBranch}..${branch}`,
    ]);
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      commits.push({ hash: line.slice(0, tab), subject: line.slice(tab + 1) });
    }
  } catch {
    /* log failed — leave commits empty */
  }

  return {
    branch,
    baseBranch,
    hasChanges: files.length > 0 || dirty,
    filesChanged: files.length,
    insertions,
    deletions,
    files,
    commits,
    dirty,
  };
}

/**
 * Land an agent branch into the repo's current branch. Auto-commits any
 * uncommitted worktree edits onto the branch first (so nothing the agent
 * produced is lost), then merges (or squash-merges) in the main repo. On
 * conflict the merge is aborted and the base branch left intact.
 */
export async function mergeWorktree(
  repoDir: string,
  branch: string,
  worktreeDir: string,
  opts: { squash: boolean },
): Promise<MergeResult> {
  // 1. Auto-commit uncommitted worktree changes onto the agent's branch.
  if (await isDirty(worktreeDir)) {
    try {
      await exec('git', ['-C', worktreeDir, 'add', '-A']);
      await exec('git', [
        '-C',
        worktreeDir,
        'commit',
        '-m',
        `chorus: auto-commit ${branch} before merge`,
      ]);
    } catch {
      /* nothing to commit / hook rejected — continue with whatever is committed */
    }
  }

  const baseBranch = await currentBranch(repoDir);
  if (!baseBranch) {
    return { ok: false, conflict: false, message: 'Could not resolve the repo branch to merge into.' };
  }

  // 2. Merge into the repo's current branch (already checked out — no checkout).
  try {
    if (opts.squash) {
      await exec('git', ['-C', repoDir, 'merge', '--squash', branch]);
      await exec('git', [
        '-C',
        repoDir,
        'commit',
        '-m',
        `chorus: squash-merge ${branch}`,
      ]);
    } else {
      await exec('git', ['-C', repoDir, 'merge', '--no-edit', branch]);
    }
    return { ok: true, conflict: false, message: `Merged ${branch} into ${baseBranch}.` };
  } catch (e) {
    const message = (e as { stderr?: string; message?: string }).stderr?.trim() ||
      (e as Error).message ||
      'Merge failed.';
    // Conflict (or squash with nothing to commit) — abort to leave base intact.
    let conflict = false;
    try {
      await exec('git', ['-C', repoDir, 'merge', '--abort']);
      conflict = true;
    } catch {
      // No merge in progress to abort. If squash staged changes but commit
      // failed because nothing changed, reset the index to keep base clean.
      try {
        await exec('git', ['-C', repoDir, 'reset', '--hard', 'HEAD']);
      } catch {
        /* best-effort */
      }
    }
    return {
      ok: false,
      conflict,
      message: conflict
        ? `Merge conflict landing ${branch} into ${baseBranch}; aborted, base unchanged.`
        : message,
    };
  }
}

/** Remove an agent's worktree AND delete its branch (the "throw it away" action). */
export async function discardWorktree(
  repoDir: string,
  worktreeDir: string,
  branch: string,
): Promise<void> {
  await removeWorktree(repoDir, worktreeDir);
  try {
    await exec('git', ['-C', repoDir, 'branch', '-D', branch]);
  } catch {
    /* branch already gone / merged */
  }
}
