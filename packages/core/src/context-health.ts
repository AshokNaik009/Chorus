/**
 * Context-health — turn a Claude Code transcript JSONL into a live "how full is
 * the context window" reading, plus a handoff-brief scaffold for when a pane
 * crosses the red line. Pure + framework-agnostic; the host owns `~/.claude` and
 * only feeds us the transcript text.
 *
 * Health is a PERCENTAGE of the model's effective window, never a fixed token
 * count: the window changed under us (Opus/Sonnet 4.x are 1M tokens now, only
 * Haiku 4.5 is 200K), so a token threshold breaks the moment the model changes.
 * Tiers follow the context-rot research: degradation starts well before the
 * limit, so we warn at ~50% and recommend handing off at ~70% — both env-tunable.
 */

/** Token usage pulled from the latest assistant turn of a transcript. */
export interface TranscriptUsage {
  /** Uncached input remainder for the turn (the bare `input_tokens` field). */
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  /** Model id from the same turn (e.g. "claude-opus-4-8"), if present. */
  model?: string;
}

/** Health tier — color + recommended action escalate with occupancy. */
export type ContextTier = 'healthy' | 'watch' | 'handoff';

/** Fractions (0–1) of the window at which the tier escalates. */
export interface ContextThresholds {
  /** At/above this fraction we recommend handing off (red). */
  handoff: number;
  /** At/above this fraction we warn (yellow). Kept <= `handoff`. */
  watch: number;
}

/** A computed reading for one pane's transcript. */
export interface ContextHealth {
  /** Occupied prefix tokens (input + cache read + cache creation). */
  occupied: number;
  /** Effective window for the model (max input tokens). */
  windowMax: number;
  /** `occupied / windowMax`, clamped to [0, 1]. */
  pct: number;
  tier: ContextTier;
  model?: string;
}

const ONE_MILLION = 1_000_000;
/** Classic Claude window; the fallback for older / unknown model ids. */
const DEFAULT_WINDOW = 200_000;

/**
 * Effective input window (max input tokens) for a model id. Matches by family so
 * date-suffixed (`claude-haiku-4-5-20251001`) and provider-prefixed
 * (`us.anthropic.claude-...`) ids resolve the same. Unknown ids assume the
 * classic 200K — conservative (it can only over-report fullness, never hide it).
 */
export function contextWindowFor(model: string | undefined): number {
  if (!model) return DEFAULT_WINDOW;
  const id = model.toLowerCase();
  if (/opus-4-(6|7|8)\b/.test(id)) return ONE_MILLION;
  if (/sonnet-4-6\b/.test(id)) return ONE_MILLION;
  if (/haiku-4-5\b/.test(id)) return 200_000;
  return DEFAULT_WINDOW;
}

/** Healthy < 50% · Watch 50–70% · Hand off >= 70%. */
export const DEFAULT_THRESHOLDS: ContextThresholds = { handoff: 0.7, watch: 0.5 };

function asFraction(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  // Accept either a fraction (0.7) or a percent (70).
  const frac = n > 1 ? n / 100 : n;
  return Math.min(1, frac);
}

/**
 * Resolve thresholds from env, mirroring `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`:
 * `CHORUS_HANDOFF_PCT` (default 70) and `CHORUS_HANDOFF_WATCH_PCT` (default 50).
 * Each accepts a fraction or a percent. Pure — caller passes the env record.
 * Never throws; `watch` is clamped to <= `handoff` so the tiers stay ordered.
 */
export function resolveThresholds(
  env: Record<string, string | undefined> = {},
): ContextThresholds {
  const handoff = asFraction(env.CHORUS_HANDOFF_PCT, DEFAULT_THRESHOLDS.handoff);
  const watch = Math.min(
    asFraction(env.CHORUS_HANDOFF_WATCH_PCT, DEFAULT_THRESHOLDS.watch),
    handoff,
  );
  return { handoff, watch };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * The real occupied prefix is the WHOLE input the model re-read this turn — the
 * uncached remainder plus everything served from cache — not the bare
 * `input_tokens` field (which omits the cached bulk and badly under-reports).
 */
export function occupiedTokens(u: TranscriptUsage): number {
  return u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens;
}

/**
 * Parse the LATEST assistant turn's usage out of a transcript JSONL (the newest
 * `usage` block is the current prefix size). Tolerates partial/garbled lines —
 * a half-written tail line is skipped, not thrown on. Returns null if no
 * assistant turn carries usage yet.
 */
export function parseLatestUsage(jsonl: string): TranscriptUsage | null {
  const lines = jsonl.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // garbled / partially-flushed line — keep scanning upward.
    }
    const rec = obj as { type?: unknown; message?: Record<string, unknown> };
    if (rec.type !== 'assistant' || !rec.message) continue;
    const usage = rec.message.usage as Record<string, unknown> | undefined;
    if (!usage) continue;
    return {
      inputTokens: num(usage.input_tokens),
      cacheReadTokens: num(usage.cache_read_input_tokens),
      cacheCreationTokens: num(usage.cache_creation_input_tokens),
      outputTokens: num(usage.output_tokens),
      model: typeof rec.message.model === 'string' ? rec.message.model : undefined,
    };
  }
  return null;
}

/** Compute the health reading for a turn's usage against the model's window. */
export function computeContextHealth(
  usage: TranscriptUsage,
  thresholds: ContextThresholds = DEFAULT_THRESHOLDS,
): ContextHealth {
  const windowMax = contextWindowFor(usage.model);
  const occupied = occupiedTokens(usage);
  const pct = windowMax > 0 ? Math.min(1, Math.max(0, occupied / windowMax)) : 0;
  const tier: ContextTier =
    pct >= thresholds.handoff
      ? 'handoff'
      : pct >= thresholds.watch
        ? 'watch'
        : 'healthy';
  return { occupied, windowMax, pct, tier, model: usage.model };
}

/**
 * One call from raw transcript text to a reading, or null if usage isn't
 * available yet. The host (which holds `~/.claude` and the env) composes this.
 */
export function contextHealthFromTranscript(
  jsonl: string,
  thresholds: ContextThresholds = DEFAULT_THRESHOLDS,
): ContextHealth | null {
  const usage = parseLatestUsage(jsonl);
  return usage ? computeContextHealth(usage, thresholds) : null;
}

/** Inputs for a handoff brief — the mechanically-known context for the scaffold. */
export interface HandoffContext {
  title?: string;
  cwd: string;
  /** Claude conversation id, for the `--resume` line. */
  sessionId: string;
  health: ContextHealth;
  /** Injected for deterministic tests; defaults to now. */
  now?: Date;
}

/**
 * Build a handoff-brief scaffold for the next session: the mechanically-known
 * header (occupancy, model, resume command) plus the structured headings whose
 * content only the agent can fill — complete on intent, lean on detail, and
 * limited to what isn't recoverable from the code/git.
 */
export function buildHandoffBrief(ctx: HandoffContext): string {
  const { health } = ctx;
  const pctStr = `${Math.round(health.pct * 100)}%`;
  const when = (ctx.now ?? new Date()).toISOString();
  return [
    `# Handoff brief — ${ctx.title ?? 'session'}`,
    ``,
    `> Context at ${pctStr} of the ${health.windowMax.toLocaleString()}-token ` +
      `window (${health.occupied.toLocaleString()} tokens, ` +
      `${health.model ?? 'unknown model'}) — crossed the hand-off line.`,
    ``,
    `**Resume:** \`claude --resume ${ctx.sessionId}\`  ·  ` +
      `**cwd:** \`${ctx.cwd}\`  ·  **generated:** ${when}`,
    ``,
    `## Goal & intent`,
    `_Why this work exists — the thing a fresh session can't re-derive._`,
    ``,
    `## Decisions locked`,
    `_With the why, so they're not re-litigated._`,
    ``,
    `## State now`,
    `_Done + verified vs. in-flight._`,
    ``,
    `## Next step`,
    `_The single most important thing to do next._`,
    ``,
    `## Landmines`,
    `_Gotchas, dead ends already tried._`,
    ``,
    `## Key files & commands`,
    ``,
  ].join('\n');
}
