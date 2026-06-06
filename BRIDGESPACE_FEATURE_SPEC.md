# Chorus — Bridgespace Parity Spec & Multi-Agent Redesign

Status: draft for review (2026-06-06). Author: analysis of ComposioHQ/agent-orchestrator (MIT)
+ BridgeMind Bridgespace product research.

This doc has two parts:
- **Part 1 — Multi-agent ("BridgeSwarm") redesign.** The current priority. What we extract
  from `agent-orchestrator`, what we reject, and a test-backed build plan.
- **Part 2 — Bridgespace feature roadmap.** Everything else (Kanban, editor, file browser,
  memory), to pick up *after* Part 1 lands.

---

## Part 0 — The brutal-honesty summary

We spent a day trying to make a "swarm" by **typing prompts into the Claude Code TUI** and
coordinating agents through a **markdown blackboard**. Every bug (trust dialog eating the seed,
multi-line submit, 1.8s timer, `--dangerously-skip-permissions` warning, manual Enter) was a
symptom of that wrong approach.

Two reference points now agree the approach was wrong, and they agree on the fix:

1. **Bridgespace (the product we clone)** coordinates via MCP + a knowledge graph, *not* by
   puppeteering terminals.
2. **ComposioHQ/agent-orchestrator** (a mature, 3,288-test parallel-agent orchestrator) does
   **not** type into the TUI and does **not** use MCP coordination either. It:
   - **launches the prompt as a CLI argument** (`claude … -- 'prompt'`), and
   - **isolates each agent in its own git worktree + branch**, reviewing/merging after.

**Verdict:** the right "swarm" for Chorus is *not* an MCP mailbox and *not* TUI puppeteering. It
is **worktree-isolation + clean CLI-arg launch**. This is *simpler* than both what we built
yesterday and the MCP path we briefly chose. It also throws away the most fragile code we wrote
(auto-submit timer, verifier-gating, blackboard).

We should **walk back the "do it the MCP way" decision.** Evidence from every mature tool
(agent-orchestrator, Conductor, Crystal) points to isolation, not chat-coordination, for
parallel coding agents. MCP coordination is a heavier, different philosophy and would be
over-engineering for Chorus.

---

## Part 1 — Multi-agent redesign (priority)

### 1.1 What to EXTRACT from agent-orchestrator (small, portable, verifiable)

**A. The Claude launch-command builder — highest value, do this first.**
Source: `packages/plugins/agent-claude-code/src/index.ts:1052-1090`.

```
claude [--dangerously-skip-permissions] [--model X] \
       [--append-system-prompt "$(cat <file>)"] -- '<prompt>'
```

- `-- '<prompt>'` → the task is a **positional arg** that auto-submits as the first user turn
  and *stays interactive*. No typing, no `\r`, no readiness timer, no trust-dialog race.
- `--append-system-prompt "$(cat <file>)"` → role/system text from a file (avoids shell/tmux
  truncation on long prompts). On Windows, read the file and inline instead (`$()` is bash-only).
- `--dangerously-skip-permissions` only when the user opts into a "permissionless"/"auto-edit"
  mode — otherwise omitted (keep guardrails by default).
- Set env `CLAUDECODE=""` to avoid nested-agent conflicts (Chorus itself may be launched from
  Claude). Source: same file, `getEnvironment()`.

This is ~40 lines of pure logic. **It fixes pane seeding for the entire app, swarm or not** —
the current `manager.write(seed + '\r')` + 1.8s timer should be replaced by it.

**B. git-worktree-per-agent isolation.**
Source: `ARCHITECTURE.md` (worktrees under a runtime dir) + `workspace-worktree` plugin.
Each agent gets `git worktree add <dir> -b <branch>` off the base branch, runs in that dir, and
produces an independent branch to review/merge. Parallel agents never touch the same files, so
**no blackboard, no locks, no real-time coordination needed.**

**C. Activity detection via Claude hooks, not terminal regex.**
Source: `agent-claude-code/src/index.ts:1114-1131` + `activity-detection.ts`. They *retired*
terminal-output parsing ("structurally fragile; every Claude UI tweak regressed it") in favour
of Claude's `Stop`/`Notification`/`PermissionRequest` hooks writing to a JSONL file. **Chorus
already does this** (`status.ts` + `buildClaudeHookSettings` in `pty-host.ts`) — keep it; do not
add TUI scraping.

### 1.2 What to REJECT (overhead — would repeat the over-engineering mistake)

- The entire AO product surface: **Next.js dashboard, GraphQL, Docker/tmux runtime abstraction,
  Linear/GitHub trackers, CI-fix loops, notifier plugins, the 524-line lifecycle state machine,
  the 3,673-line session-manager, hash-based multi-instance namespacing.** None fits Chorus's
  lean Electron + xterm model.
- **MCP coordination server** (agent-collab-mcp / mcp_agent_mail / a BridgeMCP clone). Different,
  heavier philosophy; not needed once agents are worktree-isolated.
- **From our own yesterday's code:** the auto-submit timer, the verifier-gating effect, the
  `CHORUS_SWARM.md` blackboard seeding. The worktree model makes the gate unnecessary; a
  verifier, if wanted, becomes "open a review pane on the merged branch," not a gated TUI.

### 1.3 Target design for Chorus fan-out (v2)

1. User picks: a **base directory (git repo)**, a goal, and N agents each with a task (existing
   UI, already built — keep the required-directory gating).
2. For each agent: create `git worktree add <runtimeDir>/<swarm>/<role> -b chorus/<swarm>/<role>`
   off the repo's current branch.
3. Spawn a pane running the **launch command** (1.1.A) in that worktree, with the role as
   `--append-system-prompt` and the task as the `-- 'prompt'` positional. It auto-runs. Done.
4. Status comes from Claude hooks (already wired). When agents finish, the user reviews each
   branch and merges (Part 2 can add a diff/merge view). Optional reviewer = a pane opened on the
   integration branch with a review prompt — no gating machinery.

This removes: trust-dialog hacks, the seed-typing timer, multi-line handling, verifier-gating.

### 1.4 Build slices (each independently verifiable)

- **Slice 1 (do first, standalone value): `buildClaudeLaunch()` in `@app/core`.**
  Pure function porting AO's `getLaunchCommand`. Inputs: `{ prompt?, systemPromptFile?,
  systemPrompt?, model?, permissionMode }`. Output: argv/command string. Reuse the existing
  `shellLaunchArgs`/`withClaudeHooks` seam. **Tests:** mirror AO's `index.test.ts` cases
  (positional after `--`, append-system-prompt file vs inline, skip-permissions on/off, shell
  escaping). Rewire normal pane launch + fan-out to use it; delete the seed-typing path.
  *Manual check:* open a pane, confirm the prompt auto-runs with no trust dialog / no manual Enter.

- **Slice 2: worktree host helper (Electron main).** `createAgentWorktree(repoDir, branch)` →
  `git worktree add`. **Tests:** run against a temp git repo (init, commit, add worktree, assert
  dir + branch exist, cleanup). Web host degrades (no worktrees → falls back to shared dir or
  hides).

- **Slice 3: rewire fan-out** to Slice 1 + Slice 2; remove blackboard/verifier-gating/timer.
  **Tests:** core unit tests for the per-agent plan (worktree path + launch command per role).
  *Manual check:* fan out 2 agents in a real repo; each lands on its own branch and runs its task
  hands-off.

- **Slice 4 (optional, later): review/merge view** — list agent branches, show diff, merge.

### 1.5 Honest "is it worth it?" gate

- **Slice 1 is worth it unconditionally** — it fixes seeding for the whole app and deletes
  fragile code. Low risk, fully testable.
- **Slices 2–3 (worktree swarm) are worth it IF** you want parallel agents as a real feature.
  They are far smaller than yesterday's attempt and don't fight the TUI. If after Slice 1 the
  appetite for multi-agent has cooled, **stop after Slice 1** and treat fan-out as "open N panes,
  each launched cleanly" — still useful, no over-engineering.
- **Anything beyond Slice 4 (dashboards, trackers, MCP, lifecycle automation) is out of scope**
  for Chorus and should not be pursued.

---

## Part 2 — Bridgespace feature roadmap (after Part 1)

Bridgespace = terminals + editor + file browser + Kanban + agent orchestration + memory, in one
desktop app. Chorus today has: multi-pane terminal grid, workspaces/sessions, layouts, voice,
export/import, (broken) swarm. Parity gaps, with honest fit/effort:

| Feature | What Bridgespace does | Chorus today | Fit / effort | Verdict |
|---|---|---|---|---|
| **Command blocks** | Each command captured as a scrollable block (Warp-style) | Raw xterm stream | Medium — needs shell integration / OSC parsing | Nice DX, defer |
| **Integrated editor** | Syntax-highlit code editor pane | None | High — embed Monaco/CodeMirror | Big; only if it earns its keep |
| **File browser** | Sidebar file tree of the project | None | Low–medium | Good, cheap-ish win |
| **Kanban task board** | Tasks → launch agents from the board, columns Todo/In-Progress/Review/Done | None | Medium | The "command center" hook; pairs with Part 1 worktrees |
| **Memory / knowledge graph** | `.bridgememory/`, `[[wikilinks]]`, graph view, MCP tools | Chorus has its own auto-memory (`MEMORY.md`) | Medium–high | Partial overlap; reuse our memory, skip the graph UI initially |
| **MCP shared context** | BridgeMCP server agents connect to | None (and Part 1 argues against it) | High | Skip unless a concrete need appears |
| **Voice** | Voice input | Already have (`@app/voice`) | — | Done |

**Recommended order after Part 1:** File browser (cheap) → Kanban board (ties tasks to the
worktree fan-out) → command blocks → editor. Treat memory-graph and MCP as "only if a real user
need shows up," not parity-for-parity's-sake.

---

## Appendix — provenance

- `agent-orchestrator` (MIT): `ARCHITECTURE.md`, `packages/plugins/agent-claude-code/src/index.ts`
  (`getLaunchCommand`, `getEnvironment`), `packages/core/src/session-manager.ts:1785-1794`
  (file-based prompt to avoid truncation), `prompt-builder.ts` (layered system prompt),
  `file-lock.ts`.
- Bridgespace: bridgemind.ai/products/bridgespace, /bridgeswarm, /bridgemcp.
- MIT license permits porting small logic with attribution.
