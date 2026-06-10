/**
 * Agent swarm — coordinate several Claude Code sessions on one task. See PRD
 * Epic 10. This is orchestration glue over the existing terminal seam plus a tiny
 * host helper for the shared blackboard directory; it delivers *coordinated*, not
 * *self-directing*, agents (autonomous reassignment is an explicit non-goal).
 *
 * The broadcast targeting, role-seed templating, and blackboard document are pure
 * and unit-tested here; only creating the shared directory needs the host.
 */
import type { SwarmDef, SwarmMember } from './models.js';

/** Ctrl-C — sent to every member by "Stop all" (US-10.5). */
export const SWARM_INTERRUPT = '\x03';

/**
 * Hard cap on agents in one fan-out. A swarm lays out one pane per agent and the
 * grid tops out at 6 (TERMINAL_COUNTS / buildGrid), so more agents than this have
 * nowhere to render. Single source of truth — the UI cap and the fan-out guard
 * both read it, so the limit can't drift between them.
 */
export const MAX_SWARM_AGENTS = 6;

/**
 * Clamp a worker list to the agent cap, keeping the first `MAX_SWARM_AGENTS`.
 * Defensive backstop for the fan-out path: the UI already disables adding past
 * the cap, but no caller should ever build a swarm the layout can't show.
 */
export function clampSwarmWorkers<T>(workers: T[]): T[] {
  return workers.length > MAX_SWARM_AGENTS
    ? workers.slice(0, MAX_SWARM_AGENTS)
    : workers;
}

/** A file's line delta in an agent's branch vs the repo's current branch. */
export interface WorktreeReviewFile {
  path: string;
  added: number;
  deleted: number;
}

/** Summary of one agent worktree's work, for the review/merge view. */
export interface WorktreeReview {
  branch: string;
  /** The repo's current branch — the merge target (resolved at review time). */
  baseBranch: string;
  /** True if the branch has commits ahead of base OR uncommitted worktree edits. */
  hasChanges: boolean;
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: WorktreeReviewFile[];
  commits: { hash: string; subject: string }[];
  /** The worktree has uncommitted changes (merge will auto-commit them first). */
  dirty: boolean;
}

/** Outcome of merging an agent branch into the repo's current branch. */
export interface MergeResult {
  ok: boolean;
  /** True when the merge hit a conflict and was aborted (base left intact). */
  conflict: boolean;
  message: string;
}

let swarmCounter = 0;
/** Process-unique swarm id, no platform globals. */
export function createSwarmId(): string {
  swarmCounter += 1;
  return `swarm-${Date.now().toString(36)}-${swarmCounter}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

/** The minimal terminal write the orchestrator needs (SessionManager satisfies it). */
export interface SwarmWriter {
  write(sessionId: string, data: string): void;
}

/**
 * Host capabilities the renderer injects for swarms: git worktree isolation
 * (one branch + working tree per agent) plus the legacy shared-blackboard
 * helper. Electron does the real `git`/fs work; the web harness injects nothing,
 * so fan-out there degrades to all agents sharing one dir (US-10.4).
 */
export interface SwarmWorkspace {
  /** True when real worktrees / shared files can be created (Electron). */
  readonly available: boolean;
  /** True if `dir` is inside a git work tree (worktrees need a repo). */
  isGitRepo(dir: string): Promise<boolean>;
  /**
   * Create an isolated worktree + branch off `repoDir`'s HEAD. `worktreeSubdir`
   * is a relative path the host bases under its own worktree root (kept out of
   * the repo to avoid nested-worktree mess). Returns the absolute worktree path,
   * or null on failure (caller falls back to the shared dir).
   */
  createWorktree(
    repoDir: string,
    worktreeSubdir: string,
    branch: string,
  ): Promise<string | null>;
  /** Remove a worktree previously created (best-effort). `worktreeDir` is absolute. */
  removeWorktree(repoDir: string, worktreeDir: string): Promise<void>;
  /**
   * Summarize an agent branch's work (files ±, commits, dirty) vs the repo's
   * current branch. Best-effort; never throws.
   */
  reviewWorktree(
    repoDir: string,
    branch: string,
    worktreeDir: string,
  ): Promise<WorktreeReview>;
  /**
   * Land an agent branch into the repo's current branch. Auto-commits any
   * uncommitted worktree edits first. `squash` collapses to one commit. On
   * conflict the merge is aborted and `{ok:false, conflict:true}` returned.
   */
  mergeWorktree(
    repoDir: string,
    branch: string,
    worktreeDir: string,
    opts: { squash: boolean },
  ): Promise<MergeResult>;
  /** Remove an agent's worktree AND delete its branch (best-effort). */
  discardWorktree(
    repoDir: string,
    worktreeDir: string,
    branch: string,
  ): Promise<void>;
  /**
   * Create the blackboard directory and write `CHORUS_SWARM.md` into it under
   * `baseCwd`. Returns the absolute directory path, or null if unavailable.
   */
  createBlackboard(
    swarmId: string,
    baseCwd: string,
    doc: string,
  ): Promise<string | null>;
}

/** Deterministic branch + worktree-subdir names for one swarm agent. Pure. */
export interface AgentWorktreePlan {
  role: string;
  branch: string;
  worktreeSubdir: string;
}

/** Lowercase, hyphenate, strip junk; never empty. */
function slugify(s: string, fallback: string): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

/**
 * Plan one worktree per role: branch `chorus/<swarm>[-<run>]/<role>`, subdir
 * `<swarm>[-<run>]/<role>`. Pure and deterministic. Duplicate or empty roles are
 * disambiguated with a trailing index so every agent gets a unique branch. Pass
 * a per-fan-out `runId` so re-running the same-named swarm doesn't collide with
 * the branches/worktrees the previous run left behind.
 */
export function planAgentWorktrees(
  swarmName: string,
  roles: string[],
  runId?: string,
): AgentWorktreePlan[] {
  const base = slugify(swarmName, 'swarm');
  const swarmSlug = runId ? `${base}-${slugify(runId, 'run')}` : base;
  const seen = new Map<string, number>();
  return roles.map((role, i) => {
    let roleSlug = slugify(role ?? '', `agent-${i + 1}`);
    const count = seen.get(roleSlug) ?? 0;
    seen.set(roleSlug, count + 1);
    if (count > 0) roleSlug = `${roleSlug}-${count + 1}`;
    return {
      role,
      branch: `chorus/${swarmSlug}/${roleSlug}`,
      worktreeSubdir: `${swarmSlug}/${roleSlug}`,
    };
  });
}

/** Session ids that a broadcast should reach, honoring an optional allow-list. */
export function broadcastTargets(
  members: SwarmMember[],
  only?: string[],
): string[] {
  const allow = only ? new Set(only) : null;
  return members
    .map((m) => m.sessionId)
    .filter((id) => !allow || allow.has(id));
}

/** A broadcast/voice payload: submit appends Enter (CR), insert does not. */
export function formatBroadcast(text: string, submit: boolean): string {
  return submit ? `${text}\r` : text;
}

/** Write the same text to many sessions at once (US-10.1). */
export function broadcastTo(
  writer: SwarmWriter,
  sessionIds: string[],
  text: string,
  submit: boolean,
): void {
  const data = formatBroadcast(text, submit);
  for (const id of sessionIds) writer.write(id, data);
}

/**
 * Role/context framing passed to `--append-system-prompt` for a worker agent.
 * The agent's actual task is the positional prompt (CLI arg); this sets the lane
 * AND pins the agent to its working directory. `workdir` is the agent's real
 * cwd; `isolated` is true only when a git worktree was actually created for it
 * (otherwise it shares the directory with the other agents — be honest, since a
 * permissionless agent will otherwise wander off and write absolute paths
 * outside the folder the user chose).
 */
export function buildAgentSystemPrompt(
  swarmName: string,
  role: string | undefined,
  sharedTask: string | undefined,
  workdir: string,
  isolated: boolean,
): string {
  const r = role?.trim();
  const parts: string[] = [
    r
      ? `You are the "${r}" agent in the Chorus swarm "${swarmName}".`
      : `You are an agent in the Chorus swarm "${swarmName}".`,
  ];
  if (sharedTask?.trim()) parts.push(`Shared context: ${sharedTask.trim()}.`);
  parts.push(
    `Your working directory is ${workdir}. Create and edit ALL files INSIDE this directory using relative paths. Do NOT create files anywhere else on the system and do NOT use absolute paths that point outside this directory, even if the task text mentions one — treat any such path as relative to this directory.`,
  );
  parts.push(
    isolated
      ? 'You have your own isolated git branch and worktree here; commit your changes when you finish.'
      : 'You share this directory with the other agents, so stay within your assigned task and files to avoid overwriting their work.',
  );
  // Self-verification replaces the old separate verifier agent: each agent owns
  // the correctness of its own slice.
  parts.push(
    'If your task involves writing or changing code, also write and run appropriate tests (or otherwise verify your work) and make sure it meets the acceptance criteria before you finish. Do not report done until you have verified it.',
  );
  return parts.join(' ');
}

/**
 * Orchestrates a persisted swarm over a `SwarmWriter` (the SessionManager). Owns
 * the swarmId-addressed group actions; ad-hoc multi-select broadcast uses the
 * `broadcastTo` helper directly. Fan-out's pane spawning lives in the App (it
 * touches layout) — each agent launched via `buildClaudeLaunch` in its worktree.
 */
export class SwarmOrchestrator {
  constructor(
    private readonly writer: SwarmWriter,
    private readonly lookup: (swarmId: string) => SwarmDef | undefined,
  ) {}

  /** Send one prompt to all (or `only`) members of a swarm (US-10.1). */
  broadcast(
    swarmId: string,
    text: string,
    opts: { submit: boolean; only?: string[] },
  ): void {
    const def = this.lookup(swarmId);
    if (!def) return;
    broadcastTo(
      this.writer,
      broadcastTargets(def.members, opts.only),
      text,
      opts.submit,
    );
  }

  /** Interrupt every member (Ctrl-C). Leaves no orphan — just stops turns. */
  stopAll(swarmId: string): void {
    const def = this.lookup(swarmId);
    if (!def) return;
    for (const m of def.members) this.writer.write(m.sessionId, SWARM_INTERRUPT);
  }
}
