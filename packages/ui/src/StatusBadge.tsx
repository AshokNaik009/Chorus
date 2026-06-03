import type { SessionStatus } from '@app/core';

const LABEL: Record<SessionStatus, string> = {
  spawning: 'starting',
  running: 'running',
  waiting: 'waiting',
  idle: 'idle',
  exited: 'exited',
};

const COLOR: Record<SessionStatus, string> = {
  spawning: 'var(--status-spawning)',
  running: 'var(--status-running)',
  waiting: 'var(--status-waiting)',
  idle: 'var(--status-idle)',
  exited: 'var(--status-exited)',
};

export function StatusBadge({
  status,
  pulse = false,
}: {
  status: SessionStatus;
  pulse?: boolean;
}) {
  const color = COLOR[status];
  return (
    <span
      title={status}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '1px 8px',
        borderRadius: 999,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 0.3,
        textTransform: 'uppercase',
        color,
        background: 'color-mix(in srgb, ' + color + ' 16%, transparent)',
        border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`,
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: color,
          boxShadow: pulse ? `0 0 0 0 ${color}` : undefined,
          animation: pulse ? 'pane-pulse 1.4s ease-out infinite' : undefined,
        }}
      />
      {LABEL[status]}
    </span>
  );
}
