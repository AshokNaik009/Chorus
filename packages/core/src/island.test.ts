import { describe, expect, it } from 'vitest';
import {
  buildGateFile,
  buildIslandHooks,
  ISLAND_BLOCKING_TIMEOUT_SEC,
  ISLAND_EVENTS,
  ISLAND_NOTIFY_TIMEOUT_SEC,
  mergeCodeIslandHooks,
  renderIslandHookScript,
  splitCodeIslandHooks,
} from './island';
import { buildClaudeHookSettings } from './osc';

const PATHS = {
  gateFile: '/Users/x/.chorus/island/enabled',
  bridgePath: '/Users/x/.codeisland/codeisland-bridge',
};

describe('ISLAND_EVENTS', () => {
  it('covers the 12 events CodeIsland installs for Claude Code', () => {
    expect(ISLAND_EVENTS.map((e) => e.event)).toEqual([
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'PermissionRequest',
      'Stop',
      'SubagentStart',
      'SubagentStop',
      'SessionStart',
      'SessionEnd',
      'Notification',
      'PreCompact',
    ]);
  });

  it('blocks only on the two events that wait for a human', () => {
    const blocking = ISLAND_EVENTS.filter(
      (e) => e.timeout === ISLAND_BLOCKING_TIMEOUT_SEC,
    ).map((e) => e.event);
    expect(blocking).toEqual(['PermissionRequest', 'Notification']);
    // The rest are fire-and-forget: a slow island must never stall a pane.
    for (const e of ISLAND_EVENTS) {
      if (!blocking.includes(e.event)) {
        expect(e.timeout).toBe(ISLAND_NOTIFY_TIMEOUT_SEC);
      }
    }
  });
});

describe('buildIslandHooks', () => {
  it('points every event at the quoted script with its timeout', () => {
    const hooks = buildIslandHooks('/tmp/a b/hook.sh');
    expect(Object.keys(hooks)).toHaveLength(ISLAND_EVENTS.length);
    const perm = hooks.PermissionRequest[0];
    expect(perm.matcher).toBe('');
    expect(perm.hooks[0]).toEqual({
      type: 'command',
      command: '"/tmp/a b/hook.sh"',
      timeout: ISLAND_BLOCKING_TIMEOUT_SEC,
    });
    expect(hooks.PreToolUse[0].hooks[0].timeout).toBe(ISLAND_NOTIFY_TIMEOUT_SEC);
  });
});

describe('buildClaudeHookSettings with the island script', () => {
  it('leaves the status hooks alone when no script is given', () => {
    const s = buildClaudeHookSettings();
    expect(Object.keys(s.hooks)).toEqual(['Notification', 'Stop']);
    expect(s.hooks.Stop).toHaveLength(1);
  });

  it('adds the island entry alongside the status OSC, never replacing it', () => {
    const s = buildClaudeHookSettings({ islandScript: '/tmp/hook.sh' });
    expect(s.hooks.Stop).toHaveLength(2);
    expect(s.hooks.Stop[0].hooks[0].command).toContain('pane;status;idle');
    expect(s.hooks.Stop[1].hooks[0].command).toBe('"/tmp/hook.sh"');
    expect(s.hooks.Notification).toHaveLength(2);
    expect(s.hooks.Notification[0].hooks[0].command).toContain(
      'pane;status;waiting',
    );
    expect(s.hooks.PermissionRequest).toHaveLength(1);
  });
});

describe('renderIslandHookScript', () => {
  const script = renderIslandHookScript(PATHS);

  it('quotes the host-resolved paths rather than assuming $HOME', () => {
    expect(script).toContain(`GATE='${PATHS.gateFile}'`);
    expect(script).toContain(`BRIDGE='${PATHS.bridgePath}'`);
  });

  it('escapes a single quote in a path', () => {
    const s = renderIslandHookScript({ ...PATHS, gateFile: "/a/o'brien/gate" });
    expect(s).toContain(`GATE='/a/o'\\''brien/gate'`);
  });

  it('exits 0 (no decision) on every gate miss, then hands off to the bridge', () => {
    for (const guard of [
      '[ -f "$GATE" ] || exit 0',
      '[ -x "$BRIDGE" ] || exit 0',
      '[ -n "$SID" ] || exit 0',
      'grep -qxF "$SID" "$GATE" || exit 0',
    ]) {
      expect(script).toContain(guard);
    }
    expect(script).toContain('exec "$BRIDGE" <<<"$INPUT"');
    expect(script).not.toContain('jq');
  });

  /**
   * Regression guard for the vanishing card. CodeIsland decides whether a
   * session is still alive from the bridge's PARENT process, so the bridge must
   * REPLACE this script rather than run as its child — a child's parent is a
   * shell that exits immediately, which reads as a dead agent and removes the
   * card ~8s after it appears. Piping is the natural way to write this line and
   * is silently wrong, hence the explicit assertion.
   */
  it('never runs the bridge as a child process', () => {
    expect(script).not.toContain('| "$BRIDGE"');
  });

  it('extracts session_id with a shell that is actually there', () => {
    expect(script).toContain('sed -n');
    expect(script).toContain('"session_id"');
  });
});

describe('splitCodeIslandHooks', () => {
  const ci = (t?: number) => ({
    matcher: '',
    hooks: [{ type: 'command', command: '~/.codeisland/codeisland-hook.sh', ...(t ? { timeout: t } : {}) }],
  });
  const mine = { hooks: [{ type: 'command', command: 'printf x > /dev/tty' }] };

  it('removes CodeIsland entries and keeps everyone else’s', () => {
    const { kept, removed } = splitCodeIslandHooks({
      Stop: [mine, ci()],
      PermissionRequest: [ci(86400)],
      Notification: [mine],
    });
    expect(kept.Stop).toEqual([mine]);
    expect(kept.Notification).toEqual([mine]);
    // An event that was ONLY CodeIsland's disappears rather than leaving `[]`.
    expect(kept.PermissionRequest).toBeUndefined();
    expect(removed.PermissionRequest).toEqual([ci(86400)]);
    expect(removed.Stop).toEqual([ci()]);
    expect(removed.Notification).toBeUndefined();
  });

  it('splits a group that mixes both commands', () => {
    const { kept, removed } = splitCodeIslandHooks({
      Stop: [
        {
          matcher: '',
          hooks: [
            { type: 'command', command: 'mine.sh' },
            { type: 'command', command: '/Users/x/.codeisland/codeisland-bridge' },
          ],
        },
      ],
    });
    expect(kept.Stop[0].hooks).toEqual([{ type: 'command', command: 'mine.sh' }]);
    expect(removed.Stop[0].hooks).toHaveLength(1);
  });

  it('never drops a foreign shape it does not understand', () => {
    const odd = { Stop: [{ matcher: '*' }] } as never;
    expect(splitCodeIslandHooks(odd).kept).toEqual({ Stop: [{ matcher: '*' }] });
    expect(splitCodeIslandHooks({}).kept).toEqual({});
  });

  it('round-trips: strip then merge restores the original', () => {
    const original = { Stop: [mine, ci()], PermissionRequest: [ci(86400)] };
    const { kept, removed } = splitCodeIslandHooks(original);
    expect(mergeCodeIslandHooks(kept, removed)).toEqual(original);
  });

  it('merge is idempotent when auto-repair already re-added the hooks', () => {
    const { kept, removed } = splitCodeIslandHooks({ Stop: [mine, ci()] });
    const repaired = { Stop: [mine, ci()] }; // CodeIsland got there first
    expect(mergeCodeIslandHooks(repaired, removed)).toEqual(repaired);
  });
});

describe('buildGateFile', () => {
  it('writes one id per line, newline-terminated', () => {
    expect(buildGateFile(['a', 'b'])).toBe('a\nb\n');
  });

  it('de-duplicates', () => {
    expect(buildGateFile(['a', 'a', 'b'])).toBe('a\nb\n');
  });

  it('drops blanks — an empty line would opt EVERY pane in via grep -x', () => {
    expect(buildGateFile(['', '  ', 'a'])).toBe('a\n');
    expect(buildGateFile([])).toBe('');
    expect(buildGateFile(['', ' '])).toBe('');
  });
});
