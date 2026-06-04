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
    title: 'Layouts',
    body: 'Pick 1 / 1×2 / 1×3 / 2×2 / 2×3 in the header to split the area into that many panes. Drag the dividers between panes to resize; the terminals reflow.',
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
    icon: '🎙',
    title: 'Voice dictation',
    body: 'Click the mic (or hold the hotkey, default ⌘/Ctrl+Shift+D) to dictate into the focused pane. Transcription runs fully on-device — audio never leaves your machine. Set engine, insert-vs-submit, and language under “Voice”.',
  },
  {
    icon: '📦',
    title: 'Export / Import',
    body: 'Export writes a portable .chorus file of your workspaces, layouts and names. Import restores it — choose Merge (add alongside) or Replace all. It restores your setup, not the working-tree files themselves.',
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
                  color: '#0e1116',
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
