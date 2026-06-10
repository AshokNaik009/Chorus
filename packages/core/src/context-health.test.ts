import { describe, expect, it } from 'vitest';
import {
  buildHandoffBrief,
  computeContextHealth,
  contextHealthFromTranscript,
  contextWindowFor,
  DEFAULT_THRESHOLDS,
  occupiedTokens,
  parseLatestUsage,
  resolveThresholds,
  type TranscriptUsage,
} from './context-health';

/** A real-shaped assistant transcript line. */
function assistantLine(usage: Record<string, unknown>, model = 'claude-opus-4-8') {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', model, usage },
  });
}

describe('contextWindowFor', () => {
  it('maps the 1M families', () => {
    expect(contextWindowFor('claude-opus-4-8')).toBe(1_000_000);
    expect(contextWindowFor('claude-opus-4-6')).toBe(1_000_000);
    expect(contextWindowFor('claude-sonnet-4-6')).toBe(1_000_000);
  });

  it('maps Haiku 4.5 (incl. date suffix) to 200K', () => {
    expect(contextWindowFor('claude-haiku-4-5')).toBe(200_000);
    expect(contextWindowFor('claude-haiku-4-5-20251001')).toBe(200_000);
  });

  it('tolerates a provider prefix', () => {
    expect(contextWindowFor('us.anthropic.claude-opus-4-8')).toBe(1_000_000);
  });

  it('falls back to 200K for unknown / missing ids', () => {
    expect(contextWindowFor(undefined)).toBe(200_000);
    expect(contextWindowFor('gpt-9')).toBe(200_000);
  });
});

describe('occupiedTokens', () => {
  it('sums input + cache read + cache creation (not the bare input field)', () => {
    const u: TranscriptUsage = {
      inputTokens: 131,
      cacheReadTokens: 8704,
      cacheCreationTokens: 29830,
      outputTokens: 711,
    };
    expect(occupiedTokens(u)).toBe(38665);
  });
});

describe('parseLatestUsage', () => {
  it('reads the last assistant turn carrying usage', () => {
    const jsonl = [
      assistantLine({ input_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 }),
      JSON.stringify({ type: 'user', message: { role: 'user' } }),
      assistantLine({ input_tokens: 2, cache_read_input_tokens: 38534, cache_creation_input_tokens: 1057, output_tokens: 305 }),
    ].join('\n');
    const u = parseLatestUsage(jsonl);
    expect(u).toEqual({
      inputTokens: 2,
      cacheReadTokens: 38534,
      cacheCreationTokens: 1057,
      outputTokens: 305,
      model: 'claude-opus-4-8',
    });
  });

  it('skips a garbled / partially-flushed trailing line', () => {
    const jsonl = [
      assistantLine({ input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 }),
      '{"type":"assistant","message":{"usage":{"input_tokens":7', // truncated
    ].join('\n');
    expect(parseLatestUsage(jsonl)?.cacheReadTokens).toBe(100);
  });

  it('returns null when no assistant usage exists', () => {
    expect(parseLatestUsage('')).toBeNull();
    expect(parseLatestUsage(JSON.stringify({ type: 'user' }))).toBeNull();
  });
});

describe('resolveThresholds', () => {
  it('defaults to 50% / 70%', () => {
    expect(resolveThresholds({})).toEqual({ handoff: 0.7, watch: 0.5 });
  });

  it('accepts a percent or a fraction', () => {
    expect(resolveThresholds({ CHORUS_HANDOFF_PCT: '80' })).toEqual({ handoff: 0.8, watch: 0.5 });
    expect(resolveThresholds({ CHORUS_HANDOFF_PCT: '0.8' }).handoff).toBe(0.8);
  });

  it('clamps watch to <= handoff so tiers stay ordered', () => {
    const t = resolveThresholds({ CHORUS_HANDOFF_PCT: '40', CHORUS_HANDOFF_WATCH_PCT: '60' });
    expect(t.handoff).toBe(0.4);
    expect(t.watch).toBe(0.4);
  });

  it('ignores junk values', () => {
    expect(resolveThresholds({ CHORUS_HANDOFF_PCT: 'nope' })).toEqual(DEFAULT_THRESHOLDS);
    expect(resolveThresholds({ CHORUS_HANDOFF_PCT: '-5' })).toEqual(DEFAULT_THRESHOLDS);
  });
});

describe('computeContextHealth', () => {
  const usage = (occupiedOnWindow: number, model: string): TranscriptUsage => ({
    inputTokens: occupiedOnWindow,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    model,
  });

  it('healthy below the watch line', () => {
    const h = computeContextHealth(usage(70_000, 'claude-opus-4-8')); // 7% of 1M
    expect(h.tier).toBe('healthy');
    expect(h.pct).toBeCloseTo(0.07, 5);
  });

  it('watch in the 50–70% band', () => {
    expect(computeContextHealth(usage(120_000, 'claude-haiku-4-5')).tier).toBe('watch'); // 60% of 200K
  });

  it('hand off at/above 70%', () => {
    expect(computeContextHealth(usage(140_000, 'claude-haiku-4-5')).tier).toBe('handoff'); // 70% of 200K
  });

  it('the same 130K reads differently per window', () => {
    expect(computeContextHealth(usage(130_000, 'claude-haiku-4-5')).tier).toBe('watch'); // 65% of 200K
    expect(computeContextHealth(usage(130_000, 'claude-opus-4-8')).tier).toBe('healthy'); // 13% of 1M
  });

  it('clamps pct to 1 when over the window', () => {
    expect(computeContextHealth(usage(500_000, 'claude-haiku-4-5')).pct).toBe(1);
  });
});

describe('contextHealthFromTranscript', () => {
  it('end-to-end from raw JSONL', () => {
    const jsonl = assistantLine(
      { input_tokens: 2, cache_read_input_tokens: 38534, cache_creation_input_tokens: 1057 },
      'claude-haiku-4-5',
    );
    const h = contextHealthFromTranscript(jsonl)!;
    expect(h.occupied).toBe(39593);
    expect(h.windowMax).toBe(200_000);
    expect(h.tier).toBe('healthy');
  });

  it('null when no usage yet', () => {
    expect(contextHealthFromTranscript('')).toBeNull();
  });
});

describe('buildHandoffBrief', () => {
  it('fills the mechanical header and keeps the structured headings', () => {
    const brief = buildHandoffBrief({
      title: 'feat/foo pane',
      cwd: '/work/repo',
      sessionId: 'abc-123',
      health: { occupied: 700_000, windowMax: 1_000_000, pct: 0.7, tier: 'handoff', model: 'claude-opus-4-8' },
      now: new Date('2026-06-09T00:00:00.000Z'),
    });
    expect(brief).toContain('Context at 70% of the 1,000,000-token window');
    expect(brief).toContain('claude --resume abc-123');
    expect(brief).toContain('/work/repo');
    expect(brief).toContain('2026-06-09T00:00:00.000Z');
    for (const h of ['## Goal & intent', '## Decisions locked', '## State now', '## Next step', '## Landmines', '## Key files & commands']) {
      expect(brief).toContain(h);
    }
  });
});
