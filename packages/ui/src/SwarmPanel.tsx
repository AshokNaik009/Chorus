import { useEffect, useState } from 'react';
import { MAX_SWARM_AGENTS, type SessionStatus, type Workspace } from '@app/core';
import { StatusBadge } from './StatusBadge.js';

export interface SwarmPanelProps {
  workspace: Workspace;
  statusOf: (sessionId: string) => SessionStatus | null;
  /** True when each agent can get its own git worktree + branch (Electron). */
  worktreesAvailable: boolean;
  /** Probe whether a directory is a git repo (for worktree-isolation guidance). */
  checkGitRepo: (dir: string) => Promise<boolean>;
  onClose: () => void;
  onBroadcast: (sessionIds: string[], text: string, submit: boolean) => void;
  onCreateSwarm: (
    name: string,
    task: string,
    members: { sessionId: string; role?: string }[],
  ) => void;
  onRemoveSwarm: (swarmId: string) => void;
  onSwarmBroadcast: (swarmId: string, text: string, submit: boolean) => void;
  onSwarmStopAll: (swarmId: string) => void;
  onFanOut: (
    name: string,
    task: string,
    workers: { role: string; task: string; dir?: string }[],
    autoStart: boolean,
    dir: string,
  ) => void;
  onFocusSession: (sessionId: string) => void;
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
const input: React.CSSProperties = {
  background: 'var(--bg-elevated)',
  color: 'var(--fg)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '6px 8px',
  fontFamily: 'inherit',
  fontSize: 12,
};
const primary: React.CSSProperties = {
  background: 'var(--accent)',
  color: '#0e1116',
  border: 'none',
  borderRadius: 6,
  padding: '7px 12px',
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: 12,
};
const ghost: React.CSSProperties = {
  background: 'var(--bg-elevated)',
  color: 'var(--fg)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '7px 12px',
  cursor: 'pointer',
  fontSize: 12,
};
const sectionTitle: React.CSSProperties = { fontWeight: 700, fontSize: 13 };
const muted: React.CSSProperties = { color: 'var(--fg-muted)', fontSize: 11.5, lineHeight: 1.5 };

/**
 * Swarm console (PRD Epic 10): ad-hoc broadcast to selected sessions, fan-out a
 * task into role-seeded panes, and group controls for saved swarms (send-all /
 * stop-all / focus, with the waiting attention cue). Opens as a right-side drawer.
 */
export function SwarmPanel(props: SwarmPanelProps) {
  const sessions = props.workspace.sessions;
  const swarms = props.workspace.swarms ?? [];

  // ad-hoc broadcast
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [castText, setCastText] = useState('');
  const [castSubmit, setCastSubmit] = useState(true);
  const toggleSel = (id: string) =>
    setSelected((p) => {
      const n = new Set(p);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  // create-from-selected
  const [swarmName, setSwarmName] = useState('');
  const [swarmTask, setSwarmTask] = useState('');
  const [roleById, setRoleById] = useState<Record<string, string>>({});

  // fan-out
  const [foDir, setFoDir] = useState('');
  const [foName, setFoName] = useState('');
  const [foTask, setFoTask] = useState('');
  // Each worker may override its directory (its own repo); empty = the default
  // directory above. Lets one swarm span several repos (e.g. a frontend repo and
  // a separate backend repo, one agent each).
  const [foWorkers, setFoWorkers] = useState<
    { role: string; task: string; dir: string }[]
  >([
    { role: 'frontend', task: '', dir: '' },
    { role: 'backend', task: '', dir: '' },
    { role: 'tests', task: '', dir: '' },
  ]);
  const [foAutoStart, setFoAutoStart] = useState(true);
  const validWorkers = foWorkers.filter((w) => w.role.trim());
  const maxWorkers = MAX_SWARM_AGENTS;
  const dirReady = foDir.trim().length > 0;

  // Live git-repo check on the chosen directory: worktree isolation needs a repo.
  // Debounced so we don't probe on every keystroke. Only runs when the host can
  // create worktrees (desktop); on web the static note below covers it.
  const { checkGitRepo, worktreesAvailable } = props;
  const [gitState, setGitState] = useState<
    'unknown' | 'checking' | 'repo' | 'norepo'
  >('unknown');
  useEffect(() => {
    const dir = foDir.trim();
    if (!worktreesAvailable || !dir) {
      setGitState('unknown');
      return;
    }
    setGitState('checking');
    let cancelled = false;
    const h = setTimeout(() => {
      checkGitRepo(dir)
        .then((ok) => {
          if (!cancelled) setGitState(ok ? 'repo' : 'norepo');
        })
        .catch(() => {
          if (!cancelled) setGitState('unknown');
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(h);
    };
  }, [foDir, worktreesAvailable, checkGitRepo]);

  return (
    <div
      onClick={props.onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 55,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        justifyContent: 'flex-end',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 480,
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
          <strong style={{ fontSize: 15 }}>⚇ Swarm · {props.workspace.name}</strong>
          <button onClick={props.onClose} style={{ ...ghost, padding: '4px 10px' }}>
            Close
          </button>
        </div>

        {/* Broadcast — temporarily disabled */}
        {false && (
        <div style={box}>
          <div style={sectionTitle}>Broadcast</div>
          <div style={muted}>
            Send one prompt to several sessions at once.{' '}
            <strong style={{ color: 'var(--status-waiting)' }}>
              {selected.size} session(s) = {selected.size} independent run(s).
            </strong>
          </div>
          {sessions.length === 0 ? (
            <div style={muted}>No started sessions in this workspace yet.</div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {sessions.map((s) => {
                const on = selected.has(s.sessionId);
                return (
                  <button
                    key={s.sessionId}
                    onClick={() => toggleSel(s.sessionId)}
                    style={{
                      ...ghost,
                      padding: '4px 8px',
                      borderColor: on ? 'var(--accent)' : 'var(--border)',
                      background: on
                        ? 'color-mix(in srgb, var(--accent) 16%, transparent)'
                        : 'var(--bg-elevated)',
                    }}
                  >
                    {on ? '☑ ' : '☐ '}
                    {s.title}
                  </button>
                );
              })}
            </div>
          )}
          <textarea
            value={castText}
            onChange={(e) => setCastText(e.target.value)}
            placeholder="Ask all selected sessions the same thing…"
            rows={2}
            style={{ ...input, resize: 'vertical' }}
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label style={{ ...muted, display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={castSubmit}
                onChange={(e) => setCastSubmit(e.target.checked)}
              />
              Submit (send Enter)
            </label>
            <button
              style={{ ...primary, marginLeft: 'auto' }}
              disabled={selected.size === 0 || !castText.trim()}
              onClick={() => {
                props.onBroadcast([...selected], castText, castSubmit);
                setCastText('');
              }}
            >
              Send to {selected.size}
            </button>
            <button
              style={ghost}
              disabled={selected.size === 0 || !swarmName.trim()}
              title="Group the selected sessions into a saved swarm"
              onClick={() => {
                props.onCreateSwarm(
                  swarmName,
                  swarmTask,
                  [...selected].map((id) => ({ sessionId: id, role: roleById[id]?.trim() || undefined })),
                );
                setSelected(new Set());
                setSwarmName('');
                setSwarmTask('');
              }}
            >
              Save as swarm
            </button>
          </div>
          <input
            value={swarmName}
            onChange={(e) => setSwarmName(e.target.value)}
            placeholder="swarm name (to save the selection)"
            style={input}
          />
          <input
            value={swarmTask}
            onChange={(e) => setSwarmTask(e.target.value)}
            placeholder="shared task (optional)"
            style={input}
          />
          {selected.size > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {[...selected].map((id) => {
                const s = sessions.find((x) => x.sessionId === id);
                return (
                  <div key={id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span style={{ ...muted, width: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s?.title ?? id}
                    </span>
                    <input
                      value={roleById[id] ?? ''}
                      onChange={(e) => setRoleById((p) => ({ ...p, [id]: e.target.value }))}
                      placeholder="role (e.g. backend)"
                      style={{ ...input, flex: 1 }}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
        )}

        {/* Fan-out */}
        <div style={box}>
          <div style={sectionTitle}>Fan out a task</div>
          <div style={muted}>
            Give each agent its own task; they auto-start in parallel
            {props.worktreesAvailable
              ? ', each isolated in its own git worktree + branch.'
              : '. (Isolated git worktrees need the desktop app + a git repo — here the agents share the directory.)'}
            {' '}This replaces the current workspace layout.
          </div>
          <label style={{ ...muted, color: 'var(--fg)' }}>Directory path (required)</label>
          <input
            value={foDir}
            onChange={(e) => setFoDir(e.target.value)}
            placeholder="/absolute/path/to/project"
            style={{ ...input, borderColor: dirReady ? 'var(--border)' : 'var(--status-waiting)' }}
          />
          {!dirReady && (
            <div style={muted}>Enter a directory to enable the rest of the form.</div>
          )}
          {dirReady && worktreesAvailable && gitState === 'checking' && (
            <div style={muted}>Checking for a git repository…</div>
          )}
          {dirReady && worktreesAvailable && gitState === 'repo' && (
            <div style={{ ...muted, color: 'var(--status-idle, #5ad17a)' }}>
              ✓ Git repo — each agent gets its own worktree + branch.
            </div>
          )}
          {dirReady && worktreesAvailable && gitState === 'norepo' && (
            <div style={{ ...muted, color: 'var(--status-waiting)' }}>
              ⚠ Not a git repository. The agents will share this folder (no
              per-agent worktrees, so their edits can collide). Run{' '}
              <code>git init</code> here first for isolated branches.
            </div>
          )}
          {dirReady && !worktreesAvailable && (
            <div style={muted}>
              Isolated git worktrees need the desktop app — the agents will share
              this folder.
            </div>
          )}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              opacity: dirReady ? 1 : 0.4,
              pointerEvents: dirReady ? 'auto' : 'none',
            }}
          >
          <input value={foName} onChange={(e) => setFoName(e.target.value)} placeholder="swarm name" style={input} />
          <textarea
            value={foTask}
            onChange={(e) => setFoTask(e.target.value)}
            placeholder="shared context for all agents (optional)"
            rows={2}
            style={{ ...input, resize: 'vertical' }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {foWorkers.map((w, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  padding: 8,
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                }}
              >
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    value={w.role}
                    onChange={(e) =>
                      setFoWorkers((p) => p.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))
                    }
                    placeholder={`agent ${i + 1} role (e.g. writer)`}
                    style={{ ...input, flex: 1 }}
                  />
                  <button
                    style={{ ...ghost, padding: '4px 10px' }}
                    onClick={() => setFoWorkers((p) => p.filter((_, j) => j !== i))}
                    disabled={foWorkers.length <= 1}
                  >
                    ×
                  </button>
                </div>
                <textarea
                  value={w.task}
                  onChange={(e) =>
                    setFoWorkers((p) => p.map((x, j) => (j === i ? { ...x, task: e.target.value } : x)))
                  }
                  placeholder="this agent's task…"
                  rows={2}
                  style={{ ...input, resize: 'vertical' }}
                />
                <input
                  value={w.dir}
                  onChange={(e) =>
                    setFoWorkers((p) => p.map((x, j) => (j === i ? { ...x, dir: e.target.value } : x)))
                  }
                  placeholder="this agent's directory (optional — its own repo; defaults to above)"
                  style={{ ...input, fontSize: 11 }}
                />
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              style={{ ...ghost, alignSelf: 'flex-start' }}
              onClick={() => setFoWorkers((p) => (p.length >= maxWorkers ? p : [...p, { role: '', task: '', dir: '' }]))}
              disabled={foWorkers.length >= maxWorkers}
              title={`Up to ${maxWorkers} worker agents`}
            >
              + agent
            </button>
            {foWorkers.length >= maxWorkers && (
              <span style={{ ...muted, color: 'var(--status-waiting)' }}>
                Max {maxWorkers} agents — the grid shows one pane each.
              </span>
            )}
          </div>

          <div style={muted}>
            Each agent is told to verify its own work (write/run tests, meet the
            acceptance criteria) before finishing — there is no separate verifier.
          </div>

          <label style={{ ...muted, display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={foAutoStart}
              onChange={(e) => setFoAutoStart(e.target.checked)}
            />
            Auto-start agents (run hands-off, skipping approval prompts)
          </label>

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              style={{ ...primary, marginLeft: 'auto' }}
              disabled={!dirReady || !foName.trim() || validWorkers.length === 0}
              onClick={() => {
                props.onFanOut(
                  foName.trim(),
                  foTask.trim(),
                  validWorkers.map((w) => ({
                    role: w.role.trim(),
                    task: w.task,
                    dir: w.dir.trim() || undefined,
                  })),
                  foAutoStart,
                  foDir.trim(),
                );
                props.onClose();
              }}
            >
              Fan out {validWorkers.length} agents
            </button>
          </div>
          </div>
        </div>

        {/* Saved swarms */}
        <div style={box}>
          <div style={sectionTitle}>Swarms · {swarms.length}</div>
          {swarms.length === 0 ? (
            <div style={muted}>No swarms yet. Save a selection or fan out a task above.</div>
          ) : (
            swarms.map((sw) => (
              <SavedSwarm
                key={sw.swarmId}
                swarm={sw}
                statusOf={props.statusOf}
                onRemove={() => props.onRemoveSwarm(sw.swarmId)}
                onSend={(text, submit) => props.onSwarmBroadcast(sw.swarmId, text, submit)}
                onStopAll={() => props.onSwarmStopAll(sw.swarmId)}
                onFocus={props.onFocusSession}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function SavedSwarm({
  swarm,
  statusOf,
  onRemove,
  onSend,
  onStopAll,
  onFocus,
}: {
  swarm: import('@app/core').SwarmDef;
  statusOf: (id: string) => SessionStatus | null;
  onRemove: () => void;
  onSend: (text: string, submit: boolean) => void;
  onStopAll: () => void;
  onFocus: (id: string) => void;
}) {
  const [text, setText] = useState('');
  return (
    <div style={{ ...box, background: 'var(--bg-elevated)', padding: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong style={{ fontSize: 12.5 }}>{swarm.name}</strong>
        <span style={{ ...muted, flex: 1 }}>{swarm.task ?? ''}</span>
        <button style={{ ...ghost, padding: '3px 8px' }} onClick={onStopAll} title="Ctrl-C all members">
          Stop all
        </button>
        <button style={{ ...ghost, padding: '3px 8px' }} onClick={onRemove} title="Forget this swarm">
          ×
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {swarm.members.map((m) => {
          const st = statusOf(m.sessionId);
          const waiting = st === 'waiting';
          return (
            <div
              key={m.sessionId}
              onClick={() => onFocus(m.sessionId)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px 6px',
                borderRadius: 6,
                cursor: 'pointer',
                background: waiting
                  ? 'color-mix(in srgb, var(--status-waiting) 14%, transparent)'
                  : 'transparent',
              }}
            >
              <span style={{ ...muted, width: 90, color: 'var(--fg)' }}>{m.role ?? 'agent'}</span>
              {st ? <StatusBadge status={st} pulse={waiting} /> : <span style={muted}>not live</span>}
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="send to all members…"
          style={{ ...input, flex: 1 }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && text.trim()) {
              onSend(text, true);
              setText('');
            }
          }}
        />
        <button
          style={primary}
          disabled={!text.trim()}
          onClick={() => {
            onSend(text, true);
            setText('');
          }}
        >
          Send to all
        </button>
      </div>
    </div>
  );
}
