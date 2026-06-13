import { useState } from 'react';

interface Step {
  icon: string;
  title: string;
  body: string;
}

const STEPS: Step[] = [
  {
    icon: '🗂',
    title: 'Workspaces',
    body: 'A workspace is a named group of Claude Code sessions with its own layout and default folder. Use “+ new” in the sidebar to add one, double-click (or ✎) to rename, and the × on a workspace row to remove it.',
  },
  {
    icon: '▦',
    title: 'Manual mode & layouts',
    body: 'Each workspace is either Manual (a grid of terminals you drive) or running a Swarm. In manual mode, pick how many terminals (1–6) from the “Terminals” dropdown in the header. Drag the dividers between panes to resize; the terminals reflow.',
  },
  {
    icon: '🚀',
    title: 'Start a session',
    body: 'In an empty pane, optionally name it, set a working directory, then “Run Claude” (or “Shell”). The × on a sidebar session row closes that session and frees its pane.',
  },
  {
    icon: '🟢',
    title: 'Status & focus',
    body: 'Each pane/sidebar row shows a live badge — starting / running / waiting / idle. A workspace with a waiting session gets an attention dot. Click a session to focus it; 🗖 maximizes a pane, 🗗 restores the grid.',
  },
  {
    icon: '⚇',
    title: 'Swarm — fan out a task',
    body: 'Open “⚇ Swarm”, name the swarm, describe the shared task, and add up to 6 role agents (frontend, backend, tests, …) — one pane each. Fan out launches every agent as a real Claude Code session with its task pre-filled. Broadcast a message to all agents, or Stop all with one click; “End swarm” returns to manual terminals.',
  },
  {
    icon: '⎇',
    title: 'Worktree isolation',
    body: 'When an agent’s directory is a git repo, fan-out gives it its own branch (chorus/<swarm>/<role>) and git worktree under <repo>/.chorus/, so agents never trample each other’s files. .chorus/ is kept out of git via the repo’s local ignore. Non-repo directories fall back to a shared folder.',
  },
  {
    icon: '🔀',
    title: 'Review & merge',
    body: 'When agents finish, “⎇ Review” shows each branch’s work — files changed, commits, uncommitted edits — against the repo’s current branch. Merge it (dirty edits are auto-committed first), Squash it to one commit, or Discard the branch and worktree. Conflicted merges abort safely.',
  },
  {
    icon: '🌡',
    title: 'Context health',
    body: 'Every Claude pane shows a live % badge of its context-window use: green below 50%, amber to 70%, red past it. At red, a “Hand off” button copies a handoff brief — paste it into a fresh session to continue with a clean context.',
  },
  {
    icon: '🎙',
    title: 'Voice dictation',
    body: 'Click the mic (or hold the hotkey, default ⌘/Ctrl+Shift+D) to dictate into the focused pane. Transcription runs fully on-device — audio never leaves your machine. Set engine, insert-vs-submit, and language under “Voice”.',
  },
  {
    icon: '📦',
    title: 'Export / Import',
    body: 'Export writes a portable .chorus file — your workspaces, layouts and names, plus full conversations on the desktop app. Import restores it (Merge alongside or Replace all): each pane resumes its exact saved conversation, and importing a session that is still running forks a copy instead of disturbing the live one.',
  },
];

const btn: React.CSSProperties = {
  background: 'var(--bg)',
  color: 'var(--fg)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '4px 10px',
  cursor: 'pointer',
  fontSize: 12,
};

/**
 * Navbar "Guide" button + a dismissible how-to overlay so a first-time user can
 * understand the app at a glance. Pure presentational; no app state.
 */
export function HelpButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button style={btn} title="How to use Chorus" onClick={() => setOpen(true)}>
        ? Guide
      </button>
      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 70,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 560,
              maxWidth: '94%',
              maxHeight: '86%',
              overflowY: 'auto',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              borderRadius: 14,
              padding: 24,
              color: 'var(--fg)',
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <strong style={{ color: 'var(--accent)', fontSize: 18 }}>Chorus</strong>
              <span style={{ color: 'var(--fg-muted)', fontSize: 13 }}>
                — run many Claude Code sessions in parallel
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {STEPS.map((s) => (
                <div key={s.title} style={{ display: 'flex', gap: 12 }}>
                  <div style={{ fontSize: 20, lineHeight: 1.2, width: 26, textAlign: 'center' }}>
                    {s.icon}
                  </div>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 2 }}>
                      {s.title}
                    </div>
                    <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', lineHeight: 1.5 }}>
                      {s.body}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setOpen(false)}
                style={{
                  background: 'var(--accent)',
                  color: 'var(--crust)',
                  border: 'none',
                  borderRadius: 6,
                  padding: '8px 16px',
                  cursor: 'pointer',
                  fontWeight: 600,
                  fontSize: 12,
                }}
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
