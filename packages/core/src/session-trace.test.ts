import { describe, expect, it } from 'vitest';
import {
  buildTurns,
  categorizeToolName,
  classifyEntry,
  mcpDisplayName,
  parseMcpToolName,
  parseTrace,
  parseTraceSlice,
  sanitizeContent,
  toolSummary,
  type TraceTurn,
} from './session-trace';

/** Shapes below are trimmed copies of real `~/.claude/projects/*.jsonl` lines. */

const T0 = '2026-07-29T10:00:00.000Z';
const T1 = '2026-07-29T10:00:02.500Z';
const T2 = '2026-07-29T10:00:09.000Z';

function line(o: unknown): string {
  return JSON.stringify(o);
}

function userLine(content: unknown, extra: Record<string, unknown> = {}) {
  return line({
    type: 'user',
    timestamp: T0,
    message: { role: 'user', content },
    cwd: '/Users/a/proj',
    ...extra,
  });
}

function assistantLine(content: unknown[], extra: Record<string, unknown> = {}) {
  return line({
    type: 'assistant',
    timestamp: T1,
    message: {
      role: 'assistant',
      model: 'claude-opus-5',
      content,
      usage: {
        input_tokens: 12,
        output_tokens: 340,
        cache_read_input_tokens: 51_200,
        cache_creation_input_tokens: 900,
      },
    },
    ...extra,
  });
}

function toolResultLine(id: string, content: unknown, extra: Record<string, unknown> = {}) {
  return line({
    type: 'user',
    timestamp: T2,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content }],
    },
    toolUseResult: { ok: true },
    ...extra,
  });
}

const READ_CALL = {
  type: 'tool_use',
  id: 'toolu_01A',
  name: 'Read',
  input: { file_path: '/Users/a/proj/src/parser/entry.rs' },
};

// ---- taxonomy ----

describe('categorizeToolName', () => {
  it('maps the core tools', () => {
    expect(categorizeToolName('Read')).toBe('read');
    expect(categorizeToolName('Edit')).toBe('edit');
    expect(categorizeToolName('Bash')).toBe('bash');
    expect(categorizeToolName('Grep')).toBe('grep');
    expect(categorizeToolName('WebFetch')).toBe('web');
    expect(categorizeToolName('CronCreate')).toBe('cron');
  });

  it('keeps the two non-obvious placements from the reference', () => {
    // NotebookEdit replaces a cell rather than patching text.
    expect(categorizeToolName('NotebookEdit')).toBe('write');
    // SendMessage is cross-agent messaging, not a local utility.
    expect(categorizeToolName('SendMessage')).toBe('task');
  });

  it('routes any mcp__ name to mcp and everything unknown to other', () => {
    expect(categorizeToolName('mcp__chrome-devtools__take_screenshot')).toBe('mcp');
    expect(categorizeToolName('LS')).toBe('other');
    expect(categorizeToolName('')).toBe('other');
  });
});

describe('parseMcpToolName', () => {
  it('splits server from tool', () => {
    expect(parseMcpToolName('mcp__chrome-devtools__take_screenshot')).toEqual({
      server: 'chrome-devtools',
      tool: 'take_screenshot',
    });
  });

  it('rejects names with an empty half', () => {
    expect(parseMcpToolName('mcp____tool')).toBeNull();
    expect(parseMcpToolName('mcp__')).toBeNull();
    expect(parseMcpToolName('Read')).toBeNull();
  });

  it('labels an MCP row by its server', () => {
    expect(mcpDisplayName('mcp__figma__get_design_context')).toBe('MCP figma');
    expect(mcpDisplayName('Read')).toBe('Read');
  });
});

// ---- summaries ----

describe('toolSummary', () => {
  it('abbreviates a Read to its last path segments', () => {
    expect(toolSummary('Read', { file_path: '/Users/a/proj/src/parser/entry.rs' })).toBe(
      'parser/entry.rs',
    );
  });

  it('adds the line range when a Read is bounded', () => {
    expect(
      toolSummary('Read', { file_path: '/a/b/c.ts', offset: 10, limit: 20 }),
    ).toBe('b/c.ts · lines 10-29');
  });

  it('prefers description plus command for Bash', () => {
    expect(toolSummary('Bash', { description: 'List files', command: 'ls -la' })).toBe(
      'List files: ls -la',
    );
    expect(toolSummary('Bash', { command: 'git status' })).toBe('git status');
  });

  it('reports an Edit as a line delta', () => {
    expect(
      toolSummary('Edit', {
        file_path: '/src/ui/panel.tsx',
        old_string: 'one\ntwo',
        new_string: 'one\ntwo\nthree',
      }),
    ).toBe('ui/panel.tsx · 2→3 lines');
  });

  it('leaves a path already short enough alone', () => {
    expect(toolSummary('Read', { file_path: '/a/b.ts' })).toBe('/a/b.ts');
  });

  it('spaces an MCP tool id into prose', () => {
    expect(toolSummary('mcp__chrome-devtools__take_screenshot', {})).toBe(
      'take screenshot',
    );
  });

  it('falls back to the tool name when the input is not an object', () => {
    expect(toolSummary('Read', null)).toBe('Read');
    expect(toolSummary('Weird', 'a string')).toBe('Weird');
    expect(toolSummary('Weird', {})).toBe('Weird');
  });
});

// ---- sanitising ----

describe('sanitizeContent', () => {
  it('rewrites a slash command to what the user typed', () => {
    const raw =
      '<command-name>/clear</command-name><command-message>clear</command-message><command-args>now</command-args>';
    expect(sanitizeContent(raw)).toBe('/clear now');
  });

  it('strips reminder wrappers but keeps the real content and its newlines', () => {
    const raw = 'Line one\nLine two<system-reminder>ignore me</system-reminder>';
    expect(sanitizeContent(raw)).toBe('Line one\nLine two');
  });
});

// ---- classification ----

describe('classifyEntry', () => {
  it('drops structural noise entries', () => {
    for (const type of [
      'file-history-snapshot',
      'queue-operation',
      'progress',
      'last-prompt',
      'ai-title',
      'mode',
      'rewind-pointer',
    ]) {
      expect(classifyEntry({ type, timestamp: T0 })).toBeNull();
    }
  });

  it('drops a fallbackModel stub with empty content', () => {
    expect(
      classifyEntry(JSON.parse(assistantLine([])) as Record<string, unknown>),
    ).toBeNull();
  });

  it('drops a pure system-reminder user turn but keeps one that wraps real text', () => {
    const pure = JSON.parse(
      userLine('<system-reminder>context</system-reminder>'),
    ) as Record<string, unknown>;
    expect(classifyEntry(pure)).toBeNull();

    const mixed = JSON.parse(
      userLine('<system-reminder>context</system-reminder>fix the bug'),
    ) as Record<string, unknown>;
    expect(classifyEntry(mixed)).toMatchObject({ kind: 'user', text: 'fix the bug' });
  });

  it('drops a synthetic re-prompt but keeps Stop hook feedback', () => {
    const meta = JSON.parse(userLine('anything', { isMeta: true })) as Record<
      string,
      unknown
    >;
    expect(classifyEntry(meta)).toBeNull();

    const feedback = JSON.parse(
      userLine('Stop hook feedback:\n[format]: 2 files changed', { isMeta: true }),
    ) as Record<string, unknown>;
    expect(classifyEntry(feedback)).toMatchObject({
      kind: 'hook',
      hookEvent: 'Stop',
      hookName: 'format',
    });
  });

  it('reads captured command output as system output, not a prompt', () => {
    const entry = JSON.parse(
      userLine('<local-command-stdout>total 26240</local-command-stdout>'),
    ) as Record<string, unknown>;
    expect(classifyEntry(entry)).toMatchObject({
      kind: 'system',
      output: 'total 26240',
      isError: false,
    });
  });

  it('reads the nested cache_creation form as well as the flat one', () => {
    const entry = JSON.parse(
      line({
        type: 'assistant',
        timestamp: T1,
        message: {
          role: 'assistant',
          model: 'claude-opus-5',
          content: [{ type: 'text', text: 'hi' }],
          usage: {
            input_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_creation: { input_tokens: 4096 },
          },
        },
      }),
    ) as Record<string, unknown>;
    expect(classifyEntry(entry)).toMatchObject({
      kind: 'assistant',
      usage: { cacheCreationTokens: 4096 },
    });
  });

  it('un-stringifies a tool input mangled by the pre-2.1.92 bug', () => {
    const entry = JSON.parse(
      assistantLine([
        { type: 'tool_use', id: 'x', name: 'Bash', input: { env: '["K=v"]' } },
      ]),
    ) as Record<string, unknown>;
    const msg = classifyEntry(entry);
    expect(msg).toMatchObject({ kind: 'assistant' });
    if (msg?.kind !== 'assistant') throw new Error('expected assistant');
    expect(msg.blocks[0].toolInput).toEqual({ env: ['K=v'] });
  });
});

// ---- turn assembly ----

function assistantTurn(turns: TraceTurn[]): TraceTurn {
  const t = turns.find((x) => x.role === 'assistant');
  if (!t) throw new Error('no assistant turn');
  return t;
}

describe('buildTurns', () => {
  it('merges consecutive assistant entries into one turn', () => {
    const jsonl = [
      userLine('read the parser'),
      assistantLine([{ type: 'thinking', thinking: 'Let me look.' }]),
      assistantLine([{ type: 'text', text: 'Reading it now.' }]),
      assistantLine([READ_CALL]),
    ].join('\n');

    const turns = parseTrace(jsonl);
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant']);

    const ai = assistantTurn(turns);
    expect(ai.thinkingCount).toBe(1);
    expect(ai.model).toBe('claude-opus-5');
    expect(ai.items.map((i) => i.type)).toEqual(['thinking', 'output', 'tool']);
  });

  it('pairs a tool_use with the tool_result that arrives later, with its duration', () => {
    const jsonl = [
      userLine('read it'),
      assistantLine([READ_CALL]),
      toolResultLine('toolu_01A', 'file contents here'),
    ].join('\n');

    const tool = assistantTurn(parseTrace(jsonl)).items[0];
    expect(tool).toMatchObject({
      type: 'tool',
      toolName: 'Read',
      toolCategory: 'read',
      toolSummary: 'parser/entry.rs',
      toolResult: 'file contents here',
      toolError: false,
      // T1 -> T2 is 6.5s.
      durationMs: 6_500,
    });
    expect(tool.orphan).toBeUndefined();
    expect(tool.deferred).toBeUndefined();
  });

  it('flattens an array-form tool result to its text', () => {
    const jsonl = [
      assistantLine([READ_CALL]),
      toolResultLine('toolu_01A', [{ type: 'text', text: 'line A' }]),
    ].join('\n');
    expect(assistantTurn(parseTrace(jsonl)).items[0].toolResult).toBe('line A');
  });

  it('marks an errored tool result', () => {
    const jsonl = [
      assistantLine([READ_CALL]),
      line({
        type: 'user',
        timestamp: T2,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_01A',
              content: 'ENOENT',
              is_error: true,
            },
          ],
        },
      }),
    ].join('\n');
    expect(assistantTurn(parseTrace(jsonl)).items[0]).toMatchObject({
      toolError: true,
      toolResult: 'ENOENT',
    });
  });

  it('calls an unresolved tool deferred at the end of the transcript', () => {
    // The transcript simply stops here — the call is still in flight.
    const turns = parseTrace([userLine('go'), assistantLine([READ_CALL])].join('\n'));
    expect(assistantTurn(turns).items[0]).toMatchObject({ deferred: true });
    expect(assistantTurn(turns).items[0].orphan).toBeUndefined();
  });

  it('calls an unresolved tool an orphan when the conversation moved past it', () => {
    // A user turn after an unanswered call means a discarded/rewound timeline.
    const turns = parseTrace(
      [userLine('go'), assistantLine([READ_CALL]), userLine('never mind')].join('\n'),
    );
    expect(assistantTurn(turns).items[0]).toMatchObject({ orphan: true });
    expect(assistantTurn(turns).items[0].deferred).toBeUndefined();
  });

  it('keeps a result whose call fell off the front of the window', () => {
    // The tail read starts after the tool_use — show the output, don't drop it.
    const turns = parseTrace(toolResultLine('toolu_gone', 'orphaned output'));
    expect(assistantTurn(turns).items).toEqual([
      { type: 'output', text: 'orphaned output' },
    ]);
  });

  it('takes usage from the last real reply and never from a meta entry', () => {
    const jsonl = [
      assistantLine([READ_CALL]),
      toolResultLine('toolu_01A', 'done'),
      assistantLine([{ type: 'text', text: 'Finished.' }]),
    ].join('\n');
    expect(assistantTurn(parseTrace(jsonl)).usage).toEqual({
      inputTokens: 12,
      outputTokens: 340,
      cacheReadTokens: 51_200,
      cacheCreationTokens: 900,
    });
  });

  it('omits a redacted thinking block but still counts it', () => {
    const turns = parseTrace(assistantLine([{ type: 'thinking', thinking: '' }]));
    const ai = assistantTurn(turns);
    expect(ai.thinkingCount).toBe(1);
    expect(ai.items).toEqual([]);
  });

  it('renders a compaction boundary as its own turn', () => {
    const turns = parseTrace(
      [
        userLine('go'),
        line({ type: 'compact_boundary', timestamp: T1 }),
        userLine('carry on'),
      ].join('\n'),
    );
    expect(turns.map((t) => t.role)).toEqual(['user', 'compact', 'user']);
  });

  it('places a hook in order inside the surrounding assistant turn', () => {
    const jsonl = [
      assistantLine([READ_CALL]),
      line({
        type: 'attachment',
        timestamp: T2,
        attachment: {
          hookEvent: 'PostToolUse',
          hookName: 'PostToolUse:Read',
          command: 'callback',
        },
      }),
      toolResultLine('toolu_01A', 'contents'),
    ].join('\n');

    const items = assistantTurn(parseTrace(jsonl)).items;
    expect(items.map((i) => i.type)).toEqual(['tool', 'hook']);
    expect(items[1]).toMatchObject({
      hookEvent: 'PostToolUse',
      hookName: 'PostToolUse:Read',
    });
    // The hook did not break the pairing that spans it.
    expect(items[0].toolResult).toBe('contents');
  });

  it('gives every turn a distinct id', () => {
    const turns = parseTrace(
      [userLine('a'), assistantLine([{ type: 'text', text: 'b' }]), userLine('c')].join(
        '\n',
      ),
    );
    expect(new Set(turns.map((t) => t.id)).size).toBe(turns.length);
  });
});

// ---- incremental reads ----

describe('parseTraceSlice', () => {
  it('drops the leading partial line when the slice is not at the file start', () => {
    const text = ['contents"}]}}', userLine('a real turn')].join('\n');
    expect(parseTraceSlice(text, false)).toHaveLength(1);
    // At the file start that first line is genuine garbage, but the JSON guard
    // skips it rather than throwing.
    expect(parseTraceSlice(text, true)).toHaveLength(1);
  });

  it('survives a truncated final line', () => {
    const text = [userLine('complete'), '{"type":"assistant","mess'].join('\n');
    expect(parseTraceSlice(text, true)).toHaveLength(1);
  });

  it('appends cleanly across two slices', () => {
    const first = parseTraceSlice([userLine('go'), assistantLine([READ_CALL])].join('\n'), true);
    const second = parseTraceSlice(toolResultLine('toolu_01A', 'ok'), false);
    // The second slice's first line is dropped as partial, so re-add it whole:
    const rest = parseTraceSlice(['', toolResultLine('toolu_01A', 'ok')].join('\n'), false);
    expect(second).toHaveLength(0);

    const turns = buildTurns([...first, ...rest]);
    expect(assistantTurn(turns).items[0].toolResult).toBe('ok');
  });

  it('returns nothing for an empty transcript', () => {
    expect(parseTrace('')).toEqual([]);
    expect(parseTrace('\n\n')).toEqual([]);
  });
});
