# Claude Code memory capabilities — verification spikes (PRD Epic 11 / M12)

Layer-2 conversation import/export relies on a few facts about how Claude Code
persists sessions on disk. This file records the assumptions Chorus codes against
and the spikes that must confirm them **on a real machine** (this build was
developed headless, so the items below are coded to the documented behavior and
flagged where runtime confirmation is still required).

Where a spike comes back negative, the matching Layer-2 behavior degrades: Chorus
still exports the transcript as a readable `.chorus` artifact even if automated
resume cannot be wired.

## Facts assumed

- Conversations persist locally as per-session **JSONL transcripts** under
  `~/.claude/projects/<slug>/<sessionId>.jsonl`.
- `<slug>` is the **slugified absolute project path**: every non-alphanumeric
  character replaced with `-`. Implemented as `claudeProjectSlug()` in
  `@app/core` and unit-tested. Confirmed shape from a real install:
  `/Users/ashoknaik/claude-experiments/tui-bridgespaceclone` →
  `-Users-ashoknaik-claude-experiments-tui-bridgespaceclone`.
- A global index lives at `~/.claude/history.jsonl`; per-project
  `sessions-index.json` holds summaries; `~/.claude/projects/<slug>/memory/` (and
  the project `CLAUDE.md`) hold persistent memory.
- A session resumes with `claude --resume <sessionId>`. Resuming restores the
  **conversation + tool results** (full context) but **not the filesystem** — prior
  edits are remembered, not replayed. Chorus's import UX states this explicitly.

## VS-11.A — Session-id capture  (status: coded, NEEDS on-machine confirmation)

Goal: obtain the Claude session id for a pane Chorus launched.

Approach implemented: after a claude pane spawns, `SessionArchive.captureSessionId`
reads `~/.claude/history.jsonl` and returns the most recent entry whose project
path matches the pane's cwd. Best-effort and never blocks launch (US-11.3); stored
on `SessionConfig.claudeSessionId`.

To verify: launch a pane, send one prompt, then check that the captured id matches
the newest file in `~/.claude/projects/<slug>/`. If history matching proves
unreliable, switch to launching with an explicit `--session-id <uuid>` we generate
(then capture is exact) — the seam stays the same.

## VS-11.B — Resume from Chorus  (status: coded, NEEDS confirmation)

Goal: `claude --resume <id>` restores a Chorus-launched session inside a pane PTY.

Approach implemented: `resumeArgs(id)` → `['--resume', id]`; on a Layer-2 import the
pane's launch command becomes `claude --resume <id>` (with `--settings` still
injected by `withClaudeHooks`). Verify the conversation history renders in the pane
after import.

## VS-11.C — Path remap  (status: coded, NEEDS confirmation)

Goal: placing a transcript under the target machine's slug + resuming works.

Approach implemented: import computes the destination dir as
`~/.claude/projects/${claudeProjectSlug(remap(originalProjectPath))}/` and writes
`<sessionId>.jsonl` there. `remap` defaults to identity (same path on both
machines); when the cwd is missing on the new machine the user is prompted to
relocate it (US-11.7). Existing transcripts are backed up (`.jsonl.bak`) and never
silently overwritten (a confirmation gates overwrite).

Verify on a second machine: import a full bundle, confirm the transcript lands at
the remapped slug and `--resume` restores it.
