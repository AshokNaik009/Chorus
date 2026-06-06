# Chorus Multi-Agent ("BridgeSwarm") — Slice-by-Slice Implementation Plan

**Purpose:** This document is self-contained. A fresh Claude Code session should be able to read
*this file + the repo* and implement one slice correctly, with no memory of prior chat. Do the
slices **in order**, one per session. **No automated tests** — each slice has a **manual
verification** recipe the human runs.

Companion doc: `BRIDGESPACE_FEATURE_SPEC.md` (the "why"). This file is the "how".

---

## 0. Why we're doing this (read first)

Earlier attempt seeded agents by **typing the prompt into the Claude Code TUI** + a markdown
blackboard. It was fragile: the workspace **trust dialog** ate the typed seed, multi-line text
submitted early, a 1.8s timer raced readiness, and we needed `--dangerously-skip-permissions`
which itself pops a warning. The mature reference tool **ComposioHQ/agent-orchestrator** (MIT,
cloned at `/Users/ashoknaik/claude-experiments/agent-orchestrator`) does NOT type into the TUI and
does NOT use MCP. It:

1. **Launches the prompt as a CLI arg:** `claude … --append-system-prompt … -- 'the task'`.
   The positional `-- 'prompt'` auto-submits as the first user turn and stays interactive
   (`-p`/`--print` is what makes it headless — we do NOT use that).
2. **Isolates each agent in its own git worktree + branch**, then review/merge. No real-time
   coordination, no blackboard, no locks.

**Target for Chorus:** worktree-per-agent + CLI-arg launch. This DELETES the fragile seed-typing,
the readiness timer, the verifier-gating-by-typing, and the blackboard seeding.

Reference source (read these in the cloned repo for exact patterns):
- `packages/plugins/agent-claude-code/src/index.ts:1052-1112` — `getLaunchCommand` + `getEnvironment`.
- `packages/plugins/agent-claude-code/src/index.test.ts` — the launch-command cases (good reference).
- `ARCHITECTURE.md` — worktree/runtime layout.

---

## 1. Repo map (Chorus current state — verify before editing)

Monorepo: npm workspaces + Turborepo. Seam: `@app/core` (zero-dep pure) → `@app/ui` (React/xterm)
→ hosts (`app-web` ws+node-pty, `app-electron` IPC+node-pty). Build: `npm run typecheck`,
`npm run build`, `npm run dev -w app-electron`.

Key files & current behavior:
- `packages/core/src/launch.ts` — `shellLaunchArgs(command, isWindows)` returns the shell argv
  (`['-l','-i','-c', command]` on unix); `withClaudeHooks(command, settingsPath)` injects
  `--settings '<path>'` right after `claude`. Exported via `index.ts` (`export * from './launch.js'`).
- `packages/core/src/pty.ts` — `SpawnOptions { sessionId, cwd, cols, rows, shell?, command?, env? }`.
- `packages/core/src/session-manager.ts` — `spawn(cfg, dims, extras)` where extras carries
  `command`. Status is hook-driven (`status.ts` + Claude Stop/Notification hooks). Do NOT add
  TUI-output scraping.
- `packages/core/src/swarm.ts` — current swarm logic: `buildSeedPrompt`, `buildVerifierPrompt`,
  `planFanOut` (returns `{sessionId, seed, gated}[]`), `workersReleaseVerifier`, `isReadyToSubmit`,
  `buildBlackboardDoc`, `broadcastTo`, `SwarmOrchestrator`, `createSwarmId`, `SWARM_INTERRUPT`.
- `packages/core/src/models.ts` — `SwarmMember { sessionId, role?, task?, seedPrompt?, gated? }`,
  `SwarmDef { swarmId, workspaceId, name, task?, sharedDir?, members[] }`.
- `packages/ui/src/App.tsx` — `startSession` (~line 278), `fanOut` (~582), the verifier-gate
  `useEffect` (~728), refs `pendingFanOut/seededIds/workerHasRun`, const `SEED_DELAY_MS=1800`,
  `statusById`/`statusOf`. Currently fan-out spawns `command:'claude --dangerously-skip-permissions'`
  and **types** seeds via a `setTimeout`. **NOTE:** there are leftover `console.log('[chorus:*]')`
  debug lines in `App.tsx` and `swarm.ts` — remove them in the final slice.
- `packages/ui/src/SwarmPanel.tsx` — fan-out form. State: `foDir` (required directory, gates the
  form), `foName`, `foTask`, `foWorkers: {role,task}[]`, `foVerifier`, `foVerifierTask`,
  `foAutoStart`. Calls `onFanOut(name, task, workers, verifier|null, autoStart, dir)`. Broadcast
  box is wrapped in `{false && (…)}` (disabled).
- `packages/app-electron/src/main/pty-host.ts` — `PtyHost.spawn(opts)`: computes
  `cwd = resolveCwd(opts.cwd)`, `command = withClaudeHooks(opts.command, hooksFile)`,
  `args = shellLaunchArgs(command, isWindows)`, `pty.spawn(shell, args, { cwd, env })`.
- `packages/app-electron/src/main/index.ts` — IPC handlers incl. `createBlackboard`; `resolveBase`.
- `packages/app-electron/src/shared/ipc.ts` — IPC channel name constants.
- `packages/app-electron/src/preload/index.ts` — exposes host APIs to renderer.
- `packages/app-electron/src/renderer/src/electron-swarm-workspace.ts` — `SwarmWorkspace` impl
  (the injected host capability; web omits it → feature degrades). App prop: `swarmWorkspace`.

Permissions note: swarm panes use `--dangerously-skip-permissions` (user already approved this for
swarm only — it skips the trust dialog AND tool prompts so agents run hands-off). Normal panes stay
default (guardrails on).

---

## SLICE 1 — `buildClaudeLaunch()` in core + rewire launches

**Goal:** one pure function builds the claude command; use it everywhere; pass prompts as CLI args.
Deletes the seed-typing path. Standalone value even if swarm is dropped.

### 1a. Add to `packages/core/src/launch.ts`

```ts
/** Claude permission posture. 'default' keeps approval prompts; the others skip them. */
export type AgentPermissionMode = 'default' | 'permissionless' | 'auto-edit';

export interface ClaudeLaunchConfig {
  /** Positional first-turn prompt. Auto-submits, stays interactive. Omit for a blank session. */
  prompt?: string;
  /** Appended to the system prompt (role/context framing). */
  systemPrompt?: string;
  /** e.g. 'opus'. */
  model?: string;
  /** Default 'default'. 'permissionless'|'auto-edit' add --dangerously-skip-permissions. */
  permissionMode?: AgentPermissionMode;
  /** Optional --resume <uuid>. */
  resumeSessionId?: string;
}

/** POSIX single-quote escaping (wrap in '...', escape embedded quotes). */
export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the `claude …` command string. The prompt is passed as a positional arg after `--`
 * (auto-submits as the first user turn, stays interactive — NOT -p/--print). The host's
 * withClaudeHooks() still injects `--settings` after `claude`. Mirrors agent-orchestrator's
 * getLaunchCommand (MIT).
 */
export function buildClaudeLaunch(config: ClaudeLaunchConfig = {}): string {
  const parts: string[] = ['claude'];
  const mode = config.permissionMode ?? 'default';
  if (mode === 'permissionless' || mode === 'auto-edit') {
    parts.push('--dangerously-skip-permissions');
  }
  if (config.model) parts.push('--model', shellEscape(config.model));
  if (config.resumeSessionId) parts.push('--resume', shellEscape(config.resumeSessionId));
  if (config.systemPrompt) parts.push('--append-system-prompt', shellEscape(config.systemPrompt));
  if (config.prompt) parts.push('--', shellEscape(config.prompt));
  return parts.join(' ');
}
```

Notes:
- It must remain valid after `withClaudeHooks` rewrites `^claude` → `claude --settings '<path>'`
  (flags land before `--`, the positional stays after — fine).
- Keep prompts single-line for safety (the existing `oneLine` collapse in fan-out is fine to keep),
  though arg-passing tolerates newlines.

### 1b. Rewire callers in `packages/ui/src/App.tsx`
- Import `buildClaudeLaunch` from `@app/core`.
- **Normal claude pane** (`startSession`): where it spawns with `command: 'claude'`, use
  `command: buildClaudeLaunch()` (no prompt → blank interactive session). Behavior unchanged.
- **Fan-out workers**: build the command per worker as
  `buildClaudeLaunch({ prompt: workerTask, systemPrompt: roleFraming, permissionMode: autoStart ? 'permissionless' : 'default' })`
  and pass it as the spawn `command`. `roleFraming` = a short string like
  `You are the "<role>" agent in the Chorus swarm "<name>". Shared context: <task>. Work only on your task.`
  (you can repurpose the existing `buildSeedPrompt` text as the systemPrompt, but the **task goes in
  `prompt`**, not typed).
- **DELETE** the seed-typing mechanism: the `window.setTimeout(… SEED_DELAY_MS …)` block that calls
  `manager.write(sessionId, seed + '\r')`, plus `SEED_DELAY_MS`. (The verifier gate is handled in
  Slice 3; for Slice 1 you may temporarily leave the verifier spawning like a worker — full verifier
  rework is Slice 3.)

### 1c. (Optional, recommended) unset CLAUDECODE
If easy via the existing `env` plumbing (`SpawnOptions.env`), pass `env: { CLAUDECODE: '' }` for
claude spawns to avoid nested-agent conflicts (Chorus may itself be launched from Claude). If the
`env` path isn't already wired from `session-manager.spawn` extras → backend, **skip** (don't
over-engineer; note it as a follow-up).

### Definition of done (Slice 1)
- `npm run typecheck` and `npm run build` green.
- Normal "Run Claude" pane still opens an interactive blank session.
- Fan out **one** worker with a task in any directory.

### Manual verification (Slice 1)
1. `npm run dev -w app-electron` (full restart — main process unchanged here, but be safe).
2. Open a normal Claude pane → interactive, no prompt pre-filled. Works as before.
3. Fan out 1 worker, task = "print hello world in python". Expected: the pane launches and the task
   **runs on its own** — no trust dialog, no manual Enter, no 1.8s delay, no half-typed text.
4. If the prompt does NOT auto-run: check `withClaudeHooks` didn't mangle the `--` ordering, and
   that `--dangerously-skip-permissions` is present (permissionless) so no trust dialog blocks it.

---

## SLICE 2 — git worktree host capability (Electron)

**Goal:** create an isolated git worktree+branch per agent. Pure planning in core; the actual
`git` call in the Electron host. Web host degrades (no worktrees → agents share the dir).

### 2a. Pure helper in `packages/core/src/swarm.ts` (or a new `worktree.ts`)
```ts
export interface AgentWorktreePlan { role: string; branch: string; worktreeSubdir: string; }
/** Deterministic branch + subdir names for a swarm's agents. Pure. */
export function planAgentWorktrees(swarmName: string, roles: string[]): AgentWorktreePlan[] { … }
```
- Slugify `swarmName` + role → branch `chorus/<swarm-slug>/<role-slug>`, subdir `<swarm-slug>/<role-slug>`.
- Handle duplicate/empty roles (suffix index).

### 2b. Host capability (extend the injected seam)
Add a method to the host capability the renderer already injects (the `SwarmWorkspace` seam, or a
new `WorktreeHost` interface in core):
```ts
createWorktree(repoDir: string, worktreeDir: string, branch: string): Promise<string | null>;
removeWorktree(repoDir: string, worktreeDir: string): Promise<void>;
isGitRepo(dir: string): Promise<boolean>;
```
- **Electron** (`app-electron/src/main/index.ts` + a small git helper): implement via `git`:
  - `isGitRepo`: `git -C <dir> rev-parse --is-inside-work-tree`.
  - `createWorktree`: base worktrees under **`~/.chorus/worktrees/<swarmId>/<role>`** (NOT inside the
    repo, to avoid nested-worktree mess). `git -C <repoDir> worktree add -b <branch> <worktreeDir>`
    (off current HEAD). Return absolute worktree path, or null on failure.
  - `removeWorktree`: `git -C <repoDir> worktree remove --force <worktreeDir>` (best-effort).
  - Wire via new `IPC.*` channels in `shared/ipc.ts` + handlers in `main/index.ts` + `preload/index.ts`
    + the renderer impl (mirror how `createBlackboard` is wired today).
- **Web** (`app-web`): omit → capability `available=false`.

### Definition of done (Slice 2)
- Typecheck + build green. A debug path (or Slice 3) can call `createWorktree` and the worktree +
  branch appear.

### Manual verification (Slice 2)
- In a throwaway git repo, trigger `createWorktree` (via Slice 3, or a temporary dev button).
  Run `git worktree list` and `git branch` in that repo → new worktree dir + `chorus/...` branch
  exist. `removeWorktree` cleans it up.

---

## SLICE 3 — rewire fan-out to worktrees + defer the verifier

**Goal:** each worker runs in its own worktree/branch, launched via `buildClaudeLaunch` with its task
as the prompt arg. Verifier defer-spawns once workers finish. Remove blackboard + gating-by-typing.

### 3a. `fanOut` in `App.tsx`
For the chosen `dir` (required; must be a git repo — if `isGitRepo(dir)` is false, either show an
error in `SwarmPanel` or fall back to all-agents-share-`dir` with a note):
1. `const plan = planAgentWorktrees(name, workerRoles)`.
2. For each worker: `worktreeDir = await host.createWorktree(dir, <base>/<subdir>, plan.branch)`
   (fallback to `dir` if host unavailable / not a git repo).
3. Spawn the worker pane with `cwd = worktreeDir` and
   `command = buildClaudeLaunch({ prompt: workerTask, systemPrompt: roleFraming, permissionMode: 'permissionless' })`.
   No typing, no timer.
4. **Verifier (deferred):** do NOT spawn it up front. Keep a small status effect (reuse
   `workersReleaseVerifier`): when every worker has run and gone idle (hook status), **spawn** the
   verifier pane then, in `dir` (the main worktree / integration point), with
   `buildClaudeLaunch({ prompt: verifierTask, permissionMode: 'permissionless' })`. The verifier task
   should reference reviewing the worker branches (list them in the prompt). The verifier pane can
   show a "queued" placeholder until released.

### 3b. Delete now-dead code
- `buildBlackboardDoc` usage + blackboard seeding in `fanOut` (worktrees replace coordination).
- `buildSeedPrompt`/`buildVerifierPrompt`/`planFanOut` **seed-typing** usage, the `SEED_DELAY_MS`
  timer, and the `manager.write(seed+'\r')` writes. (Repurpose the role-framing text as
  `systemPrompt` if useful, otherwise inline a small template.)
- The verifier-gating-by-typing branch in the existing effect → becomes verifier defer-spawn.
- `seededIds`/`workerHasRun`/`pendingFanOut` refs: keep only what the defer-spawn gate needs
  (worker ids + hasRun + a "verifier spawned" flag).
- Teardown: when the swarm/workspace is reset or fanned-out again, call `removeWorktree` for each
  agent (best-effort) so worktrees don't accumulate.

### Definition of done (Slice 3)
- Typecheck + build green. Fan out in a real git repo → workers on their own branches, verifier
  runs after.

### Manual verification (Slice 3)
1. `npm run dev -w app-electron`. Use a real git repo as the directory.
2. Fan out 2 workers (e.g. "add a function foo() to utils", "add a function bar()") + verifier ON.
3. Expect: 2 panes, each in its own worktree, each task auto-runs hands-off. `git worktree list`
   shows 2 worktrees; `git branch` shows 2 `chorus/...` branches.
4. When both workers go idle, the verifier pane spawns and runs its review prompt.
5. Reset/close → `git worktree list` shows the worktrees removed.

---

## FINAL SLICE — cleanup
- Remove all `console.log('[chorus:*]')` debug lines in `App.tsx` and `swarm.ts`.
- Delete any orphaned exports from `swarm.ts` no longer used (e.g. `buildBlackboardDoc`,
  `isReadyToSubmit` if unused after the rework) — check references first.
- `npm run typecheck` + `npm run build` green. Update `BRIDGESPACE_FEATURE_SPEC.md` status if needed.

---

## Guardrails for the implementing session
- **Stay in the seam:** pure logic in `@app/core`; git/fs only in the Electron host; UI in `@app/ui`.
- **Do not** add: MCP servers, dashboards, GraphQL, tmux/Docker runtimes, trackers, a lifecycle
  state machine, or automated tests. The human tests manually.
- **Do not** reintroduce typing-into-the-TUI. Prompts are CLI args.
- Worktrees require the directory to be a git repo — handle the non-repo case explicitly.
- Keep changes minimal and reversible; one slice per session; verify in the running app before moving on.
```
