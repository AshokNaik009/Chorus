/**
 * Session trace — turn one Claude Code transcript into the turn-by-turn record
 * of what the agent actually did: prompts, replies, thinking, and every tool
 * call paired with its result.
 *
 * Where `session-index.ts` reads the two ENDS of every transcript to answer
 * "which conversations exist", this reads the BODY of ONE transcript to answer
 * "what happened in it". Same contract though: pure, framework-agnostic, and the
 * host hands us bytes — nothing here touches a filesystem.
 *
 * The pipeline is ported from claude-code-trace (`src-tauri/src/parser/`), whose
 * three stages we keep intact because each earns its place against the real
 * format:
 *
 *   1. classify  — one JSONL entry → one semantic message, or nothing. This is
 *      where the format's noise lives: structural entries with no conversational
 *      content, CLI-injected meta turns, command-output wrappers.
 *   2. assemble  — consecutive assistant entries merge into ONE turn, because a
 *      single reply is written as many entries (text, then thinking, then a
 *      tool_use each). A turn is the unit a human recognises.
 *   3. pair      — a `tool_use` block finds its `tool_result`, which arrives
 *      LATER, in a following user-role entry. Duration is the gap between them.
 *
 * Subagent/team reconstruction (cctrace's stages 4-5) is deliberately not ported:
 * it needs the sidechain transcripts and a four-phase linking heuristic, and the
 * panel this feeds shows one pane's own session. Its `suppress_inflated_durations`
 * pass goes with them — it exists to hide overlapping wall-clock times on
 * concurrent Task spawns. Verified against this machine's store: parallel tool
 * calls are each written as their OWN assistant entry with their own timestamp,
 * and results carry independent timestamps that arrive out of order, so the
 * id-keyed pairing below yields a real per-call duration with nothing to suppress.
 *
 * Every field access is optional and every unparseable line is skipped. The
 * entry format is internal to Claude Code and changes between versions, so a
 * transcript we can't fully read degrades to fewer turns, never to a throw.
 */

// ---- tool taxonomy ----

/**
 * Broad functional group for a tool call, driving the row's icon and colour.
 * Ported from cctrace's `taxonomy.rs`; the surprises are load-bearing:
 * `NotebookEdit` is a Write (it replaces a cell, it doesn't patch text), and
 * `SendMessage` is a Task (cross-agent messaging, not a local utility).
 */
export type ToolCategory =
  | 'read'
  | 'edit'
  | 'write'
  | 'bash'
  | 'grep'
  | 'glob'
  | 'task'
  | 'tool'
  | 'web'
  | 'cron'
  | 'mcp'
  | 'other';

const CATEGORY_BY_NAME: Record<string, ToolCategory> = {
  Read: 'read',
  Edit: 'edit',
  Write: 'write',
  NotebookEdit: 'write',
  Bash: 'bash',
  PowerShell: 'bash',
  Grep: 'grep',
  Glob: 'glob',
  Task: 'task',
  Agent: 'task',
  TaskCreate: 'task',
  TaskUpdate: 'task',
  TaskList: 'task',
  TaskGet: 'task',
  TaskStop: 'task',
  TaskOutput: 'task',
  TeamCreate: 'task',
  TeamDelete: 'task',
  SendMessage: 'task',
  Skill: 'tool',
  ToolSearch: 'tool',
  LSP: 'tool',
  TodoWrite: 'tool',
  Monitor: 'tool',
  AskUserQuestion: 'tool',
  ListMcpResourcesTool: 'tool',
  ReadMcpResourceTool: 'tool',
  EnterPlanMode: 'tool',
  ExitPlanMode: 'tool',
  EnterWorktree: 'tool',
  ExitWorktree: 'tool',
  Cd: 'tool',
  WebFetch: 'web',
  WebSearch: 'web',
  CronCreate: 'cron',
  CronDelete: 'cron',
  CronList: 'cron',
};

/** Map a raw tool name to its category. Unknown names are `other`, never a throw. */
export function categorizeToolName(name: string): ToolCategory {
  const known = CATEGORY_BY_NAME[name];
  if (known) return known;
  return name.startsWith('mcp__') ? 'mcp' : 'other';
}

/**
 * Split `mcp__<server>__<tool>` into its two halves. Returns null unless BOTH
 * halves are non-empty — `mcp____tool` looks like the pattern but names no
 * server, and is better treated as an unknown tool than as a nameless MCP one.
 */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__')) return null;
  const rest = name.slice('mcp__'.length);
  const sep = rest.indexOf('__');
  if (sep < 0) return null;
  const server = rest.slice(0, sep);
  const tool = rest.slice(sep + 2);
  if (!server || !tool) return null;
  return { server, tool };
}

/** Row label for a tool: MCP tools show their server, everything else its name. */
export function mcpDisplayName(name: string): string {
  const parsed = parseMcpToolName(name);
  return parsed ? `MCP ${parsed.server}` : name;
}

// ---- tool summaries ----

const ELLIPSIS = '…';

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max).trimEnd() + ELLIPSIS;
}

/** Last `keep` path segments — a summary column has no room for an absolute path. */
function shortPath(p: string, keep = 2): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts.length <= keep ? p : parts.slice(-keep).join('/');
}

function fieldStr(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  return typeof v === 'string' ? v : '';
}

function fieldNum(input: Record<string, unknown>, key: string): number {
  const v = input[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function countLines(s: string): number {
  return s.split('\n').length;
}

/**
 * A one-line, human-readable description of what a tool call is doing, shown on
 * the collapsed row. Ported from cctrace's `summary.rs`: the point is that the
 * useful part of a call differs per tool — a file path for Read, the command for
 * Bash, the pattern for Grep — so a generic "show the input" row reads as noise.
 *
 * Falls back to the tool name whenever the input isn't a plain object or the
 * expected field is missing, which is also what an unknown//third-party tool gets.
 */
export function toolSummary(name: string, input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return name;
  const f = input as Record<string, unknown>;

  switch (name) {
    case 'Read': {
      const fp = fieldStr(f, 'file_path');
      if (!fp) return 'Read';
      const short = shortPath(fp);
      const limit = fieldNum(f, 'limit');
      if (limit > 0) {
        const offset = fieldNum(f, 'offset') || 1;
        return `${short} · lines ${offset}-${offset + limit - 1}`;
      }
      return short;
    }
    case 'Write': {
      const fp = fieldStr(f, 'file_path');
      if (!fp) return 'Write';
      const content = fieldStr(f, 'content');
      return content
        ? `${shortPath(fp)} · ${countLines(content)} lines`
        : shortPath(fp);
    }
    case 'Edit': {
      const fp = fieldStr(f, 'file_path');
      if (!fp) return 'Edit';
      const short = shortPath(fp);
      const oldStr = fieldStr(f, 'old_string');
      const newStr = fieldStr(f, 'new_string');
      if (oldStr && newStr) {
        const a = countLines(oldStr);
        const b = countLines(newStr);
        return a === b ? `${short} · ${a} line${a > 1 ? 's' : ''}` : `${short} · ${a}→${b} lines`;
      }
      return short;
    }
    case 'NotebookEdit': {
      const fp = fieldStr(f, 'notebook_path') || fieldStr(f, 'file_path');
      return fp ? shortPath(fp) : 'NotebookEdit';
    }
    case 'Bash':
    case 'PowerShell': {
      // The description is the agent's own summary of intent; the command is
      // what actually ran. Both together beat either alone.
      const desc = fieldStr(f, 'description');
      const cmd = fieldStr(f, 'command');
      if (desc && cmd) return truncate(`${desc}: ${cmd}`, 60);
      if (desc) return truncate(desc, 60);
      if (cmd) return truncate(cmd, 60);
      return name;
    }
    case 'Grep': {
      const pattern = fieldStr(f, 'pattern');
      if (!pattern) return 'Grep';
      const pat = `"${truncate(pattern, 30)}"`;
      const glob = fieldStr(f, 'glob');
      if (glob) return `${pat} in ${glob}`;
      const p = fieldStr(f, 'path');
      return p ? `${pat} in ${shortPath(p)}` : pat;
    }
    case 'Glob': {
      const pattern = fieldStr(f, 'pattern');
      if (!pattern) return 'Glob';
      const p = fieldStr(f, 'path');
      return p ? `${pattern} in ${shortPath(p)}` : pattern;
    }
    case 'Task':
    case 'Agent': {
      const type = fieldStr(f, 'subagent_type');
      const desc = fieldStr(f, 'description');
      if (type && desc) return `${type} · ${truncate(desc, 40)}`;
      return truncate(type || desc, 50) || name;
    }
    case 'WebFetch': {
      const url = fieldStr(f, 'url');
      return url ? truncate(url, 60) : 'WebFetch';
    }
    case 'WebSearch': {
      const q = fieldStr(f, 'query');
      return q ? truncate(q, 60) : 'WebSearch';
    }
    case 'TodoWrite': {
      const todos = f.todos;
      return Array.isArray(todos) ? `${todos.length} todos` : 'TodoWrite';
    }
    case 'Skill': {
      const skill = fieldStr(f, 'skill');
      return skill || 'Skill';
    }
    case 'ToolSearch': {
      const q = fieldStr(f, 'query');
      return q ? truncate(q, 50) : 'ToolSearch';
    }
    case 'AskUserQuestion': {
      const qs = f.questions;
      return Array.isArray(qs) && qs.length ? `${qs.length} question(s)` : 'AskUserQuestion';
    }
    case 'TaskCreate': {
      const subject = fieldStr(f, 'subject');
      const agent = fieldStr(f, 'agentType');
      return subject ? `Create: ${truncate(subject, 40)}${agent ? ` → ${agent}` : ''}` : 'TaskCreate';
    }
    case 'TaskUpdate': {
      const subject = fieldStr(f, 'subject') || fieldStr(f, 'taskId');
      const status = fieldStr(f, 'status');
      return subject ? `Update: ${truncate(subject, 40)}${status ? ` → ${status}` : ''}` : 'TaskUpdate';
    }
    case 'SendMessage': {
      const to = fieldStr(f, 'agentId') || fieldStr(f, 'to');
      const body = fieldStr(f, 'message').split('\n')[0] ?? '';
      return to ? `→ ${to}${body ? `: ${truncate(body, 40)}` : ''}` : 'SendMessage';
    }
    case 'Cd': {
      const p = fieldStr(f, 'path');
      return p ? shortPath(p) : 'Cd';
    }
    case 'CronList':
      return 'List scheduled jobs';
    case 'TaskList':
      return 'List tasks';
    case 'EnterPlanMode':
    case 'ExitPlanMode':
    case 'EnterWorktree':
    case 'ExitWorktree':
      return name;
    default: {
      const mcp = parseMcpToolName(name);
      // MCP tool ids are snake_case machine names; spacing them reads as prose.
      if (mcp) return mcp.tool.replace(/_/g, ' ');
      // Unknown tool: show whichever common field it happens to carry.
      for (const key of ['description', 'path', 'file_path', 'query', 'pattern', 'command']) {
        const v = fieldStr(f, key);
        if (v) return truncate(v, 50);
      }
      return name;
    }
  }
}

// ---- content sanitising ----

const NOISE_TAG_RE =
  /<(system-reminder|local-command-caveat)>[\s\S]*?<\/\1>/gi;
const COMMAND_TAG_RE =
  /<(command-name|command-message|command-args)>[\s\S]*?<\/\1>/gi;
const BASH_INPUT_RE = /<bash-input>([\s\S]*?)<\/bash-input>/gi;
const STDOUT_RE = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/i;
const STDERR_RE = /<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/i;
const BASH_STDOUT_RE = /<bash-stdout>([\s\S]*?)<\/bash-stdout>/i;
const BASH_STDERR_RE = /<bash-stderr>([\s\S]*?)<\/bash-stderr>/i;
const COMMAND_NAME_RE = /<command-name>\/?([^<]+)<\/command-name>/i;
const COMMAND_ARGS_RE = /<command-args>([^<]*)<\/command-args>/i;

/**
 * Turn a raw turn body into what a human should read. Unlike
 * `cleanPromptText` in session-index.ts (which flattens to a single title line)
 * this preserves newlines — a trace row expands to show real content.
 *
 * A slash-command invocation is rewritten to the `/name args` a user typed,
 * because the CLI records it as three sibling tags that read as markup.
 */
export function sanitizeContent(raw: string): string {
  // A pure command invocation: show the command line, not its tags.
  if (raw.startsWith('<command-name>') || raw.startsWith('<command-message>')) {
    const name = COMMAND_NAME_RE.exec(raw);
    if (name?.[1]) {
      const args = COMMAND_ARGS_RE.exec(raw)?.[1]?.trim() ?? '';
      return `/${name[1].trim()}${args ? ` ${args}` : ''}`;
    }
  }
  return raw
    .replace(NOISE_TAG_RE, '')
    .replace(COMMAND_TAG_RE, '')
    .replace(BASH_INPUT_RE, '$1')
    .trim();
}

/** Inner text of a `!`-bang or slash-command's captured output. */
function extractWrappedOutput(raw: string): { text: string; isError: boolean } {
  const stderr = STDERR_RE.exec(raw)?.[1]?.trim() ?? '';
  const stdout = STDOUT_RE.exec(raw)?.[1]?.trim() ?? '';
  const bashErr = BASH_STDERR_RE.exec(raw)?.[1]?.trim() ?? '';
  const bashOut = BASH_STDOUT_RE.exec(raw)?.[1]?.trim() ?? '';
  const err = stderr || bashErr;
  const out = stdout || bashOut;
  return { text: out || err, isError: !!err && !out };
}

// ---- entry reading ----

type Entry = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * Entry types that carry no conversational content — structural bookkeeping the
 * CLI writes for its own resume/rewind/checkpoint machinery. Dropped on sight.
 * Ported verbatim from cctrace's NOISE_ENTRY_TYPES, including the reasons:
 *
 *  - `file-history-snapshot` is pruned by the CLI (v2.1.208+ keeps only the
 *    latest backup per file), so the chain has gaps by design — but conversation
 *    turns chain through their own `parentUuid`, never through snapshots, so
 *    dropping every snapshot leaves the conversation intact.
 *  - `progress` includes the periodic heartbeats (v2.1.214+) emitted every few
 *    seconds during a long tool call. Their only job is to keep the file's mtime
 *    fresh for liveness detection; rendering them would flood the panel.
 *  - `last-prompt` / `rewind-pointer` / `fork-context-ref` are cursors into the
 *    conversation, not part of it.
 */
export const NOISE_ENTRY_TYPES: ReadonlySet<string> = new Set([
  'system',
  'file-history-snapshot',
  'queue-operation',
  'progress',
  'fork-context-ref',
  'workflow-start',
  'workflow-progress',
  'workflow-complete',
  'workflow-cancelled',
  'workflow-error',
  'rewind-pointer',
  'last-prompt',
  'ai-title',
  'mode',
  'permission-mode',
  // Not in cctrace's list — found by sweeping this machine's own store. Both
  // carry bookkeeping only: `file-history-delta` is the per-file backup record
  // that rides alongside `file-history-snapshot`, and `agent-name` labels a
  // background-agent session. Neither has a `message`, so they were already
  // being dropped by the no-role guard; naming them here makes that deliberate
  // rather than incidental.
  'file-history-delta',
  'agent-name',
]);

/** Wrappers whose presence means a user entry is captured output, not a prompt. */
const OUTPUT_TAGS = [
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<bash-stdout>',
  '<bash-stderr>',
  '<task-notification>',
] as const;

const EMPTY_STDOUT = '<local-command-stdout></local-command-stdout>';
const EMPTY_STDERR = '<local-command-stderr></local-command-stderr>';

/** Epoch ms from an entry's ISO timestamp; 0 when absent or unparseable. */
function timestampOf(entry: Entry): number {
  const t = Date.parse(str(entry.timestamp));
  return Number.isFinite(t) ? t : 0;
}

/** Flatten a message body to plain text. `content` is a string OR a block array. */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => obj(b))
    .filter((b): b is Record<string, unknown> => b !== null && b.type === 'text')
    .map((b) => str(b.text))
    .filter(Boolean)
    .join('\n');
}

/**
 * Undo the pre-v2.1.92 streaming bug that JSON-encoded array/object tool-input
 * fields as strings (`"env": "[\"K=v\"]"`). Only re-parses values that actually
 * decode to an array/object, so a string that merely starts with `[` survives.
 */
function normalizeToolInput(input: unknown): unknown {
  const map = obj(input);
  if (!map) return input;
  const out: Record<string, unknown> = { ...map };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v !== 'string') continue;
    const trimmed = v.trimStart();
    if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(v);
      if (parsed && typeof parsed === 'object') out[k] = parsed;
    } catch {
      /* not JSON after all — keep the string */
    }
  }
  return out;
}

/** A tool result's body: a bare string, or an array of text blocks. */
function stringifyResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content
      .map((b) => obj(b))
      .filter((b): b is Record<string, unknown> => b !== null)
      .map((b) => str(b.text))
      .filter(Boolean)
      .join('\n');
    if (text) return text;
  }
  if (content == null) return '';
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return '';
  }
}

// ---- stage 1: classification ----

/** A content block of an assistant turn, already decoded. */
interface Block {
  kind: 'thinking' | 'text' | 'tool_use' | 'tool_result';
  text?: string;
  toolId?: string;
  toolName?: string;
  toolInput?: unknown;
  result?: string;
  isError?: boolean;
}

/** A hook execution recovered from its attachment carrier. */
export interface HookMessage {
  kind: 'hook';
  ts: number;
  hookEvent: string;
  hookName: string;
  command: string;
}

/** An assistant-side message: a model reply, a tool result, or a hook. */
export interface AssistantMessage {
  kind: 'assistant';
  ts: number;
  model: string;
  text: string;
  thinkingCount: number;
  blocks: Block[];
  usage: TraceUsage;
  /**
   * True for entries that are structurally assistant-side but not a model
   * reply: tool results (which the CLI writes as user-role entries) and
   * unknown-but-roled entries. They merge into the surrounding turn without
   * claiming its model or usage.
   */
  isMeta: boolean;
  /** Set when this slot carries a hook rather than content blocks. */
  hook?: HookMessage;
}

/**
 * The intermediate form between an entry and a turn. Exported because the
 * incremental reader accumulates these across polls: appending raw bytes to a
 * classified list is cheap, and turns are rebuilt from it on every render.
 */
export type TraceMessage =
  | { kind: 'user'; ts: number; text: string }
  | AssistantMessage
  | { kind: 'system'; ts: number; output: string; isError: boolean }
  | { kind: 'compact'; ts: number; text: string; isRecap: boolean }
  | HookMessage;

/** Token counts for one assistant turn. */
export interface TraceUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

const EMPTY_USAGE: TraceUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

function usageTotal(u: TraceUsage): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
}

/**
 * `cache_creation_input_tokens` reads 0 whenever the API reports the nested
 * `cache_creation.input_tokens` form instead (v2.1.152+). Taking the max of the
 * two reads both shapes without having to know which version wrote the file.
 */
function readUsage(raw: unknown): TraceUsage {
  const u = obj(raw);
  if (!u) return EMPTY_USAGE;
  const nested = obj(u.cache_creation);
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheCreationTokens: Math.max(
      num(u.cache_creation_input_tokens),
      nested ? num(nested.input_tokens) : 0,
    ),
  };
}

/** Decode an assistant entry's content blocks. */
function assistantBlocks(content: unknown): { thinking: number; blocks: Block[] } {
  if (!Array.isArray(content)) return { thinking: 0, blocks: [] };
  let thinking = 0;
  const blocks: Block[] = [];
  for (const raw of content) {
    const b = obj(raw);
    if (!b) continue;
    switch (str(b.type)) {
      case 'thinking':
        thinking += 1;
        // Extended thinking is often redacted to a signature with empty text.
        // The COUNT still tells the truth about the turn, so it's tracked even
        // when there is no body to show.
        blocks.push({ kind: 'thinking', text: str(b.thinking) });
        break;
      case 'text':
        blocks.push({ kind: 'text', text: str(b.text) });
        break;
      // `server_tool_use` is Anthropic's server-managed call block; same shape.
      case 'tool_use':
      case 'server_tool_use':
        blocks.push({
          kind: 'tool_use',
          toolId: str(b.id),
          toolName: str(b.name),
          toolInput: normalizeToolInput(b.input),
        });
        break;
      default:
        break;
    }
  }
  return { thinking, blocks };
}

/** Decode the `tool_result` blocks carried by a user-role entry. */
function toolResultBlocks(content: unknown): Block[] {
  if (!Array.isArray(content)) return [];
  const out: Block[] = [];
  for (const raw of content) {
    const b = obj(raw);
    if (!b || str(b.type) !== 'tool_result') continue;
    out.push({
      kind: 'tool_result',
      toolId: str(b.tool_use_id),
      result: stringifyResult(b.content),
      isError: b.is_error === true,
    });
  }
  return out;
}

/** CLI-injected user entries that were never typed by a human. */
function isUserNoise(content: unknown, text: string): boolean {
  const trimmed = text.trim();
  // A turn that is ONLY a reminder/caveat is machinery. One that merely starts
  // with a reminder (v2.1.201+ inlines them) has real content after it and must
  // survive — sanitizeContent strips the wrapper later.
  for (const tag of ['<system-reminder>', '<local-command-caveat>']) {
    const close = tag.replace('<', '</');
    if (trimmed.startsWith(tag) && trimmed.endsWith(close)) return true;
  }
  if (trimmed === EMPTY_STDOUT || trimmed === EMPTY_STDERR) return true;
  if (trimmed.startsWith('[Request interrupted by user')) return true;
  if (Array.isArray(content) && content.length === 1) {
    const b = obj(content[0]);
    if (b && str(b.type) === 'text' && str(b.text).startsWith('[Request interrupted by user')) {
      return true;
    }
  }
  return false;
}

/** Does a user entry carry anything a human would recognise as their message? */
function hasUserContent(content: unknown, text: string): boolean {
  if (typeof content === 'string') return text.trim() !== '';
  if (!Array.isArray(content)) return false;
  return content.some((raw) => {
    const b = obj(raw);
    if (!b) return false;
    const t = str(b.type);
    return t === 'text' || t === 'image' || t === 'document';
  });
}

/**
 * Pull a hook event out of an `attachment` entry. Hooks aren't a first-class
 * entry type — they ride inside attachments — so this is a rescue, run before
 * the noise filter would drop the carrier.
 */
function rescueHook(entry: Entry, ts: number): HookMessage | null {
  const att = obj(entry.attachment) ?? obj(entry.data);
  if (!att) return null;
  const hookEvent = str(att.hookEvent) || str(entry.hookEvent);
  if (!hookEvent) return null;
  return {
    kind: 'hook',
    ts,
    hookEvent,
    hookName: str(att.hookName),
    command: str(att.command) || str(att.stdout),
  };
}

/**
 * One JSONL entry → one semantic message, or null to drop it.
 *
 * Order matters here and mirrors cctrace: hooks are rescued from their carrier
 * BEFORE the noise filter runs, and the "unknown type with a role" fallback is
 * last so a future entry type shows up as content rather than vanishing.
 */
export function classifyEntry(entry: Entry): TraceMessage | null {
  const type = str(entry.type);
  const ts = timestampOf(entry);

  // Hooks ride inside attachment/progress carriers that are otherwise noise.
  if (type === 'attachment' || type === 'progress' || entry.hookEvent !== undefined) {
    const hook = rescueHook(entry, ts);
    if (hook) return hook;
  }

  if (NOISE_ENTRY_TYPES.has(type)) return null;

  if (type === 'summary') {
    return { kind: 'compact', ts, text: str(entry.summary), isRecap: false };
  }
  if (type === 'away_summary') {
    return { kind: 'compact', ts, text: str(entry.away_summary), isRecap: true };
  }
  if (type === 'compact_boundary') {
    return { kind: 'compact', ts, text: '', isRecap: false };
  }

  const message = obj(entry.message);
  const content = message?.content;
  const text = extractText(content);

  if (type === 'assistant') {
    // v2.1.166+: a fallbackModel retry writes a null/empty stub for the failed
    // attempt before the real response. A turn with no content is that stub.
    const empty = content == null || (Array.isArray(content) && content.length === 0);
    if (empty) return null;
    if (str(message?.model) === '<synthetic>') return null;
    const { thinking, blocks } = assistantBlocks(content);
    return {
      kind: 'assistant',
      ts,
      model: str(message?.model),
      text: sanitizeContent(text),
      thinkingCount: thinking,
      blocks,
      usage: readUsage(message?.usage),
      isMeta: false,
    };
  }

  if (type === 'user') {
    if (isUserNoise(content, text)) return null;

    // Compaction writes its AI-generated summary as a user entry; it's a
    // boundary marker, not a prompt.
    if (entry.isCompactSummary === true) {
      return { kind: 'compact', ts, text: sanitizeContent(text), isRecap: false };
    }

    const results = toolResultBlocks(content);
    if (results.length) {
      // Tool results are written user-side but belong to the assistant's turn.
      return {
        kind: 'assistant',
        ts,
        model: '',
        text: '',
        thinkingCount: 0,
        blocks: results,
        usage: EMPTY_USAGE,
        isMeta: true,
      };
    }

    const trimmed = text.trim();

    if (entry.isMeta === true) {
      // A Stop hook that exits non-zero has its feedback injected as a meta user
      // turn. Everything else meta is an internal re-prompt marker (v2.1.183+).
      if (trimmed.startsWith('Stop hook feedback:')) {
        const body = trimmed.slice('Stop hook feedback:'.length).trim();
        const match = /^\[([^\]]+)\]:\s*([\s\S]*)$/.exec(body);
        return {
          kind: 'hook',
          ts,
          hookEvent: 'Stop',
          hookName: match?.[1] ?? '',
          command: match?.[2] ?? body,
        };
      }
      return null;
    }

    // Captured command / bash output is system output, not a prompt.
    if (OUTPUT_TAGS.some((tag) => trimmed.startsWith(tag))) {
      const { text: out, isError } = extractWrappedOutput(text);
      return { kind: 'system', ts, output: out, isError };
    }

    if (hasUserContent(content, text)) {
      return { kind: 'user', ts, text: sanitizeContent(text) };
    }
    return null;
  }

  // Unknown type with no role at all: structural metadata (rate_limit_event,
  // CwdChanged, …). Drop it rather than render a blank row.
  if (!message || !str(message.role)) return null;

  // Unknown type WITH a role: surface it as meta content so a future entry type
  // degrades to a visible line instead of silently disappearing.
  return {
    kind: 'assistant',
    ts,
    model: '',
    text: sanitizeContent(text),
    thinkingCount: 0,
    blocks: text ? [{ kind: 'text', text: sanitizeContent(text) }] : [],
    usage: EMPTY_USAGE,
    isMeta: true,
  };
}

// ---- stage 2+3: turn assembly and tool pairing ----

/** What a row in the trace shows. */
export type TraceItemType = 'thinking' | 'output' | 'tool' | 'hook';

/** One element inside a turn — a thought, a chunk of reply, a tool call, a hook. */
export interface TraceItem {
  type: TraceItemType;
  text?: string;
  toolName?: string;
  toolId?: string;
  toolInput?: unknown;
  toolSummary?: string;
  toolCategory?: ToolCategory;
  toolResult?: string;
  toolError?: boolean;
  /** Wall time between the call and its result. */
  durationMs?: number;
  /**
   * A tool call the conversation moved PAST without a result — a rewound or
   * discarded timeline. Shown dimmed; it never really ran to completion.
   */
  orphan?: boolean;
  /** A tool call still in flight when the transcript ends (or deferred). */
  deferred?: boolean;
  hookEvent?: string;
  hookName?: string;
  hookCommand?: string;
}

export type TraceRole = 'user' | 'assistant' | 'system' | 'compact' | 'recap';

/** One visible unit of the conversation. */
export interface TraceTurn {
  /** Stable within a parse — index-based, so React keys survive appends. */
  id: string;
  role: TraceRole;
  /** Epoch ms of the turn's first entry. */
  timestamp: number;
  text: string;
  model?: string;
  thinkingCount: number;
  items: TraceItem[];
  usage?: TraceUsage;
  /** Span from the turn's first entry to its last. */
  durationMs: number;
  isError?: boolean;
}

/**
 * Assemble classified messages into displayable turns.
 *
 * The core move is buffering: consecutive assistant messages accumulate and
 * flush as ONE turn when something else interrupts them, because the CLI writes
 * a single reply as many entries. While buffered, `tool_use` blocks are held in
 * `pending` until a later `tool_result` names their id — which is how a tool
 * call gets both its output and its duration.
 *
 * Whatever is still pending at flush time never got a result, and WHY differs:
 * if a user turn caused the flush, the conversation moved on without it, so it's
 * an orphan from a discarded timeline. Otherwise the transcript simply ends
 * there and the call is still in flight — `deferred`. The distinction matters:
 * an orphan is dead, a deferred call is what a running agent looks like.
 */
export function buildTurns(msgs: TraceMessage[]): TraceTurn[] {
  const turns: TraceTurn[] = [];
  let buffer: AssistantMessage[] = [];

  const flush = (orphanPending: boolean) => {
    if (!buffer.length) return;
    turns.push(mergeAssistant(buffer, orphanPending, turns.length));
    buffer = [];
  };

  for (const msg of msgs) {
    switch (msg.kind) {
      case 'assistant':
        buffer.push(msg);
        break;
      case 'hook':
        // Hooks fire in the middle of an assistant turn; folding them into the
        // buffer keeps them in the order they actually happened.
        buffer.push({
          kind: 'assistant',
          ts: msg.ts,
          model: '',
          text: '',
          thinkingCount: 0,
          blocks: [],
          usage: EMPTY_USAGE,
          isMeta: true,
          hook: msg,
        });
        break;
      case 'user':
        flush(true);
        turns.push({
          id: `t${turns.length}`,
          role: 'user',
          timestamp: msg.ts,
          text: msg.text,
          thinkingCount: 0,
          items: [],
          durationMs: 0,
        });
        break;
      case 'system':
        flush(false);
        turns.push({
          id: `t${turns.length}`,
          role: 'system',
          timestamp: msg.ts,
          text: msg.output,
          thinkingCount: 0,
          items: [],
          durationMs: 0,
          isError: msg.isError,
        });
        break;
      case 'compact':
        flush(false);
        turns.push({
          id: `t${turns.length}`,
          role: msg.isRecap ? 'recap' : 'compact',
          timestamp: msg.ts,
          text: msg.text,
          thinkingCount: 0,
          items: [],
          durationMs: 0,
        });
        break;
    }
  }
  flush(false);
  return turns;
}

/** Collapse a run of assistant messages into one turn, pairing tools as it goes. */
function mergeAssistant(
  buffer: AssistantMessage[],
  orphanPending: boolean,
  index: number,
): TraceTurn {
  const texts: string[] = [];
  const items: TraceItem[] = [];
  const pending = new Map<string, { index: number; ts: number }>();
  let thinkingCount = 0;
  let model = '';

  for (const msg of buffer) {
    if (msg.text) texts.push(msg.text);
    thinkingCount += msg.thinkingCount;
    // Only a real model reply names the turn's model; meta entries (tool
    // results, hooks) must not overwrite it with ''.
    if (!model && !msg.isMeta && msg.model) model = msg.model;

    const hook = msg.hook;
    if (hook) {
      items.push({
        type: 'hook',
        hookEvent: hook.hookEvent,
        hookName: hook.hookName,
        hookCommand: hook.command,
      });
      continue;
    }

    for (const b of msg.blocks) {
      switch (b.kind) {
        case 'thinking':
          // Redacted thinking has no body — the count already recorded it, so
          // emitting an empty row would just be a blank line.
          if (b.text) items.push({ type: 'thinking', text: b.text });
          break;
        case 'text':
          if (b.text) items.push({ type: 'output', text: b.text });
          break;
        case 'tool_use': {
          const name = b.toolName ?? '';
          items.push({
            type: 'tool',
            toolName: mcpDisplayName(name),
            toolId: b.toolId,
            toolInput: b.toolInput,
            toolSummary: toolSummary(name, b.toolInput),
            toolCategory: categorizeToolName(name),
          });
          if (b.toolId) pending.set(b.toolId, { index: items.length - 1, ts: msg.ts });
          break;
        }
        case 'tool_result': {
          const id = b.toolId ?? '';
          const slot = pending.get(id);
          if (slot) {
            pending.delete(id);
            items[slot.index].toolResult = b.result;
            items[slot.index].toolError = b.isError;
            items[slot.index].durationMs = Math.max(0, msg.ts - slot.ts);
          } else if (b.result) {
            // A result whose call isn't in this turn (it was truncated off the
            // front of the window). Show the output rather than lose it.
            items.push({ type: 'output', text: b.result });
          }
          break;
        }
      }
    }
  }

  for (const slot of pending.values()) {
    if (orphanPending) items[slot.index].orphan = true;
    else items[slot.index].deferred = true;
  }

  const first = buffer[0]?.ts ?? 0;
  const last = buffer[buffer.length - 1]?.ts ?? first;

  // The turn's token usage is the LAST real reply's usage: each response reports
  // the whole prefix it read, so the newest is the turn's true cost.
  let usage: TraceUsage | undefined;
  for (let i = buffer.length - 1; i >= 0; i--) {
    const m = buffer[i];
    if (!m.isMeta && usageTotal(m.usage) > 0) {
      usage = m.usage;
      break;
    }
  }

  return {
    id: `t${index}`,
    role: 'assistant',
    timestamp: first,
    text: texts.join('\n'),
    ...(model ? { model } : {}),
    thinkingCount,
    items,
    ...(usage ? { usage } : {}),
    durationMs: Math.max(0, last - first),
  };
}

// ---- slice parsing (the incremental read) ----

/**
 * Classify the entries in a slice of transcript text.
 *
 * `atFileStart` says whether byte 0 of the file is included. When it isn't, the
 * first line is almost certainly cut mid-JSON by the read offset, so it is
 * dropped rather than parsed — the alternative is a garbled turn at the top of
 * every tail read.
 */
export function parseTraceSlice(text: string, atFileStart: boolean): TraceMessage[] {
  const lines = text.split('\n');
  if (!atFileStart) lines.shift();
  const out: TraceMessage[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      continue; // partial line at a read boundary, or garbled — keep going.
    }
    const entry = obj(parsed);
    if (!entry) continue;
    try {
      const msg = classifyEntry(entry);
      if (msg) out.push(msg);
    } catch {
      // A single malformed entry must never cost the whole trace.
    }
  }
  return out;
}

/** Whole-transcript convenience: text in, turns out. */
export function parseTrace(jsonl: string): TraceTurn[] {
  return buildTurns(parseTraceSlice(jsonl, true));
}

// ---- host seam ----

/** What the host was asked to read. */
export interface TraceRequest {
  /** The Claude conversation id — names the `.jsonl`. */
  claudeSessionId: string;
  /** The pane's folder; locates the project slug the transcript lives under. */
  cwd: string;
  /**
   * Byte offset to read from. Omit for "the tail" — the host then returns the
   * last `maxBytes` and reports where that started.
   */
  from?: number;
  /** Cap on bytes returned in one call. */
  maxBytes?: number;
}

/** A window of raw transcript bytes, plus where it sits in the file. */
export interface TraceSlice {
  /** Raw JSONL for `[start, end)`. */
  text: string;
  /** Byte offset where `text` begins; 0 means the file's true start. */
  start: number;
  /** Byte offset just past `text` — pass back as `from` to read what's new. */
  end: number;
  /** Total file size when read, so the caller can tell it fell behind. */
  size: number;
}

/**
 * Host capability for reading ONE transcript's body. Injected into <App> like
 * `SessionCatalog`; a host that can't reach the transcript store simply doesn't
 * provide it and the panel doesn't render.
 *
 * The host is deliberately a byte reader and nothing more — every parsing rule
 * above stays here in core, where it is testable without a filesystem.
 */
export interface SessionTraceSource {
  /** Returns null when the transcript doesn't exist (yet). Never throws. */
  readTrace(req: TraceRequest): Promise<TraceSlice | null>;
}

/** Default window for a first read — enough for a long session's recent history. */
export const TRACE_WINDOW_BYTES = 2 * 1024 * 1024;
