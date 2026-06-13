import { useCallback, useEffect, useState } from 'react';
import type { MergeResult, SessionStatus, WorktreeReview } from '@app/core';
import { StatusBadge } from './StatusBadge.js';

/** A swarm member that produced an isolated worktree + branch (review target). */
export interface ReviewMember {
  sessionId: string;
  role?: string;
  repoDir: string;
  branch: string;
  worktreeDir: string;
}

export interface DiffReviewProps {
  members: ReviewMember[];
  statusOf: (sessionId: string) => SessionStatus | null;
  review: (m: ReviewMember) => Promise<WorktreeReview>;
  /** Merge the branch into the repo's current branch. Resolves the outcome. */
  merge: (m: ReviewMember, squash: boolean) => Promise<MergeResult>;
  /** Discard the worktree + branch. App confirms and drops the member on success. */
  discard: (m: ReviewMember) => Promise<void>;
  onFocusSession: (sessionId: string) => void;
  onClose: () => void;
}

const box: React.CSSProperties = {
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: 14,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};
const primary: React.CSSProperties = {
  background: 'var(--accent)',
  color: 'var(--crust)',
  border: 'none',
  borderRadius: 6,
  padding: '6px 12px',
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: 12,
};
const ghost: React.CSSProperties = {
  background: 'var(--bg-elevated)',
  color: 'var(--fg)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '6px 12px',
  cursor: 'pointer',
  fontSize: 12,
};
const danger: React.CSSProperties = {
  ...ghost,
  borderColor: 'var(--status-waiting)',
  color: 'var(--status-waiting)',
};
const muted: React.CSSProperties = {
  color: 'var(--fg-muted)',
  fontSize: 11.5,
  lineHeight: 1.5,
};
const mono: React.CSSProperties = {
  fontFamily: 'var(--font-mono, monospace)',
  fontSize: 11,
};

type RowState =
  | { phase: 'loading' }
  | { phase: 'loaded'; review: WorktreeReview }
  | { phase: 'busy'; review: WorktreeReview }
  | { phase: 'merged'; review: WorktreeReview; message: string }
  | { phase: 'error'; message: string };

/**
 * Review/merge drawer for a swarm fan-out (the payoff of worktree isolation):
 * one card per agent showing its branch diff summary (files ±, commits, dirty)
 * with one-click Merge / Squash-merge / Discard into the repo's current branch.
 * Desktop-only — rendered only when the host can do real git. Opens as a
 * right-side drawer, matching SwarmPanel.
 */
export function DiffReview(props: DiffReviewProps) {
  const { members, review } = props;
  const [rows, setRows] = useState<Record<string, RowState>>({});

  const load = useCallback(
    (m: ReviewMember) => {
      setRows((p) => ({ ...p, [m.sessionId]: { phase: 'loading' } }));
      review(m)
        .then((r) =>
          setRows((p) => ({ ...p, [m.sessionId]: { phase: 'loaded', review: r } })),
        )
        .catch((e) =>
          setRows((p) => ({
            ...p,
            [m.sessionId]: { phase: 'error', message: (e as Error).message },
          })),
        );
    },
    [review],
  );

  // Fetch a review for every member on open / when the member set changes.
  useEffect(() => {
    for (const m of members) load(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members.map((m) => m.sessionId).join(','), load]);

  const doMerge = (m: ReviewMember, squash: boolean) => {
    setRows((p) => {
      const cur = p[m.sessionId];
      const r = cur && 'review' in cur ? cur.review : undefined;
      return r ? { ...p, [m.sessionId]: { phase: 'busy', review: r } } : p;
    });
    props.merge(m, squash).then((res) => {
      if (res.ok) {
        setRows((p) => {
          const cur = p[m.sessionId];
          const r = cur && 'review' in cur ? cur.review : undefined;
          return r
            ? { ...p, [m.sessionId]: { phase: 'merged', review: r, message: res.message } }
            : p;
        });
      } else {
        // Re-load so the diff reflects the (unchanged) base, and surface the error.
        load(m);
        setRows((p) => ({
          ...p,
          [m.sessionId]: { phase: 'error', message: res.message },
        }));
      }
    });
  };

  return (
    <div
      onClick={props.onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 56,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        justifyContent: 'flex-end',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 520,
          maxWidth: '94%',
          height: '100%',
          overflowY: 'auto',
          background: 'var(--bg-elevated)',
          borderLeft: '1px solid var(--border)',
          padding: 18,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          color: 'var(--fg)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <strong style={{ fontSize: 15 }}>⎇ Review &amp; merge</strong>
          <button onClick={props.onClose} style={{ ...ghost }}>
            Close
          </button>
        </div>
        <div style={muted}>
          Each agent worked on its own branch. Review the diff and land it into the
          repo's current branch (Merge / Squash), or throw it away (Discard).
        </div>

        {members.length === 0 ? (
          <div style={box}>
            <div style={muted}>
              No agent branches to review — the agents shared a directory (the
              fan-out directory wasn't a git repo).
            </div>
          </div>
        ) : (
          members.map((m) => {
            const st = props.statusOf(m.sessionId);
            const row = rows[m.sessionId] ?? { phase: 'loading' as const };
            return (
              <div key={m.sessionId} style={box}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button
                    onClick={() => props.onFocusSession(m.sessionId)}
                    title="Focus this agent's pane"
                    style={{ ...ghost, padding: '3px 8px', fontWeight: 700 }}
                  >
                    {m.role ?? 'agent'}
                  </button>
                  {st && <StatusBadge status={st} pulse={st === 'waiting'} />}
                  <span style={{ ...mono, ...muted, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {m.branch}
                  </span>
                </div>

                <RowBody row={row} />

                {(row.phase === 'loaded' || row.phase === 'busy') && (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      style={primary}
                      disabled={row.phase === 'busy' || !row.review.hasChanges}
                      title={row.review.hasChanges ? 'Merge into the repo branch' : 'Nothing to merge'}
                      onClick={() => doMerge(m, false)}
                    >
                      Merge
                    </button>
                    <button
                      style={ghost}
                      disabled={row.phase === 'busy' || !row.review.hasChanges}
                      title="Collapse to a single commit, then merge"
                      onClick={() => doMerge(m, true)}
                    >
                      Squash-merge
                    </button>
                    <button
                      style={{ ...danger, marginLeft: 'auto' }}
                      disabled={row.phase === 'busy'}
                      title="Remove this worktree and delete its branch"
                      onClick={() => props.discard(m)}
                    >
                      Discard
                    </button>
                  </div>
                )}

                {row.phase === 'merged' && (
                  <div style={{ ...muted, color: 'var(--status-idle, #5ad17a)' }}>
                    ✓ {row.message}
                  </div>
                )}
                {row.phase === 'error' && (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ ...muted, color: 'var(--status-waiting)', flex: 1 }}>
                      {row.message}
                    </span>
                    <button style={ghost} onClick={() => load(m)}>
                      Retry
                    </button>
                    <button
                      style={danger}
                      title="Remove this worktree and delete its branch"
                      onClick={() => props.discard(m)}
                    >
                      Discard
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/** The diff summary body for one agent row (counts, files, commits). */
function RowBody({ row }: { row: RowState }) {
  if (row.phase === 'loading') return <div style={muted}>Loading diff…</div>;
  if (row.phase === 'error') return null; // error rendered by the caller
  const r = row.review;
  if (!r.hasChanges) {
    return <div style={muted}>No changes on this branch yet.</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={muted}>
          {r.filesChanged} file{r.filesChanged === 1 ? '' : 's'}
        </span>
        <span style={{ ...mono, color: 'var(--status-idle, #5ad17a)' }}>+{r.insertions}</span>
        <span style={{ ...mono, color: 'var(--status-waiting)' }}>−{r.deletions}</span>
        <span style={muted}>→ {r.baseBranch}</span>
        {r.dirty && (
          <span
            title="Uncommitted edits — merge will auto-commit them first"
            style={{
              ...muted,
              color: 'var(--status-waiting)',
              border: '1px solid var(--status-waiting)',
              borderRadius: 5,
              padding: '0 6px',
            }}
          >
            uncommitted
          </span>
        )}
      </div>
      {r.files.length > 0 && (
        <div
          style={{
            ...mono,
            maxHeight: 120,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          {r.files.map((f) => (
            <div key={f.path} style={{ display: 'flex', gap: 8 }}>
              <span style={{ color: 'var(--status-idle, #5ad17a)', width: 36, textAlign: 'right' }}>
                +{f.added}
              </span>
              <span style={{ color: 'var(--status-waiting)', width: 36, textAlign: 'right' }}>
                −{f.deleted}
              </span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {f.path}
              </span>
            </div>
          ))}
        </div>
      )}
      {r.commits.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {r.commits.map((c) => (
            <div key={c.hash} style={{ ...mono, color: 'var(--fg-muted)' }}>
              <span style={{ color: 'var(--accent)' }}>{c.hash}</span> {c.subject}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
