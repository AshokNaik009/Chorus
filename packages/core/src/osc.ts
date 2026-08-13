import { buildIslandHooks } from './island.js';
import type { HookStatus } from './status.js';

/**
 * Status detection via a custom OSC escape sequence. See PRD §5.4 and §10.
 *
 * Chosen schema (the §10 open question, now decided):
 *   OSC code  : 777   (namespaced; will not collide with normal output)
 *   payload   : "pane;status;<state>"   state ∈ idle | waiting | running
 *   full bytes: ESC ] 777 ; pane ; status ; <state> BEL
 *               \x1b]777;pane;status;waiting\x07
 *
 * Claude Code Notification/Stop hooks emit this to the controlling terminal
 * (/dev/tty), so it travels the same PTY stream as normal output. A pure
 * scanner here parses the status and strips the bytes so they never render.
 * Keeping this in core (not a React component / xterm handler) makes it unit
 * testable against captured byte streams, including sequences split across
 * reads.
 */

export const OSC_CODE = 777;
const START = '\x1b]777;';
const BEL = '\x07';
// Matches one COMPLETE sequence terminated by BEL or ST (ESC \).
const OSC_RE = /\x1b\]777;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

/** The raw escape a hook prints for a given state. */
export function formatStatusOsc(state: HookStatus): string {
  return `${START}pane;status;${state}${BEL}`;
}

/** Parse an OSC-777 payload ("pane;status;<state>") to a status, or null. */
export function parseStatusPayload(payload: string): HookStatus | null {
  const parts = payload.split(';');
  if (parts.length !== 3) return null;
  const [ns, key, value] = parts;
  if (ns !== 'pane' || key !== 'status') return null;
  if (value === 'idle' || value === 'waiting' || value === 'running') {
    return value;
  }
  return null;
}

/** Is `tail` (from the last ESC) the start of an as-yet-incomplete OSC-777? */
function isPartialOsc777(tail: string): boolean {
  if (tail.startsWith(START)) return true; // started, no terminator yet
  return START.startsWith(tail); // a prefix of the start marker
}

/**
 * Stateful, surgical scanner. Feed it raw PTY chunks; it returns the chunk with
 * any OSC-777 sequences removed plus the statuses found. It buffers a trailing
 * partial sequence across chunks and passes ALL other bytes (including other
 * OSC sequences) through verbatim.
 */
export class OscStatusScanner {
  private pending = '';

  push(chunk: string): { output: string; statuses: HookStatus[] } {
    const buf = this.pending + chunk;
    this.pending = '';

    const statuses: HookStatus[] = [];
    let output = '';
    let lastIndex = 0;

    OSC_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = OSC_RE.exec(buf)) !== null) {
      output += buf.slice(lastIndex, match.index);
      const status = parseStatusPayload(match[1]);
      if (status) statuses.push(status);
      lastIndex = OSC_RE.lastIndex;
    }

    let rest = buf.slice(lastIndex);
    const esc = rest.lastIndexOf('\x1b');
    if (esc !== -1) {
      const tail = rest.slice(esc);
      if (isPartialOsc777(tail)) {
        this.pending = tail;
        rest = rest.slice(0, esc);
      }
    }
    output += rest;
    return { output, statuses };
  }

  reset(): void {
    this.pending = '';
  }
}

export interface ClaudeHookCommand {
  type: 'command';
  command: string;
  /** Seconds before Claude Code cancels the command. Omitted = CLI default. */
  timeout?: number;
}

/** One entry in an event's hook array: an optional matcher plus its commands. */
export interface ClaudeHookGroup {
  matcher?: string;
  hooks: ClaudeHookCommand[];
}

export interface ClaudeHookSettings {
  hooks: {
    /** Status OSC (-> waiting), plus the island hook when ISLAND mode is wired. */
    Notification: ClaudeHookGroup[];
    /** Status OSC (-> idle), plus the island hook when ISLAND mode is wired. */
    Stop: ClaudeHookGroup[];
  } & Record<string, ClaudeHookGroup[]>;
}

function hookCommand(state: HookStatus): string {
  // Write the raw OSC to the controlling terminal: Claude Code captures a
  // hook's stdout, so printing to /dev/tty is how the bytes reach xterm.
  // Octal escapes (\033 = ESC, \007 = BEL) for portable printf.
  return `printf '\\033]777;pane;status;${state}\\007' > /dev/tty 2>/dev/null`;
}

export interface ClaudeHookOptions {
  /**
   * Absolute path of the ISLAND-mode hook script (see `island.ts`). When given,
   * the island's 12 events are merged in alongside the status hooks. The script
   * is always installed; its gate file decides whether it does anything, so the
   * mode can be toggled without respawning any pane.
   */
  islandScript?: string;
}

/**
 * Build the settings object passed to `claude --settings <file>`, installing
 * the Notification (-> waiting) and Stop (-> idle) hooks (PRD §5.4). Pure so the
 * shape is testable; the host writes it to a file.
 *
 * Notification and Stop end up with two entries when the island script is
 * wired: Claude Code runs every matching hook, so the OSC status still fires
 * immediately regardless of what the island does with the event.
 */
export function buildClaudeHookSettings(
  opts: ClaudeHookOptions = {},
): ClaudeHookSettings {
  const hooks: ClaudeHookSettings['hooks'] = {
    Notification: [
      { hooks: [{ type: 'command', command: hookCommand('waiting') }] },
    ],
    Stop: [{ hooks: [{ type: 'command', command: hookCommand('idle') }] }],
  };
  if (opts.islandScript) {
    for (const [event, entries] of Object.entries(
      buildIslandHooks(opts.islandScript),
    )) {
      hooks[event] = [...(hooks[event] ?? []), ...entries];
    }
  }
  return { hooks };
}
