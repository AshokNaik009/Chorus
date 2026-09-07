/**
 * Session index — turn the Claude Code transcript store (`~/.claude/projects/`)
 * into a browsable list of past conversations that a pane can resume.
 *
 * Pure + framework-agnostic, exactly like context-health.ts: the host owns
 * `~/.claude` and hands us bytes. Crucially the host reads only the HEAD and
 * TAIL of each `.jsonl` — the identity fields (`cwd`, `gitBranch`, `version`,
 * the first prompt) are written on the earliest message lines, and the display
 * fields (`ai-title`, `last-prompt`) are rewritten on every turn, so the newest
 * copy is near the end. Skipping the middle is what keeps a 12 MB transcript off
 * the critical path.
 *
 * The entry format is internal to Claude Code and changes between versions, so
 * every field access here is optional and every unparseable line is skipped. A
 * transcript we can't read degrades to "no row", never to a throw.
 */

/** How much of a transcript the host reads from each end. */
export const HEAD_BYTES = 64 * 1024;
export const TAIL_BYTES = 64 * 1024;

/** What the host knows about a transcript file before parsing it. */
export interface SessionFileRef {
  /** The Claude conversation id — the `.jsonl` basename. */
  id: string;
  /** Absolute path of the transcript. */
  path: string;
  bytes: number;
  /** Last-modified epoch ms; the session's "last active". */
  mtime: number;
}

/** One resumable Claude Code conversation. */
export interface SessionMeta {
  claudeSessionId: string;
  path: string;
  /** The directory the conversation ran in — `--resume` only works from here. */
  cwd: string;
  gitBranch?: string;
  /** Claude's own generated title (`ai-title`), when it wrote one. */
  title?: string;
  /** First real user turn, cleaned of command/reminder wrappers. */
  firstPrompt?: string;
  /** Most recent user turn (`last-prompt`), when recorded. */
  lastPrompt?: string;
  /** Claude Code version that wrote the transcript, e.g. "2.1.220". */
  version?: string;
  mtime: number;
  bytes: number;
}

/** A Claude Code process running right now (from `claude agents --json`). */
export interface LiveSession {
  pid: number;
  sessionId: string;
  cwd: string;
  name?: string;
  /** e.g. 'idle' | 'busy'. Free-form — the CLI owns this vocabulary. */
  status?: string;
}

/** Sessions of one project directory, newest first. */
export interface ProjectGroup {
  dir: string;
  sessions: SessionMeta[];
  /** mtime of the newest session in the group. */
  lastActive: number;
}

/**
 * Host capability for reading the machine's Claude Code session store. Injected
 * into <App> like SessionArchive/SwarmWorkspace; absent on hosts that can't
 * reach `~/.claude` (web), where the SESSIONS panel simply doesn't render.
 */
export interface SessionCatalog {
  /** Every readable session, newest first. `limit` caps the newest N. */
  listSessions(opts?: { limit?: number }): Promise<SessionMeta[]>;
  /** Conversations with a live `claude` process right now. `[]` when unknown. */
  liveSessions(): Promise<LiveSession[]>;
}

// ---- parsing ----

type Entry = Record<string, unknown>;

/** Parse the JSONL lines we can; truncated head/tail edges are skipped. */
function* entries(text: string): Generator<Entry> {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(t);
    } catch {
      continue; // partial line at a read boundary, or garbled — keep going.
    }
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) yield obj as Entry;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/**
 * Strip the machinery the CLI wraps around a user turn (slash-command markers,
 * caveats, injected reminders) so a title reads like something a human typed.
 * A turn that is nothing but machinery cleans to '' and is passed over.
 */
export function cleanPromptText(raw: string): string {
  return raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, ' ')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, ' ')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, ' ')
    .replace(/<command-(?:name|args)>([\s\S]*?)<\/command-(?:name|args)>/g, ' $1 ')
    .replace(/<\/?[a-zA-Z][^>]{0,60}>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The text of a user turn: `content` is a bare string or a content-block array. */
function userText(entry: Entry): string {
  const msg = entry.message as Entry | undefined;
  const content = msg?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (p && typeof p === 'object' ? (p as Entry) : {}))
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('\n');
}

/** A real user turn — not a tool result, a sidechain (subagent), or CLI meta. */
function isUserPrompt(entry: Entry): boolean {
  return (
    entry.type === 'user' &&
    entry.isMeta !== true &&
    entry.isSidechain !== true &&
    entry.toolUseResult === undefined
  );
}

/** Cut to `max` chars on a word boundary where possible, with an ellipsis. */
export function truncateText(s: string, max = 72): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

/**
 * Build a session row from the two ends of its transcript. Returns null when the
 * file carries no `cwd` — resume is scoped to the conversation's own directory,
 * so a row we can't place is a row we can't act on.
 *
 * Title precedence: newest `ai-title` (tail, then head) → newest `last-prompt`
 * → the first user turn. Every source is optional; a session with none still
 * lists, identified by its id.
 */
export function parseSessionMeta(
  head: string,
  tail: string,
  file: SessionFileRef,
): SessionMeta | null {
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let version: string | undefined;
  let firstPrompt: string | undefined;
  let headTitle: string | undefined;

  for (const e of entries(head)) {
    cwd ??= str(e.cwd);
    gitBranch ??= str(e.gitBranch);
    version ??= str(e.version);
    if (e.type === 'ai-title') headTitle = str(e.aiTitle) ?? headTitle;
    if (!firstPrompt && isUserPrompt(e)) {
      const text = cleanPromptText(userText(e));
      if (text) firstPrompt = truncateText(text, 160);
    }
  }

  // The tail wins for anything Claude rewrites each turn (title, last prompt),
  // and backfills identity for a transcript whose head we couldn't read.
  let tailTitle: string | undefined;
  let lastPrompt: string | undefined;
  for (const e of entries(tail)) {
    if (e.type === 'ai-title') tailTitle = str(e.aiTitle) ?? tailTitle;
    if (e.type === 'last-prompt') {
      const p = str(e.lastPrompt);
      if (p) lastPrompt = truncateText(cleanPromptText(p), 160);
    }
    cwd ??= str(e.cwd);
    gitBranch ??= str(e.gitBranch);
    version ??= str(e.version);
  }

  if (!cwd) return null;

  const title = tailTitle ?? headTitle ?? lastPrompt ?? firstPrompt;

  return {
    claudeSessionId: file.id,
    path: file.path,
    cwd,
    mtime: file.mtime,
    bytes: file.bytes,
    ...(gitBranch ? { gitBranch } : {}),
    ...(version ? { version } : {}),
    ...(title ? { title: truncateText(title, 90) } : {}),
    ...(firstPrompt ? { firstPrompt } : {}),
    ...(lastPrompt ? { lastPrompt } : {}),
  };
}

// ---- shaping for the panel ----

/** What a row shows: the best available label for a session. */
export function sessionDisplayTitle(meta: SessionMeta): string {
  return (
    meta.title ??
    meta.firstPrompt ??
    meta.lastPrompt ??
    `session ${meta.claudeSessionId.slice(0, 8)}`
  );
}

/** Group sessions by their directory; groups and rows both newest-first. */
export function groupSessionsByProject(metas: SessionMeta[]): ProjectGroup[] {
  const byDir = new Map<string, SessionMeta[]>();
  for (const m of metas) {
    const list = byDir.get(m.cwd);
    if (list) list.push(m);
    else byDir.set(m.cwd, [m]);
  }
  const groups: ProjectGroup[] = [];
  for (const [dir, sessions] of byDir) {
    const sorted = sessions.slice().sort((a, b) => b.mtime - a.mtime);
    groups.push({ dir, sessions: sorted, lastActive: sorted[0]?.mtime ?? 0 });
  }
  return groups.sort((a, b) => b.lastActive - a.lastActive);
}

/** Free-text filter across the title, the folder and the branch. */
export function matchesSessionFilter(meta: SessionMeta, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    sessionDisplayTitle(meta),
    meta.cwd,
    meta.gitBranch ?? '',
    meta.firstPrompt ?? '',
  ]
    .join(' ')
    .toLowerCase();
  return q.split(/\s+/).every((term) => hay.includes(term));
}

/**
 * Parse `claude agents --json`. Unknown/renamed fields degrade to "not live"
 * rather than to an error — liveness is a hint, and an old CLI must not break
 * the panel.
 */
export function parseLiveSessions(json: string): LiveSession[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: LiveSession[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const a = item as Entry;
    const sessionId = str(a.sessionId);
    const cwd = str(a.cwd);
    if (!sessionId || !cwd) continue;
    out.push({
      pid: typeof a.pid === 'number' ? a.pid : 0,
      sessionId,
      cwd,
      ...(str(a.name) ? { name: str(a.name)! } : {}),
      ...(str(a.status) ? { status: str(a.status)! } : {}),
    });
  }
  return out;
}
