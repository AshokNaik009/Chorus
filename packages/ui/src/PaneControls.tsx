import { useEffect, useRef } from 'react';

export interface PaneControlsProps {
  sessionId: string;
  /** Is this pane currently maximized (drives the maximize/restore glyph). */
  maximized: boolean;
  /** Maximize is hidden in tabs view (one pane already fills the body). */
  canMaximize: boolean;
  /** New-pane is hidden when the grid is full (6) or in swarm mode. */
  canAdd: boolean;
  /** Does this pane have a live PTY (gates Restart in the overflow menu). */
  isLive: boolean;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onMaximize: () => void;
  onAdd: () => void;
  onClose: () => void;
  onRename: () => void;
  onRestart: () => void;
}

const iconBtn: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 20,
  height: 20,
  background: 'transparent',
  border: 'none',
  borderRadius: 4,
  color: 'var(--fg-muted)',
  cursor: 'pointer',
  fontSize: 13,
  lineHeight: 1,
  padding: 0,
};

function IconButton({
  glyph,
  title,
  onClick,
  danger,
}: {
  glyph: string;
  title: string;
  onClick: (e: React.MouseEvent) => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      style={iconBtn}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--surface0, rgba(255,255,255,0.08))';
        e.currentTarget.style.color = danger ? 'var(--red, #f38ba8)' : 'var(--fg)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.color = 'var(--fg-muted)';
      }}
    >
      {glyph}
    </button>
  );
}

/**
 * The per-pane control cluster shown on the right of every pane's title bar:
 * `⋯` overflow menu, `⤢` maximize/restore, `⊞` new pane, `✕` close — mirroring
 * the affordances of a native terminal pane.
 */
export function PaneControls(props: PaneControlsProps) {
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close the overflow menu on any outside click / Escape.
  useEffect(() => {
    if (!props.menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) props.onCloseMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onCloseMenu();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [props.menuOpen, props.onCloseMenu]);

  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'flex', gap: 2 }}>
      <IconButton glyph="⋯" title="More" onClick={stop(props.onToggleMenu)} />

      {props.canMaximize && (
        <IconButton
          glyph={props.maximized ? '⤡' : '⤢'}
          title={props.maximized ? 'Restore' : 'Maximize'}
          onClick={stop(props.onMaximize)}
        />
      )}

      {props.canAdd && (
        <IconButton glyph="⊞" title="New pane" onClick={stop(props.onAdd)} />
      )}

      <IconButton glyph="✕" title="Close pane" onClick={stop(props.onClose)} danger />

      {props.menuOpen && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 4,
            minWidth: 150,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
            padding: 4,
            zIndex: 50,
          }}
        >
          <MenuItem
            label="Rename pane…"
            onClick={() => {
              props.onCloseMenu();
              props.onRename();
            }}
          />
          <MenuItem
            label="Restart terminal"
            disabled={!props.isLive}
            onClick={() => {
              props.onCloseMenu();
              props.onRestart();
            }}
          />
          <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
          <MenuItem
            label="Close pane"
            danger
            onClick={() => {
              props.onCloseMenu();
              props.onClose();
            }}
          />
        </div>
      )}
    </div>
  );
}

function MenuItem({
  label,
  onClick,
  disabled,
  danger,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        background: 'transparent',
        border: 'none',
        borderRadius: 4,
        color: disabled ? 'var(--fg-muted)' : danger ? 'var(--red, #f38ba8)' : 'var(--fg)',
        cursor: disabled ? 'default' : 'pointer',
        fontSize: 12,
        padding: '6px 10px',
        opacity: disabled ? 0.5 : 1,
      }}
      onMouseEnter={(e) => {
        if (!disabled)
          e.currentTarget.style.background = 'var(--surface0, rgba(255,255,255,0.08))';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      {label}
    </button>
  );
}
