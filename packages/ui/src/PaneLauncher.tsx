import { useState } from 'react';

export interface PaneLauncherProps {
  defaultCwd: string;
  /**
   * command === 'claude' launches Claude Code; undefined opens a plain shell.
   * `title` is the optional user-given session name (blank -> auto-named).
   */
  onStart: (cwd: string, command?: string, title?: string) => void;
}

/**
 * Shown in an empty pane. Lets the user name the session and (re)assign a
 * working directory per pane before spawning it (PRD US-3.3). The name is
 * optional — blank falls back to an auto title — and can be changed later from
 * the sidebar.
 */
export function PaneLauncher({ defaultCwd, onStart }: PaneLauncherProps) {
  const [cwd, setCwd] = useState(defaultCwd);
  const [name, setName] = useState('');

  const start = (command?: string) =>
    onStart(cwd.trim() || '~', command, name.trim() || undefined);

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg)',
      }}
    >
      <div
        style={{
          width: 320,
          maxWidth: '90%',
          padding: 20,
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div style={{ color: 'var(--fg-muted)', fontSize: 12 }}>
          Session name <span style={{ opacity: 0.6 }}>(optional)</span>
        </div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. api refactor"
          onKeyDown={(e) => {
            if (e.key === 'Enter') start('claude');
          }}
          style={{
            background: 'var(--bg)',
            color: 'var(--fg)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '6px 8px',
            fontFamily: 'inherit',
          }}
        />
        <div style={{ color: 'var(--fg-muted)', fontSize: 12 }}>
          Working directory
        </div>
        <input
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder="/path/to/project or ~"
          onKeyDown={(e) => {
            if (e.key === 'Enter') start('claude');
          }}
          style={{
            background: 'var(--bg)',
            color: 'var(--fg)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '6px 8px',
            fontFamily: 'inherit',
          }}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => start('claude')}
            style={{
              flex: 1,
              background: 'var(--accent)',
              color: 'var(--crust)',
              border: 'none',
              borderRadius: 6,
              padding: '7px 12px',
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Run Claude
          </button>
          <button
            onClick={() => start()}
            style={{
              background: 'var(--bg)',
              color: 'var(--fg)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: '7px 12px',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Shell
          </button>
        </div>
      </div>
    </div>
  );
}
