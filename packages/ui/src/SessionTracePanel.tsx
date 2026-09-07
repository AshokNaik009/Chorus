import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  TRACE_WINDOW_BYTES,
  buildTurns,
  parseTraceSlice,
  type SessionTraceSource,
  type ToolCategory,
  type TraceItem,
  type TraceMessage,
  type TraceTurn,
} from '@app/core';

export interface SessionTracePanelProps {
  /** Absent on hosts that can't read the transcript store — panel not rendered. */
  source: SessionTraceSource;
  open: boolean;
  onToggleOpen: () => void;
  /**
   * The focused pane's Claude conversation id. Undefined until the CLI reports
   * one (a fresh pane, or a fork whose id hasn't bound yet) — the panel then
   * shows an empty state and starts tracing the moment it arrives.
   */
  claudeSessionId?: string;
  /** The focused pane's folder — locates the transcript's project slug. */
  cwd?: string;
  /** Shown in the header so it's obvious which pane is being traced. */
  paneLabel?: string;
}

/** How often a running session is re-read. Only the appended bytes are fetched. */
const POLL_MS = 2_000;

/** Category → glyph, mirroring cctrace's TUI icon table. */
const CATEGORY_ICON: Record<ToolCategory, string> = {
  read: '▪',
  edit: '▪',
  write: '▪',
  bash: '⚙',
  grep: '⚙',
  glob: '⚙',
  task: '✦',
  tool: '⚙',
  web: '⚙',
  cron: '⚙',
  mcp: '⚙',
  other: '⚙',
};

/** Tool categories that change the world get a warmer colour than the ones that read it. */
const CATEGORY_COLOR: Record<ToolCategory, string> = {
  read: 'var(--fg-muted)',
  edit: 'var(--peach)',
  write: 'var(--peach)',
  bash: 'var(--lavender)',
  grep: 'var(--fg-muted)',
  glob: 'var(--fg-muted)',
  task: 'var(--accent)',
  tool: 'var(--fg-muted)',
  web: 'var(--done)',
  cron: 'var(--fg-muted)',
  mcp: 'var(--done)',
  other: 'var(--fg-muted)',
};

function formatDuration(ms: number): string {
  if (ms <= 0) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function clockTime(ms: number): string {
  if (!ms) return '';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Model ids are long; the family and version are the part worth the pixels. */
function shortModel(model: string): string {
  const m = /claude-([a-z]+)-([\d-]+)/.exec(model);
  return m ? `${m[1]}${m[2].replace(/-/g, '.')}` : model;
}

/** A pre block for raw tool input/result — always scrollable, never page-widening. */
function Pre({ label, body }: { label: string; body: string }) {
  return (
    <div style={{ marginTop: 4 }}>
      <div
        style={{
          color: 'var(--fg-muted)',
          fontSize: 9,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </div>
      <pre
        style={{
          margin: '2px 0 0',
          padding: '4px 6px',
          maxHeight: 220,
          overflow: 'auto',
          background: 'var(--bg-deep)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-inline)',
          color: 'var(--fg-muted)',
          fontFamily: 'var(--mono)',
          fontSize: 10,
          lineHeight: 1.45,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {body}
      </pre>
    </div>
  );
}

/** One item inside a turn: a thought, a chunk of reply, a tool call, or a hook. */
function ItemRow({ item }: { item: TraceItem }) {
  const [open, setOpen] = useState(false);

  if (item.type === 'output' || item.type === 'thinking') {
    const thinking = item.type === 'thinking';
    return (
      <div
        onClick={() => setOpen((v) => !v)}
        title={item.text}
        style={{
          display: 'flex',
          gap: 6,
          padding: '2px 4px',
          cursor: 'pointer',
          borderRadius: 4,
          color: thinking ? 'var(--fg-muted)' : 'var(--fg)',
          fontStyle: thinking ? 'italic' : 'normal',
          fontSize: 11,
        }}
      >
        <span style={{ flexShrink: 0, color: 'var(--fg-muted)' }}>
          {thinking ? '💭' : '▸'}
        </span>
        <span
          style={{
            minWidth: 0,
            ...(open
              ? { whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
              : { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
          }}
        >
          {item.text}
        </span>
      </div>
    );
  }

  if (item.type === 'hook') {
    return (
      <div
        title={item.hookCommand}
        style={{
          display: 'flex',
          gap: 6,
          alignItems: 'baseline',
          padding: '2px 4px',
          color: 'var(--fg-muted)',
          fontSize: 10.5,
        }}
      >
        <span style={{ flexShrink: 0 }}>⑃</span>
        <span style={{ flexShrink: 0, color: 'var(--lavender)' }}>{item.hookEvent}</span>
        <span
          style={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {item.hookName}
        </span>
      </div>
    );
  }

  // A tool call. Orphans are dimmed (they never completed and never will);
  // deferred calls are the live edge of a running session, so they pulse-free
  // but are marked, because "no result yet" and "no result ever" look identical
  // otherwise.
  const category = item.toolCategory ?? 'other';
  const dim = item.orphan === true;
  const expandable = item.toolInput !== undefined || !!item.toolResult;

  return (
    <div style={{ opacity: dim ? 0.45 : 1 }}>
      <div
        onClick={() => expandable && setOpen((v) => !v)}
        title={item.toolSummary}
        style={{
          display: 'flex',
          gap: 6,
          alignItems: 'baseline',
          padding: '2px 4px',
          borderRadius: 4,
          cursor: expandable ? 'pointer' : 'default',
          fontSize: 11,
        }}
      >
        <span style={{ flexShrink: 0, color: CATEGORY_COLOR[category], width: 9 }}>
          {CATEGORY_ICON[category]}
        </span>
        <span style={{ flexShrink: 0, fontWeight: 600, color: 'var(--fg)' }}>
          {item.toolName}
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            color: item.toolError ? 'var(--blocked)' : 'var(--fg-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {item.toolSummary}
        </span>
        {item.deferred && (
          <span style={{ flexShrink: 0, color: 'var(--working)', fontSize: 9 }}>
            running
          </span>
        )}
        {item.orphan && (
          <span style={{ flexShrink: 0, color: 'var(--fg-muted)', fontSize: 9 }}>
            orphan
          </span>
        )}
        {!!item.durationMs && (
          <span style={{ flexShrink: 0, color: 'var(--fg-muted)', fontSize: 9.5 }}>
            {formatDuration(item.durationMs)}
          </span>
        )}
      </div>
      {open && (
        <div style={{ padding: '0 4px 4px 19px' }}>
          {item.toolInput !== undefined && (
            <Pre label="input" body={JSON.stringify(item.toolInput, null, 2)} />
          )}
          {!!item.toolResult && <Pre label="result" body={item.toolResult} />}
        </div>
      )}
    </div>
  );
}

/** One turn: a prompt, a reply with its items, or a system/compaction marker. */
function TurnRow({ turn, expanded, onToggle }: {
  turn: TraceTurn;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (turn.role === 'compact' || turn.role === 'recap') {
    return (
      <div
        title={turn.text}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 6px',
          color: 'var(--fg-muted)',
          fontSize: 10,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
        }}
      >
        <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
        {turn.role === 'recap' ? 'recap' : 'context compacted'}
        <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
      </div>
    );
  }

  if (turn.role === 'user' || turn.role === 'system') {
    const isUser = turn.role === 'user';
    return (
      <div
        onClick={onToggle}
        title={turn.text}
        style={{
          display: 'flex',
          gap: 6,
          padding: '4px 6px',
          cursor: 'pointer',
          borderRadius: 6,
          borderLeft: `2px solid ${
            isUser ? 'var(--accent)' : turn.isError ? 'var(--blocked)' : 'var(--surface1)'
          }`,
          background: isUser ? 'var(--bg-elevated)' : 'transparent',
          fontSize: 11,
        }}
      >
        <span style={{ flexShrink: 0, color: 'var(--fg-muted)' }}>
          {isUser ? '👤' : '⌥'}
        </span>
        <span
          style={{
            minWidth: 0,
            color: isUser ? 'var(--fg)' : 'var(--fg-muted)',
            ...(expanded
              ? { whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
              : { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
          }}
        >
          {turn.text || (isUser ? '(empty prompt)' : '(no output)')}
        </span>
      </div>
    );
  }

  // An assistant turn. The header carries what the whole turn cost; the items
  // are what it actually did. Thinking is shown as a COUNT because Claude Code
  // redacts extended-thinking bodies to a signature — there is nothing to read.
  const occupied = turn.usage
    ? turn.usage.inputTokens + turn.usage.cacheReadTokens + turn.usage.cacheCreationTokens
    : 0;
  const toolCount = turn.items.filter((i) => i.type === 'tool').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div
        className="sb-row"
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 6,
          padding: '4px 6px',
          cursor: 'pointer',
          borderRadius: 6,
        }}
      >
        <span style={{ flexShrink: 0, color: 'var(--fg-muted)', fontSize: 9, width: 8 }}>
          {expanded ? '▾' : '▸'}
        </span>
        <span style={{ flexShrink: 0 }}>🤖</span>
        <span style={{ flexShrink: 0, fontWeight: 600, fontSize: 11, color: 'var(--fg)' }}>
          {turn.model ? shortModel(turn.model) : 'Claude'}
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            color: 'var(--fg-muted)',
            fontSize: 9.5,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {[
            turn.thinkingCount ? `${turn.thinkingCount} thinking` : '',
            toolCount ? `${toolCount} tools` : '',
            occupied ? `${formatTokens(occupied)} tok` : '',
            formatDuration(turn.durationMs),
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </div>

      {expanded && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            margin: '1px 0 3px 12px',
            paddingLeft: 8,
            borderLeft: '1px solid var(--border)',
          }}
        >
          {turn.items.length === 0 ? (
            <div style={{ color: 'var(--fg-muted)', fontSize: 10, padding: '2px 4px' }}>
              (no items)
            </div>
          ) : (
            turn.items.map((item, i) => <ItemRow key={`${turn.id}-${i}`} item={item} />)
          )}
        </div>
      )}
    </div>
  );
}

/**
 * SESSION TRACE — what the focused pane's Claude session is actually doing,
 * turn by turn, read straight from its transcript.
 *
 * The terminal shows the agent's rendered output; this shows its structure —
 * every tool call with its input, result, and duration, including the ones that
 * scrolled past. It follows the live session: each poll fetches only the bytes
 * appended since the last one, so keeping up with a running agent costs the
 * delta rather than a re-read.
 *
 * Parsing is entirely `@app/core`'s `session-trace`; this component only
 * accumulates classified messages and renders the turns built from them.
 */
export function SessionTracePanel({
  source,
  open,
  onToggleOpen,
  claudeSessionId,
  cwd,
  paneLabel,
}: SessionTracePanelProps) {
  const [messages, setMessages] = useState<TraceMessage[] | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [follow, setFollow] = useState(true);

  // The read cursor and the conversation it belongs to. Kept in a ref because
  // the poll closure must see the newest offset without re-subscribing.
  const cursor = useRef<{ key: string; end: number } | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);

  const key = claudeSessionId && cwd ? `${claudeSessionId}@${cwd}` : '';

  // A new conversation (pane focus moved, or an id finally bound) invalidates
  // everything: the old cursor points into a different file.
  useEffect(() => {
    cursor.current = null;
    setMessages(null);
    setTruncated(false);
    setCollapsed(new Set());
  }, [key]);

  const poll = useCallback(async () => {
    if (!claudeSessionId || !cwd) return;
    const at = cursor.current;
    const from = at && at.key === key ? at.end : undefined;

    // A first read (from === undefined) takes the tail; later ones take only
    // what was appended. Nothing is read at all until the panel is opened.
    if (from === undefined) setLoading(true);
    try {
      const slice = await source.readTrace({
        claudeSessionId,
        cwd,
        ...(from === undefined ? {} : { from }),
        maxBytes: TRACE_WINDOW_BYTES,
      });
      if (!slice) return;
      // Nothing appended since last time — the common case while idle.
      if (from !== undefined && slice.end <= from) return;

      const atFileStart = slice.start === 0;
      const parsed = parseTraceSlice(slice.text, atFileStart);
      cursor.current = { key, end: slice.end };
      if (from === undefined) setTruncated(!atFileStart);
      setMessages((prev) => (from === undefined ? parsed : [...(prev ?? []), ...parsed]));
    } catch {
      // A host that can't answer leaves the panel as-is rather than blanking it.
    } finally {
      setLoading(false);
    }
  }, [source, claudeSessionId, cwd, key]);

  useEffect(() => {
    if (!open || !key) return;
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(timer);
  }, [open, key, poll]);

  const turns = useMemo(() => (messages ? buildTurns(messages) : []), [messages]);

  // Following pins the view to the newest turn, which is what "watch it work"
  // means. Scrolling up releases the pin so reading history isn't yanked away.
  useEffect(() => {
    if (!follow || !open) return;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, follow, open]);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setFollow(atBottom);
  }, []);

  const toggleTurn = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toolTotal = useMemo(
    () => turns.reduce((n, t) => n + t.items.filter((i) => i.type === 'tool').length, 0),
    [turns],
  );

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        ...(open ? { flex: '1 1 0' } : { flexShrink: 0 }),
        borderTop: '1px solid var(--border)',
      }}
    >
      <div
        className="sb-row"
        onClick={onToggleOpen}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px',
          flexShrink: 0,
          cursor: 'pointer',
        }}
      >
        <span style={{ color: 'var(--fg-muted)', fontSize: 10, width: 8 }}>
          {open ? '▾' : '▸'}
        </span>
        <span className="eyebrow">Session Trace</span>
        {toolTotal > 0 && <span className="sb-count">{toolTotal}</span>}
        {open && paneLabel && (
          <span
            title={paneLabel}
            style={{
              marginLeft: 'auto',
              maxWidth: 90,
              color: 'var(--fg-muted)',
              fontSize: 9.5,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {paneLabel}
          </span>
        )}
      </div>

      {open && (
        <>
          {truncated && (
            <div
              title="This session is longer than the read window; the earliest turns are not shown."
              style={{
                flexShrink: 0,
                padding: '0 12px 4px',
                color: 'var(--fg-muted)',
                fontSize: 9.5,
              }}
            >
              showing the most recent turns
            </div>
          )}
          <div
            ref={scroller}
            onScroll={onScroll}
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              padding: '0 8px 10px',
              display: 'flex',
              flexDirection: 'column',
              gap: 1,
            }}
          >
            {!key ? (
              <div
                style={{
                  color: 'var(--fg-muted)',
                  fontSize: 11,
                  padding: '8px',
                  lineHeight: 1.5,
                }}
              >
                No Claude session on this pane yet.
                <div style={{ marginTop: 4, fontSize: 10 }}>
                  Tracing starts once the CLI reports its conversation id.
                </div>
              </div>
            ) : messages === null ? (
              <div style={{ color: 'var(--fg-muted)', fontSize: 11, padding: '6px 8px' }}>
                {loading ? 'reading transcript…' : ''}
              </div>
            ) : turns.length === 0 ? (
              <div style={{ color: 'var(--fg-muted)', fontSize: 11, padding: '6px 8px' }}>
                nothing recorded yet
              </div>
            ) : (
              turns.map((turn) => (
                <TurnRow
                  key={turn.id}
                  turn={turn}
                  // Assistant turns start expanded — the items ARE the trace.
                  // Collapsing is opt-in and remembered per turn.
                  expanded={!collapsed.has(turn.id)}
                  onToggle={() => toggleTurn(turn.id)}
                />
              ))
            )}
          </div>
          {turns.length > 0 && (
            <div
              style={{
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 12px 8px',
                color: 'var(--fg-muted)',
                fontSize: 9.5,
              }}
            >
              <span>{turns.length} turns</span>
              <span>·</span>
              <span>{clockTime(turns[turns.length - 1].timestamp)}</span>
              {!follow && (
                <button
                  className="sb-act"
                  onClick={() => setFollow(true)}
                  style={{
                    marginLeft: 'auto',
                    background: 'transparent',
                    border: '1px solid var(--line-strong)',
                    borderRadius: 'var(--radius-inline)',
                    color: 'var(--fg-muted)',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    fontSize: 9,
                    padding: '1px 5px',
                  }}
                >
                  follow
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
