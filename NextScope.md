# Next Scope — What Chorus Can Borrow From AGNT

> Source studied: `/Users/ashoknaik/claude-experiments/agnt` (AGNT v0.5.17, MIT-ish
> custom license — check `LICENSE.md` before copying code verbatim). AGNT is a
> "local-first agent operating system": Electron + Express(`:3333`) + SQLite, Vue
> frontend, 60+ workflow nodes, goals, subagent orchestration, memory/insights,
> SkillForge, a `.agnt` plugin marketplace, and MCP.
>
> Chorus is a *lean* parallel-Claude-Code terminal manager. It is deliberately NOT
> an agent framework — it is orchestration glue over real Claude Code TUIs in
> terminals, with git-worktree isolation and a review/merge loop. The product
> decision (see `multi-agent-direction` memory) is explicitly: **stay lean, reject
> framework bulk, no MCP coordination server, no TUI scraping.**
>
> So this doc is a *filter*, not a wish list. For each AGNT subsystem: what it is,
> where its logic lives, whether it fits Chorus, and the concrete Chorus touchpoint
> if we adopt it. Verdicts: **ADOPT** (high fit, lean), **ADAPT** (good idea, must
> be slimmed), **REJECT (by design)** (conflicts with the lean charter).

---

## TL;DR — ranked shortlist

| # | Capability | AGNT source of logic | Verdict | Effort |
|---|-----------|----------------------|---------|--------|
| 1 | **Goal → plan → agent tasks** (auto-decompose an objective into roles/tasks) | `services/GoalService.js`, `services/goal/` | **ADAPT** | M |
| 2 | **Run history + per-agent trace + cost** | `models/ExecutionModel.js`, `AgentExecutionModel.js`, `RunService.js` | **ADOPT** | M |
| 3 | **Promote a successful run → reusable swarm recipe** (SkillForge idea) | `services/SkillService.js`, `services/evolution/`, SkillForge | **ADOPT** | S–M |
| 4 | **Searchable cross-run memory / insights** (FTS recall) | `services/MemorySearchService.js`, `models/database/fts.js` | **ADAPT** | M |
| 5 | **Mid-run steering** (nudge an agent without aborting its turn) | `services/OrchestratorService.js` (`/steer` pattern) | **ADAPT** | S |
| 6 | **Dependency-ordered swarm (DAG, not flat fan-out)** | `workflow/WorkflowEngine.js`, `EdgeEvaluator.js`, `ParameterResolver.js` | **ADAPT** | L |
| 7 | **Design-system pass** (dark cockpit visual language) | `DESIGN.md` | **ADOPT** | S |
| 8 | **Local control API** (script Chorus from outside) | `routes/*`, `server.js` | **ADAPT** | M |
| 9 | Plugins / `.agnt` marketplace / tool registry | `plugins/`, `tools/ToolRegistry.js` | **REJECT (by design)** | — |
| 10 | MCP coordination server | `services/MCPService.js` | **REJECT (by design)** | — |

Recommended next-milestone bundle: **#2 + #3 + #5** (run history, recipe promotion,
steering). They are small, reinforce what Chorus already does well (saved swarms,
review/merge), and need no new heavy infrastructure. #1 and #4 are the milestone
after. #6 is the big-bet "v3" item.

---

## 1. Goal decomposition — objective → agent roles/tasks  ·  **ADAPT**

**What AGNT does.** A Goal is a high-level objective AGNT plans into steps, executes,
evaluates, and *re-plans* on failure (plan → execute → evaluate → re-plan → pause/
resume/revert). Logic in `backend/src/services/GoalService.js` + `services/goal/`,
models `GoalModel`, `GoalIterationModel`, `GoalEvaluationModel`.

**Why it fits Chorus.** Today the user hand-authors every agent's role + task in the
fan-out form (`SwarmPanel.tsx`, `App.tsx fanOut`). The natural next step: type one
objective → a planner LLM call proposes N roles + per-agent tasks (+ suggested
directories) → user edits → fan out. This is the single highest-leverage UX upgrade
and maps cleanly onto the existing form.

**What to take, what to drop.** Take the *decompose* call and its prompt shape. Drop
AGNT's full goal lifecycle (iterations table, revert, autonomous re-planning) — that
is framework territory. Keep it one-shot and user-in-the-loop: planner proposes, user
approves, Chorus fans out exactly as it does now.

**Chorus touchpoints.** New `planSwarm(objective, n, repoDirs)` in `packages/core/src/swarm.ts`
(pure prompt builder + a typed result the UI renders into the existing role rows);
called from `SwarmPanel.tsx`. The actual LLM call needs an API key path Chorus does
not yet have — see #8 (or run it as a throwaway `claude -p` headless call from the host).

---

## 2. Run history + per-agent trace + cost  ·  **ADOPT**

**What AGNT does.** Every run is persisted: `ExecutionModel` (workflow runs),
`AgentExecutionModel` (per-agent), with status, timing, outputs, token cost
(`getModelCost` in `services/ai/providerConfigs.js`). `RunService.js` serves run
history; the UI shows inspectable traces.

**Why it fits Chorus.** Chorus has live `SessionStatus` badges but nothing durable —
once a swarm ends you cannot see *what happened*. A lightweight **swarm run log**
("Swarm X, 4 agents, started 14:02, 3 merged / 1 discarded, files touched, branches")
closes the same loop the review/merge view opened. It also pairs with #3 (you can only
promote a run to a recipe if you recorded it).

**What to take, what to drop.** Take the record shape (run → members → outcome →
artifacts) and a simple JSON-on-disk store (Chorus is SQLite-free by charter — keep it
that way; persist next to `workspace-state.v2.json`). Drop token-cost accounting at
first (Claude Code TUI does not surface per-turn tokens to the harness; status is
hook-driven, not stream-parsed — do NOT add TUI scraping to get cost).

**Chorus touchpoints.** New `SwarmRun` model in `models.ts`; append on fan-out / on
End-swarm; a "History" drawer mirroring `DiffReview.tsx`. Host persistence via the
existing `Persistence` seam (Electron file + web localStorage).

---

## 3. Promote a successful run → reusable swarm recipe (SkillForge idea)  ·  **ADOPT**

**What AGNT does.** SkillForge turns execution *traces* into better reusable *skills*
(`services/SkillService.js`, `services/evolution/`, `SkillModel`/`SkillVersionModel`,
`GoldenStandardModel`). The core idea: a run that worked is a reusable artifact.

**Why it fits Chorus.** Chorus already has "saved swarms" (roles only). The upgrade:
after a swarm finishes and merges cleanly, offer **"Save as recipe"** — capture the
roles, the per-agent system-prompt framing, the directory layout, and the objective
that produced a good result, as a re-runnable template. This is SkillForge minus the
self-improvement/eval machinery: a one-click "this worked, do it again."

**What to take, what to drop.** Take the trace→template distillation concept and the
versioning notion (recipe v2 supersedes v1). Drop the eval-dataset / golden-standard /
auto-evolution loop (`EvalDatasetService`, `GoldenStandardModel`) — that is a research
feature, not lean orchestration.

**Chorus touchpoints.** Extend the saved-swarm shape in `SwarmDef`/`models.ts` to carry
prompts + dir plan; a "Save as recipe" button in `DiffReview.tsx` (it already knows the
merge outcome). Builds directly on #2.

---

## 4. Searchable cross-run memory / insights  ·  **ADAPT**

**What AGNT does.** `MemorySearchService.js` = hybrid FTS5 search across conversations,
executions, outputs, **insights** (facts / preferences / corrections / bottlenecks /
tool-choice patterns), and workflow versions. Powers `recall` / `list_recent` /
`get_trace` tools. `models/database/fts.js` builds the FTS index.

**Why it fits Chorus.** Chorus already does memory *portability* (export/import bundle,
see `bundle.ts` + `MemoryControls.tsx`) but has no *searchable* memory. A modest
"recall" over the run history from #2 ("show me past swarms that touched `auth.ts`",
"what roles did I use for the migration swarm?") would be genuinely useful as the run
log grows.

**What to take, what to drop.** Take the FTS query sanitization + ranking approach
(`sanitizeFtsQuery`, prefix-AND tokens). Drop SQLite/FTS5 itself unless Chorus is ready
to add a DB — at small scale an in-memory substring/scored search over the JSON run log
is enough. The *insights extraction* (LLM distills "lessons" from a run) is the more
novel half and pairs with #3; treat it as optional v2 of this item.

**Chorus touchpoints.** A search box over the #2 history store; pure ranking fn in core
with unit tests (matches Chorus's "logic in core, host-agnostic" pattern).

---

## 5. Mid-run steering — nudge an agent without aborting  ·  **ADAPT**

**What AGNT does.** While a turn is streaming, AGNT lets the user inject a steer that is
drained between tool rounds and appended to the last tool-result (`OrchestratorService.js`,
the Hermes `/steer` pattern — see the `CANCELLED_TOOL_RESULT` / steer comments at the top
of that file). Cache-neutral because tool-result messages already break the prefix cache.

**Why it fits Chorus.** Chorus's `broadcastTo` / `SwarmOrchestrator.broadcast` already
writes to many sessions. But mid-turn, the Claude TUI input is effectively busy. A
"queue a steer for the next turn boundary" affordance — detect the Stop hook (Chorus
already counts `turnsCompleted` via authoritative idle/Stop hooks, see `status.ts`),
then deliver the queued nudge — would let users course-correct a running swarm cleanly
instead of Ctrl-C + re-broadcast.

**What to take, what to drop.** Take the *queue-then-deliver-at-turn-boundary* idea (it
fits Chorus's hook-driven status model perfectly). Drop the stream/tool-result plumbing
— Chorus has no LLM stream; it has terminal writes + Stop hooks. Delivery = write the
queued text on the next `idle`/Stop transition.

**Chorus touchpoints.** `SwarmOrchestrator` gains a per-session steer queue; the gate
logic that already keys off `turnsCompleted` (the verifier-gate machinery, now removed,
proved this hook timing works) is the model. Small, self-contained.

---

## 6. Dependency-ordered swarm (DAG instead of flat fan-out)  ·  **ADAPT** (big bet)

**What AGNT does.** `workflow/WorkflowEngine.js` runs a node graph with edges,
conditional branches, iteration caps, checkpoints, and nested sub-workflows.
`EdgeEvaluator.js` decides which edges fire; `ParameterResolver.js` passes outputs from
one node into the next.

**Why it (partly) fits Chorus.** Today fan-out is flat and parallel — every agent starts
at once. Some real work is ordered: "scaffold the schema, *then* the backend agent, *then*
the tests agent." A minimal DAG (each agent declares `dependsOn: [roles]`; an agent
launches only when its deps reach `idle`/Stop with a clean merge) would unlock staged
swarms without a visual canvas.

**What to take, what to drop.** Take ONLY the dependency-gating concept and reuse the
hook-driven `turnsCompleted`/Stop signal Chorus already trusts as the "node done" event.
**Reject** the full WorkflowEngine: visual canvas, 60+ node types, ParameterResolver,
triggers, iteration counters — that is the framework Chorus deliberately is not. Keep it
as "ordered fan-out," not "workflow builder."

**Chorus touchpoints.** `SwarmMember.dependsOn?: string[]` in `models.ts`; `fanOut` in
`App.tsx` becomes staged (defer-spawn pattern — exactly the mechanism the old verifier
gate used and proved out). This is the largest item; do it last and only if users ask
for ordering.

---

## 7. Design-system pass  ·  **ADOPT** (cheap polish)

**What AGNT has.** `DESIGN.md` — a thorough dark-first "command-center" design language
(near-black navy ramp, pink primary / cyan secondary signal colors, League Spartan +
Fira Code, 2/4/8 spacing, restrained neon, semantic status colors, fast motion). It is
self-contained and directly readable.

**Why it fits Chorus.** Chorus's UI is functional but undesigned. AGNT's tokens map
almost 1:1 onto a terminal-multiplexer product (it literally aims for "living terminal
cockpit"). Adopting the palette + type + spacing tokens into `packages/ui/src/theme.ts`
and `styles.css` is a low-risk, high-visible-quality win, and the status-color semantics
(green=running/healthy, yellow=waiting, red=failed) line up with Chorus's `StatusBadge`.

**Chorus touchpoints.** `packages/ui/src/theme.ts`, the global stylesheet, `StatusBadge.tsx`.
No logic change — pure tokens. Copy the *system*, not AGNT's brand identity.

---

## 8. Local control API  ·  **ADAPT**

**What AGNT does.** Express on `:3333` exposes agents, workflows, goals, tools, files,
plugins, executions (the `routes/` + `server.js` layer) with SSE/Socket.IO realtime.

**Why it (partly) fits Chorus.** Useful as the *enabler* for #1 (somewhere to make a
planner LLM call) and for scripting swarm fan-out from CI or other tools. Chorus's
`app-web` already runs an Express + ws bridge (`packages/app-web/server/index.ts`) — the
seam exists.

**What to take, what to drop.** If/when an LLM call is needed (planner #1, insights #4),
add a *tiny* server-side proxy that holds the key and exposes one or two endpoints — do
NOT port AGNT's 30+ route surface. Multi-provider `ProviderRegistry` is overkill: Chorus
is a Claude Code product; default to Anthropic / a headless `claude -p` call. Keep the
charter — local-first, no SaaS.

**Chorus touchpoints.** Extend `app-web/server/index.ts` and the Electron main host with
one `POST /plan` (and later `/recall`). Guard behind a key the user supplies.

---

## 9 & 10. Plugins / marketplace / MCP coordination  ·  **REJECT (by design)**

AGNT's `.agnt` plugin system (`backend/plugins/`, `PluginManager`, `ToolRegistry`,
25+ templates, marketplace) and its MCP layer (`services/MCPService.js`) are the heart of
AGNT-as-a-framework. They are explicitly *out of scope* for Chorus:

- The `multi-agent-direction` memory records a deliberate decision: **"no MCP
  coordination server — we rejected the MCP path as over-engineering."** Agents
  coordinate via git worktrees + review/merge, not a tool bus.
- Chorus's agents are full Claude Code instances that already have their own tools; a
  Chorus-level tool registry would duplicate that.

Note them here so the decision stays explicit and nobody re-derives it. If a future pivot
ever wants Chorus to *be* a framework, this is where AGNT's architecture would matter —
but that contradicts the current lean charter.

---

## How to use this doc

1. Confirm the **next-milestone bundle (#2 + #3 + #5)** with the product owner — it is
   the lean, high-fit set and all three reinforce the existing review/merge + saved-swarm
   surfaces.
2. Each item lists the **AGNT file to read for the logic** and the **Chorus file to
   change** — read the AGNT source for the *shape of the idea*, then re-implement in
   Chorus's host-agnostic-core style (logic in `packages/core`, hosts inject capability,
   pure functions unit-tested). Do not bulk-copy AGNT code: different stack (Vue/Express/
   SQLite vs React/Electron/JSON), different license, and far heavier than Chorus wants.
3. Keep the charter in front of you: **lean, local-first, real Claude Code TUIs, git
   worktree isolation, hook-driven status, no TUI scraping, no MCP bus.** Every borrow
   above is filtered through it.
