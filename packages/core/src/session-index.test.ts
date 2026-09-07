import { describe, expect, it } from 'vitest';
import {
  cleanPromptText,
  groupSessionsByProject,
  matchesSessionFilter,
  parseLiveSessions,
  parseSessionMeta,
  sessionDisplayTitle,
  truncateText,
  type SessionFileRef,
  type SessionMeta,
} from './session-index';

const FILE: SessionFileRef = {
  id: '7aec517b-7e36-451d-ae79-97621d33dfa1',
  path: '/Users/a/.claude/projects/-Users-a-proj/7aec517b-7e36-451d-ae79-97621d33dfa1.jsonl',
  bytes: 4096,
  mtime: 1_784_000_000_000,
};

/** Shapes below are trimmed copies of real `~/.claude/projects/*.jsonl` lines. */
const MODE_LINE = JSON.stringify({
  type: 'mode',
  mode: 'normal',
  sessionId: FILE.id,
});

function userLine(content: unknown, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
    cwd: '/Users/a/proj',
    gitBranch: 'feat/manual-swarm-modes',
    version: '2.1.220',
    sessionId: FILE.id,
    userType: 'external',
    ...extra,
  });
}

const AI_TITLE = (t: string) =>
  JSON.stringify({ type: 'ai-title', aiTitle: t, sessionId: FILE.id });

const LAST_PROMPT = (p?: string) =>
  JSON.stringify({
    type: 'last-prompt',
    leafUuid: 'a6fd4196-ae80-4964-92e4-db0254db9b8b',
    sessionId: FILE.id,
    ...(p ? { lastPrompt: p } : {}),
  });

describe('parseSessionMeta', () => {
  it('reads identity off the head and the newest title off the tail', () => {
    const head = [MODE_LINE, AI_TITLE('An early title'), userLine('Fix the login bug')].join(
      '\n',
    );
    const tail = [AI_TITLE('Add collapsible sidebar'), LAST_PROMPT('ship it')].join('\n');

    const meta = parseSessionMeta(head, tail, FILE);

    expect(meta).not.toBeNull();
    expect(meta!.claudeSessionId).toBe(FILE.id);
    expect(meta!.cwd).toBe('/Users/a/proj');
    expect(meta!.gitBranch).toBe('feat/manual-swarm-modes');
    expect(meta!.version).toBe('2.1.220');
    expect(meta!.title).toBe('Add collapsible sidebar');
    expect(meta!.firstPrompt).toBe('Fix the login bug');
    expect(meta!.lastPrompt).toBe('ship it');
    expect(meta!.mtime).toBe(FILE.mtime);
  });

  it('falls back head title → last prompt → first prompt', () => {
    const head = [MODE_LINE, AI_TITLE('Head title'), userLine('first turn')].join('\n');
    expect(parseSessionMeta(head, '', FILE)!.title).toBe('Head title');

    const noTitle = [MODE_LINE, userLine('first turn')].join('\n');
    expect(parseSessionMeta(noTitle, LAST_PROMPT('latest turn'), FILE)!.title).toBe(
      'latest turn',
    );
    expect(parseSessionMeta(noTitle, LAST_PROMPT(), FILE)!.title).toBe('first turn');
  });

  it('returns null without a cwd — resume is scoped to the original folder', () => {
    expect(parseSessionMeta(MODE_LINE, '', FILE)).toBeNull();
    expect(parseSessionMeta('', '', FILE)).toBeNull();
  });

  it('recovers identity from the tail when the head is unreadable', () => {
    const meta = parseSessionMeta('{"type":"user","cw', userLine('hello'), FILE);
    expect(meta!.cwd).toBe('/Users/a/proj');
  });

  it('skips garbled and truncated lines instead of throwing', () => {
    const head = [
      '{"type":"user","message":{"role":"user","content":"kept"},"cwd":"/Users/a/proj"}',
      'not json at all',
      '{"type":"user","message":{"role":"user","conte', // truncated read boundary
      '',
    ].join('\n');
    expect(() => parseSessionMeta(head, '', FILE)).not.toThrow();
    expect(parseSessionMeta(head, '', FILE)!.firstPrompt).toBe('kept');
  });

  it('ignores tool results, sidechains and meta turns when picking the first prompt', () => {
    const head = [
      userLine([{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'stdout' }], {
        toolUseResult: { stdout: 'x' },
      }),
      userLine('subagent instruction', { isSidechain: true }),
      userLine('caveat', { isMeta: true }),
      userLine('the real first prompt'),
    ].join('\n');
    expect(parseSessionMeta(head, '', FILE)!.firstPrompt).toBe('the real first prompt');
  });

  it('reads array content blocks', () => {
    const head = userLine([
      { type: 'text', text: 'Build the DMG' },
      { type: 'image', source: {} },
    ]);
    expect(parseSessionMeta(head, '', FILE)!.firstPrompt).toBe('Build the DMG');
  });

  it('lists a session that has no title at all', () => {
    const meta = parseSessionMeta(userLine('   '), '', FILE)!;
    expect(meta.title).toBeUndefined();
    expect(sessionDisplayTitle(meta)).toBe('session 7aec517b');
  });
});

describe('cleanPromptText', () => {
  it('unwraps a slash command to its name', () => {
    expect(
      cleanPromptText('<command-message>dmg</command-message>\n<command-name>/dmg</command-name>'),
    ).toBe('/dmg');
  });

  it('drops injected reminders and caveats', () => {
    expect(
      cleanPromptText(
        '<system-reminder>ignore me</system-reminder>Real question here' +
          '<local-command-caveat>Caveat: …</local-command-caveat>',
      ),
    ).toBe('Real question here');
  });

  it('collapses whitespace', () => {
    expect(cleanPromptText('a\n\n  b\tc ')).toBe('a b c');
  });
});

describe('truncateText', () => {
  it('leaves short text alone', () => {
    expect(truncateText('short', 10)).toBe('short');
  });

  it('cuts on a word boundary', () => {
    expect(truncateText('alpha beta gamma delta', 16)).toBe('alpha beta…');
  });
});

describe('groupSessionsByProject', () => {
  const meta = (cwd: string, mtime: number, id: string): SessionMeta => ({
    claudeSessionId: id,
    path: `/p/${id}.jsonl`,
    cwd,
    mtime,
    bytes: 10,
  });

  it('groups by folder, newest group and newest row first', () => {
    const groups = groupSessionsByProject([
      meta('/a', 100, 'one'),
      meta('/b', 300, 'two'),
      meta('/a', 200, 'three'),
    ]);
    expect(groups.map((g) => g.dir)).toEqual(['/b', '/a']);
    expect(groups[1].sessions.map((s) => s.claudeSessionId)).toEqual(['three', 'one']);
    expect(groups[1].lastActive).toBe(200);
  });
});

describe('matchesSessionFilter', () => {
  const meta: SessionMeta = {
    claudeSessionId: 'id',
    path: '/p/id.jsonl',
    cwd: '/Users/a/tui-bridgespaceclone',
    gitBranch: 'feat/manual-swarm-modes',
    title: 'Add collapsible sidebar',
    mtime: 1,
    bytes: 1,
  };

  it('matches title, folder and branch, and requires every term', () => {
    expect(matchesSessionFilter(meta, '')).toBe(true);
    expect(matchesSessionFilter(meta, 'sidebar')).toBe(true);
    expect(matchesSessionFilter(meta, 'bridgespace')).toBe(true);
    expect(matchesSessionFilter(meta, 'swarm-modes')).toBe(true);
    expect(matchesSessionFilter(meta, 'sidebar swarm')).toBe(true);
    expect(matchesSessionFilter(meta, 'sidebar nope')).toBe(false);
  });
});

describe('parseLiveSessions', () => {
  it('parses the `claude agents --json` shape', () => {
    const live = parseLiveSessions(
      JSON.stringify([
        {
          pid: 2362,
          cwd: '/Users/a/proj',
          kind: 'interactive',
          startedAt: 1783747185873,
          sessionId: 'b8196dfd-dfb1-4af2-8630-0040ac01a6da',
          name: 'proj-5b',
          status: 'idle',
        },
      ]),
    );
    expect(live).toEqual([
      {
        pid: 2362,
        cwd: '/Users/a/proj',
        sessionId: 'b8196dfd-dfb1-4af2-8630-0040ac01a6da',
        name: 'proj-5b',
        status: 'idle',
      },
    ]);
  });

  it('degrades to empty on junk, non-arrays and unusable entries', () => {
    expect(parseLiveSessions('not json')).toEqual([]);
    expect(parseLiveSessions('{"error":"unknown command"}')).toEqual([]);
    expect(parseLiveSessions('[{"pid":1}]')).toEqual([]);
  });
});
