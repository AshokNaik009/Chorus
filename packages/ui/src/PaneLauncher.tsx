import { useState } from 'react';

export interface PaneLauncherProps {
  defaultCwd: string;
  /** command === 'claude' launches Claude Code; undefined opens a plain shell. */
  onStart: (cwd: string, command?: string) => void;
}

/**
 * Shown in an empty pane. Lets the user (re)assign a working directory per pane
 * before spawning its session (PRD US-3.3).
 */
export function PaneLauncher({ defaultCwd, onStart }: PaneLauncherProps) {
  const [cwd, setCwd] = useState(defaultCwd);

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
          Working directory
        </div>
        <input
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder="/path/to/project or ~"
          onKeyDown={(e) => {
            if (e.key === 'Enter') onStart(cwd.trim() || '~', 'claude');
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
            onClick={() => onStart(cwd.trim() || '~', 'claude')}
            style={{
              flex: 1,
              background: 'var(--accent)',
              color: '#0e1116',
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
            onClick={() => onStart(cwd.trim() || '~')}
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
