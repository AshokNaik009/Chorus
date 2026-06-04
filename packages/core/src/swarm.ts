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
 * Host helper for the shared blackboard. Electron writes real files; the web
 * harness injects nothing, so fan-out runs without a shared dir and the UI shows
 * a clear note (US-10.4).
 */
export interface SwarmWorkspace {
  /** True when real shared files can be created (Electron). */
  readonly available: boolean;
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
 * The shared `CHORUS_SWARM.md` blackboard: the task, roster, and a conventions
 * section the seeded agents are told to read and append to (US-10.4).
 */
export function buildBlackboardDoc(def: SwarmDef): string {
  const roster =
    def.members
      .map(
        (m, i) =>
          `- Agent ${i + 1}${m.role ? ` — ${m.role}` : ''} (session \`${m.sessionId}\`)`,
      )
      .join('\n') || '- (no members yet)';
  return [
    `# ${def.name} — Chorus swarm`,
    '',
    '## Task',
    def.task?.trim() || '(no shared task set)',
    '',
    '## Roster',
    roster,
    '',
    '## Conventions',
    '- This file is the shared blackboard for the swarm. Coordinate here instead of relaying through the human.',
    '- Before starting, announce in the Log what you are about to work on, to avoid overlap.',
    '- Record decisions, shared interfaces, and blockers other agents need.',
    "- Append to your own entries; don't rewrite another agent's notes.",
    '',
    '## Log',
    '',
  ].join('\n');
}

/**
 * The seed prompt for one member: shared task + role + blackboard path + the
 * coordination convention. Templated by role; an explicit `member.seedPrompt`
 * overrides the template (US-10.3).
 */
export function buildSeedPrompt(
  def: SwarmDef,
  member: SwarmMember,
  blackboardPath: string | null,
): string {
  if (member.seedPrompt && member.seedPrompt.trim()) return member.seedPrompt.trim();
  const role = member.role?.trim();
  const lines: (string | null)[] = [
    `You are one agent in a coordinated Chorus swarm named "${def.name}".`,
    def.task?.trim() ? `Shared objective: ${def.task.trim()}` : null,
    role
      ? `Your role: ${role}. Own the ${role} slice of the work and stay in that lane.`
      : 'You have no assigned role — coordinate to claim a slice of the work.',
    blackboardPath
      ? `Shared blackboard: ${blackboardPath}/CHORUS_SWARM.md. Read it first, then append your plan and progress there so the other agents can see it.`
      : 'No shared blackboard is available in this host — coordinate with the human, who will relay between agents.',
    'Start by reading the blackboard (if any) and announcing what you will work on.',
  ];
  return lines.filter((l): l is string => l !== null).join('\n');
}

/** Per-member seed writes for a fan-out (US-10.3). Pure; the App executes them. */
export function planFanOut(
  def: SwarmDef,
  blackboardPath: string | null,
): { sessionId: string; seed: string }[] {
  return def.members.map((m) => ({
    sessionId: m.sessionId,
    seed: buildSeedPrompt(def, m, blackboardPath),
  }));
}

/**
 * Orchestrates a persisted swarm over a `SwarmWriter` (the SessionManager). Owns
 * the swarmId-addressed group actions; ad-hoc multi-select broadcast uses the
 * `broadcastTo` helper directly. Fan-out's pane spawning lives in the App (it
 * touches layout), seeded by `planFanOut` above.
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
