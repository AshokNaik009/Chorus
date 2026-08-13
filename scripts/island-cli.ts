/**
 * ISLAND mode's host half, driven from a terminal.
 *
 *   npx tsx scripts/island-cli.ts <command>
 *
 * This exists because `packages/app-electron/src/main/island.ts` imports no
 * Electron APIs — only node builtins, `@app/core` and `@app/store`. That makes
 * it importable in plain Node, so every host-side path (toggle, gate, probe,
 * the hook script itself) can be exercised in about two seconds instead of the
 * ~3 minutes an `npm run dist` + install + relaunch costs.
 *
 * The point is isolation: if a bug reproduces here it is in the host logic; if
 * it only shows up in the app it is in the React wiring or the IPC seam.
 *
 * Commands
 *   status              Everything at once: gate, script, CodeIsland's own
 *                       hooks, its `cli_enabled_claude` flag, running pids.
 *   probe               Just the `IslandStatus` the row's dot renders from.
 *   on [appPath]        setEnabled(true)  — the exact path the toggle runs.
 *   off                 setEnabled(false).
 *   gate <ids...>       Rewrite the allow-list (what the renderer normally owns).
 *   gate --clear        Write an empty allow-list (mode stays on, nobody opted in).
 *   panes               Claude session ids of the live Chorus panes, from `ps`.
 *   fire <id> [event]   Push a synthetic hook payload through the REAL script,
 *                       exactly as Claude Code would. `--raw` bypasses the
 *                       script and pipes straight into CodeIsland's bridge, so
 *                       the two runs isolate "the gate rejected it" from
 *                       "CodeIsland ignored it".
 *   sessions            What CodeIsland itself thinks exists (its sessions.json).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  CODEISLAND_BUNDLE_ID,
  CODEISLAND_CLAUDE_TOGGLE_KEY,
  splitCodeIslandHooks,
  type ClaudeHooksMap,
} from '../packages/core/src/index.js';
import {
  islandPaths,
  installIslandScript,
  probe,
  setEnabled,
  writeGate,
} from '../packages/app-electron/src/main/island.js';

const argv = process.argv.slice(2);
const command = argv[0] ?? 'status';

/** Run a command, returning trimmed stdout or null — never throws. */
function out(file: string, args: string[]): string | null {
  try {
    return execFileSync(file, args, {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function readGate(): string[] | null {
  try {
    return fs
      .readFileSync(islandPaths().gateFile, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return null; // absent = mode off
  }
}

/** CodeIsland's own hook entries still live in the user's Claude settings? */
function codeIslandHooksInstalled(): { events: string[]; total: number } {
  try {
    const raw = fs.readFileSync(
      path.join(os.homedir(), '.claude', 'settings.json'),
      'utf8',
    );
    const settings = JSON.parse(raw) as { hooks?: ClaudeHooksMap };
    const { removed } = splitCodeIslandHooks(settings.hooks ?? {});
    return { events: Object.keys(removed).sort(), total: Object.keys(removed).length };
  } catch {
    return { events: [], total: 0 };
  }
}

/**
 * The Claude session id of every live Chorus pane.
 *
 * Panes are spawned with `--settings <tmp>/pane-claude-hooks.json`, so the
 * process table is the one place both halves agree on. Chorus passes the id it
 * minted as `--session-id`, or `--resume` when reattaching to an existing
 * conversation — so the id is on the command line from the moment the pane
 * exists, whatever the renderer has caught up to.
 */
function livePaneSessionIds(): { pid: string; sessionId: string | null; cwd: string }[] {
  const ps = out('/bin/ps', ['-eo', 'pid=,command=']) ?? '';
  const rows: { pid: string; sessionId: string | null; cwd: string }[] = [];
  for (const line of ps.split('\n')) {
    if (!line.includes('pane-claude-hooks')) continue;
    const pid = line.trim().split(/\s+/)[0];
    const resume = /--(?:session-id|resume)\s+([0-9a-f-]{36})/.exec(line);
    const cwd = out('/usr/sbin/lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn']) ?? '';
    rows.push({
      pid,
      sessionId: resume?.[1] ?? null,
      cwd: cwd.split('\n').find((l) => l.startsWith('n'))?.slice(1) ?? '?',
    });
  }
  return rows;
}

/**
 * A hook payload shaped the way Claude Code emits one.
 *
 * Tool-bearing events carry `tool_name`/`tool_input` because CodeIsland renders
 * the tool, not the event — a PermissionRequest without one produces a card with
 * nothing to approve, which looks identical to the panel not drawing at all.
 */
function synthEvent(sessionId: string, event: string, cwd: string): string {
  const toolEvents = new Set([
    'PermissionRequest',
    'PreToolUse',
    'PostToolUse',
    'PostToolUseFailure',
  ]);
  return JSON.stringify({
    session_id: sessionId,
    transcript_path: '',
    hook_event_name: event,
    cwd,
    prompt: `island-cli ${event}`,
    ...(toolEvents.has(event)
      ? {
          tool_name: 'Bash',
          tool_input: { command: 'echo island-cli', description: 'island-cli probe' },
        }
      : {}),
  });
}

async function main(): Promise<void> {
  const p = islandPaths();

  switch (command) {
    case 'status': {
      const gate = readGate();
      const status = await probe();
      const hooks = codeIslandHooksInstalled();
      const flag = out('/usr/bin/defaults', [
        'read',
        CODEISLAND_BUNDLE_ID,
        CODEISLAND_CLAUDE_TOGGLE_KEY,
      ]);
      console.log('ISLAND mode');
      console.log(`  mode on (gate exists) : ${gate !== null}`);
      console.log(
        `  gated session ids     : ${gate === null ? '(no gate)' : gate.length ? gate.join(', ') : '(empty — nobody opted in)'}`,
      );
      console.log(`  hook script           : ${fs.existsSync(p.scriptPath) ? p.scriptPath : 'MISSING'}`);
      console.log('CodeIsland');
      console.log(`  app found             : ${status.appFound}`);
      console.log(`  bridge                : ${status.bridgeFound ? p.bridgePath : 'MISSING'}`);
      console.log(`  socket (running)      : ${status.socketFound}`);
      console.log(`  ${CODEISLAND_CLAUDE_TOGGLE_KEY}   : ${flag ?? '(unset)'}`);
      console.log(
        `  its own hooks         : ${hooks.total ? `INSTALLED (${hooks.total} events)` : 'stripped'}`,
      );
      console.log(`  pid                   : ${out('/usr/bin/pgrep', ['-x', 'CodeIsland']) ?? '(not running)'}`);
      if (status.error) console.log(`  error                 : ${status.error}`);
      const panes = livePaneSessionIds();
      console.log(`Chorus panes (${panes.length})`);
      for (const pane of panes) {
        console.log(`  pid ${pane.pid}  ${pane.sessionId ?? '(no session id yet)'}  ${pane.cwd}`);
      }
      break;
    }

    case 'probe':
      console.log(JSON.stringify(await probe(argv[1]), null, 2));
      break;

    case 'on': {
      const status = await setEnabled(true, argv[1]);
      console.log(JSON.stringify(status, null, 2));
      break;
    }

    case 'off': {
      const status = await setEnabled(false, argv[1]);
      console.log(JSON.stringify(status, null, 2));
      break;
    }

    case 'gate': {
      const ids = argv.slice(1).filter((a) => a !== '--clear');
      await writeGate(ids);
      console.log(`gate: ${ids.length ? ids.join(', ') : '(empty)'}`);
      break;
    }

    case 'panes':
      for (const pane of livePaneSessionIds()) {
        console.log(`${pane.pid}\t${pane.sessionId ?? '-'}\t${pane.cwd}`);
      }
      break;

    case 'fire': {
      const raw = argv.includes('--raw');
      const rest = argv.slice(1).filter((a) => a !== '--raw');
      const sessionId = rest[0];
      if (!sessionId) {
        console.error('usage: fire <session-id> [event] [cwd] [--raw]');
        process.exitCode = 2;
        return;
      }
      const event = rest[1] ?? 'UserPromptSubmit';
      const cwd = rest[2] ?? process.cwd();
      const target = raw ? p.bridgePath : p.scriptPath;
      installIslandScript();
      const started = Date.now();
      const run = spawnSync(target, [], {
        input: synthEvent(sessionId, event, cwd),
        encoding: 'utf8',
        timeout: 70_000,
      });
      console.log(`${raw ? 'bridge' : 'hook.sh'} exit=${run.status} in ${Date.now() - started}ms`);
      if (run.stdout?.trim()) console.log(`stdout: ${run.stdout.trim()}`);
      if (run.stderr?.trim()) console.log(`stderr: ${run.stderr.trim()}`);
      break;
    }

    case 'sessions': {
      try {
        const file = path.join(os.homedir(), '.codeisland', 'sessions.json');
        const list = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>[];
        console.log(`${list.length} session(s) in ${file}`);
        for (const s of list) {
          console.log(
            `  ${String(s.sessionId).slice(0, 8)}  ${String(s.source ?? '?').padEnd(8)} ${String(s.termBundleId ?? '?').padEnd(22)} ${String(s.lastActivity ?? '')}  ${String(s.cwd ?? '')}`,
          );
        }
      } catch (err) {
        console.log(`no readable sessions.json (${(err as Error).message})`);
      }
      break;
    }

    default:
      console.error(
        'usage: island-cli <status|probe|on|off|gate|panes|fire|sessions>\n' +
          '  see the header of this file for details',
      );
      process.exitCode = 2;
  }
}

void main();
