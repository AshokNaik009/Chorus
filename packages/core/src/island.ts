/**
 * ISLAND mode — Chorus drives CodeIsland.
 *
 * CodeIsland (github.com/…/CodeIsland, MIT) is a macOS notch panel that shows a
 * live card per agent session, takes approve/deny on tool calls, and jumps to
 * the host app on click. It listens on a plain Unix socket at
 * `/tmp/codeisland-<uid>.sock` and ships its own client binary at
 * `~/.codeisland/codeisland-bridge`. This module is the Chorus half of the
 * bridge: the event table, the hook entries that go into the settings file
 * Chorus already passes to every pane via `claude --settings`, the shell script
 * those entries invoke, and the gate file that decides which panes participate.
 *
 * Three things make this safe to leave installed permanently:
 *
 *  - The hook entries are ALWAYS in the settings file; the gate file decides
 *    whether they do anything. Turning the mode off deletes the gate, and every
 *    hook then takes the `exit 0` path, which Claude Code defines as "no
 *    decision — continue through the normal permission flow". Identical
 *    behaviour to the mode not existing.
 *  - We never reimplement the socket protocol. The script pipes the hook's own
 *    stdin into CodeIsland's bridge, which does the framing, the blocking read,
 *    and the `_ppid`/ancestry enrichment that click-to-focus depends on.
 *  - The blocking events carry a bounded `timeout`. Per the hooks docs a
 *    cancelled PermissionRequest hook is ignored and the user is prompted
 *    normally, so a dead island degrades to an in-pane prompt rather than a
 *    stuck pane.
 *
 * Everything here is pure: the Electron host writes the strings to disk.
 */

/** One Claude Code hook event we forward, with its per-event timeout. */
export interface IslandEvent {
  /** Claude Code hook event name. */
  event: string;
  /** Seconds before Claude Code cancels the hook. */
  timeout: number;
}

/**
 * Seconds a blocking event may hold the pane. CodeIsland installs 86400 for its
 * own hooks (block until answered); Chorus bounds it instead, so a quit island
 * or a wedged bridge costs one minute of waiting and then falls through to the
 * pane's normal prompt.
 */
export const ISLAND_BLOCKING_TIMEOUT_SEC = 60;

/** Seconds for fire-and-forget events (status/lifecycle cards). */
export const ISLAND_NOTIFY_TIMEOUT_SEC = 5;

/**
 * The same 12 events CodeIsland installs for Claude Code itself, so a
 * Chorus-fed island shows exactly what a natively-hooked one would.
 * `PermissionRequest` and `Notification` are the two that block on a human.
 */
export const ISLAND_EVENTS: readonly IslandEvent[] = [
  { event: 'UserPromptSubmit', timeout: ISLAND_NOTIFY_TIMEOUT_SEC },
  { event: 'PreToolUse', timeout: ISLAND_NOTIFY_TIMEOUT_SEC },
  { event: 'PostToolUse', timeout: ISLAND_NOTIFY_TIMEOUT_SEC },
  { event: 'PostToolUseFailure', timeout: ISLAND_NOTIFY_TIMEOUT_SEC },
  { event: 'PermissionRequest', timeout: ISLAND_BLOCKING_TIMEOUT_SEC },
  { event: 'Stop', timeout: ISLAND_NOTIFY_TIMEOUT_SEC },
  { event: 'SubagentStart', timeout: ISLAND_NOTIFY_TIMEOUT_SEC },
  { event: 'SubagentStop', timeout: ISLAND_NOTIFY_TIMEOUT_SEC },
  { event: 'SessionStart', timeout: ISLAND_NOTIFY_TIMEOUT_SEC },
  { event: 'SessionEnd', timeout: ISLAND_NOTIFY_TIMEOUT_SEC },
  { event: 'Notification', timeout: ISLAND_BLOCKING_TIMEOUT_SEC },
  { event: 'PreCompact', timeout: ISLAND_NOTIFY_TIMEOUT_SEC },
] as const;

/** Where CodeIsland installs the client binary the hook script pipes into. */
export const CODEISLAND_BRIDGE_SUBPATH = '.codeisland/codeisland-bridge';

/** CodeIsland's bundle id — used to launch, quit, and read its defaults. */
export const CODEISLAND_BUNDLE_ID = 'com.codeisland.app';

/**
 * CodeIsland's UserDefaults key for "feed me from Claude Code's own settings".
 * Chorus turns this OFF while ISLAND mode is on: hook arrays merge across
 * settings sources, so leaving it on makes one tool call produce two cards.
 */
export const CODEISLAND_CLAUDE_TOGGLE_KEY = 'cli_enabled_claude';

export interface IslandHookEntry {
  /** Claude Code's tool matcher. Empty string = every tool, as CodeIsland uses. */
  matcher: string;
  hooks: { type: 'command'; command: string; timeout: number }[];
}

/**
 * The hook entries to merge into the generated settings file, keyed by event.
 * `scriptPath` is the absolute path of the script `renderIslandHookScript`
 * produced; it is quoted, so a path with spaces still works.
 */
export function buildIslandHooks(
  scriptPath: string,
): Record<string, IslandHookEntry[]> {
  const out: Record<string, IslandHookEntry[]> = {};
  for (const { event, timeout } of ISLAND_EVENTS) {
    out[event] = [
      {
        matcher: '',
        hooks: [{ type: 'command', command: `"${scriptPath}"`, timeout }],
      },
    ];
  }
  return out;
}

export interface IslandScriptPaths {
  /** Absolute path of the gate file (the allow-list of Claude session ids). */
  gateFile: string;
  /** Absolute path of CodeIsland's bridge binary. */
  bridgePath: string;
}

/**
 * The script every island hook runs. It answers one question — "is this pane
 * opted in right now?" — and either forwards stdin to CodeIsland's bridge or
 * exits 0 without a decision.
 *
 * Deliberately dependency-free (no `jq`): panes launch through a login shell
 * whose PATH we do not control. `sed` pulls `session_id` out of the hook JSON;
 * it is a UUID emitted by Claude Code, so a regex is sufficient and a miss just
 * means "not opted in".
 *
 * Every early exit is `exit 0` = "no decision". Mode off, island not installed,
 * pane in a background workspace, swarm pane, session id not captured yet — all
 * land there, and the pane behaves exactly as it does without ISLAND mode.
 */
export function renderIslandHookScript({
  gateFile,
  bridgePath,
}: IslandScriptPaths): string {
  return `#!/bin/bash
# Generated by Chorus (ISLAND mode). Do not edit — rewritten on every toggle.
GATE=${shellQuote(gateFile)}
BRIDGE=${shellQuote(bridgePath)}

# Mode off (no gate file) or CodeIsland not installed: no decision.
[ -f "$GATE" ] || exit 0
[ -x "$BRIDGE" ] || exit 0

INPUT=$(cat)
SID=$(printf '%s' "$INPUT" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -n 1)
[ -n "$SID" ] || exit 0

# The gate is one Claude session id per line: only panes in the active
# workspace are listed, so background and swarm panes prompt in-pane as usual.
grep -qxF "$SID" "$GATE" || exit 0

# CodeIsland's own client: it frames the request, half-closes, blocks for the
# reply, and enriches the payload with the ancestry that click-to-focus needs.
#
# \`exec\` is load-bearing, not a micro-optimisation. CodeIsland tracks the
# session's owning process so it can drop the card when the agent exits, and it
# finds that process by walking the bridge's ancestry for an executable named
# \`claude\` — which never matches, because Claude Code's binary is
# \`.../bin/claude.exe\`. It therefore falls back to the bridge's own parent.
# Piping into the bridge would make that parent THIS script, a shell that exits
# the moment the hook returns; CodeIsland's 3s liveness sweep then reads the
# agent as dead and removes the session about eight seconds after the card
# appears. \`exec\` replaces this shell with the bridge instead, so the parent is
# the pane's own \`claude\` process — the same arrangement CodeIsland's own hook
# gets from \`exec "$BRIDGE" "$@"\`.
exec "$BRIDGE" <<<"$INPUT"
`;
}

/**
 * The gate file's contents: one Claude conversation id per line. Ids are
 * de-duplicated and blanks dropped so `grep -qxF` can't match an empty line
 * (which would opt every pane in). Always ends with a newline.
 */
export function buildGateFile(claudeSessionIds: readonly string[]): string {
  const seen = new Set<string>();
  for (const id of claudeSessionIds) {
    const trimmed = id.trim();
    if (trimmed) seen.add(trimmed);
  }
  return seen.size ? `${[...seen].join('\n')}\n` : '';
}

/**
 * Anything in a settings file whose command points at CodeIsland's own hook
 * script or bridge. Matching on the path (not a marker comment) is what
 * CodeIsland's own uninstall does.
 */
const CODEISLAND_HOOK_RE = /codeisland-(hook\.sh|bridge)/;

/** A `hooks` map as it appears in a Claude Code settings file. */
export type ClaudeHooksMap = Record<
  string,
  Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>
>;

/**
 * Split a settings file's `hooks` map into what Chorus leaves alone and what
 * CodeIsland installed for itself.
 *
 * This exists because `defaults write cli_enabled_claude false` does NOT remove
 * CodeIsland's hooks — in CodeIsland that flag is set by a Swift toggle whose
 * *other* half calls `uninstallHooks`, and there is no external way to trigger
 * it. Writing the flag alone only stops its 60s auto-repair from re-adding
 * them; the entries already in `~/.claude/settings.json` keep firing.
 *
 * Leaving them is not cosmetic double-carding. Claude Code waits for every
 * matching hook, and CodeIsland's own PermissionRequest entry carries an 86400s
 * timeout — so one unanswered card would pin a pane for a day, defeating the
 * bounded 60s fallback that the whole design rests on.
 *
 * Only entries whose command names CodeIsland's own script/bridge are removed;
 * the user's other hooks, and any other key in the file, are untouched. Groups
 * and events left empty are dropped so no `[]` husks accumulate.
 */
export function splitCodeIslandHooks(hooks: ClaudeHooksMap): {
  kept: ClaudeHooksMap;
  removed: ClaudeHooksMap;
} {
  const kept: ClaudeHooksMap = {};
  const removed: ClaudeHooksMap = {};
  for (const [event, entries] of Object.entries(hooks ?? {})) {
    if (!Array.isArray(entries)) {
      kept[event] = entries;
      continue;
    }
    const keptEntries: ClaudeHooksMap[string] = [];
    const removedEntries: ClaudeHooksMap[string] = [];
    for (const entry of entries) {
      const commands = Array.isArray(entry?.hooks) ? entry.hooks : [];
      const mine = commands.filter((c) => CODEISLAND_HOOK_RE.test(c?.command ?? ''));
      const theirs = commands.filter(
        (c) => !CODEISLAND_HOOK_RE.test(c?.command ?? ''),
      );
      if (mine.length) removedEntries.push({ ...entry, hooks: mine });
      // An entry with no commands left is a husk; drop it. An entry that never
      // had a `hooks` array is someone else's shape — pass it through untouched.
      if (theirs.length || !commands.length) {
        keptEntries.push(commands.length ? { ...entry, hooks: theirs } : entry);
      }
    }
    if (keptEntries.length) kept[event] = keptEntries;
    if (removedEntries.length) removed[event] = removedEntries;
  }
  return { kept, removed };
}

/** Merge saved entries back into a hooks map, skipping ones already present. */
export function mergeCodeIslandHooks(
  hooks: ClaudeHooksMap,
  saved: ClaudeHooksMap,
): ClaudeHooksMap {
  const out: ClaudeHooksMap = { ...(hooks ?? {}) };
  for (const [event, entries] of Object.entries(saved ?? {})) {
    const existing = Array.isArray(out[event]) ? out[event] : [];
    // CodeIsland's own auto-repair may have beaten us to it; re-adding would
    // double the entry and bring back exactly the bug we removed them for.
    const already = existing.some((e) =>
      (e?.hooks ?? []).some((c) => CODEISLAND_HOOK_RE.test(c?.command ?? '')),
    );
    out[event] = already ? existing : [...existing, ...entries];
  }
  return out;
}

/** What the host can tell the UI about the local CodeIsland install. */
export interface IslandStatus {
  /** The mode is currently on (gate file present + island launched). */
  enabled: boolean;
  /** CodeIsland.app resolves — by bundle id, or at the configured `appPath`. */
  appFound: boolean;
  /** `~/.codeisland/codeisland-bridge` exists and is executable. */
  bridgeFound: boolean;
  /** The island's Unix socket is present, i.e. it is running and listening. */
  socketFound: boolean;
  /** A one-line reason the last toggle failed, for the row's error text. */
  error?: string;
}

/**
 * Host capability behind ISLAND mode. Electron implements it; the web harness
 * injects nothing and the UI renders the row disabled ("macOS app only").
 */
export interface IslandControl {
  /** Turn the mode on/off. Returns the resulting status (never throws). */
  setEnabled(enabled: boolean, appPath?: string): Promise<IslandStatus>;
  /** Rewrite the allow-list: the active workspace's non-swarm Claude panes. */
  writeGate(claudeSessionIds: string[]): Promise<void>;
  /** Current install/run state, for the row's dot and error line. */
  probe(appPath?: string): Promise<IslandStatus>;
}

/** Single-quote a path for POSIX sh, escaping embedded single quotes. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
