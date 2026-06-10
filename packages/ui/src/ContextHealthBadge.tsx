import { useState } from 'react';
import type { ContextHealth, ContextTier } from '@app/core';

/** Tier → color. Green healthy, amber watch, red hand-off (GitHub-ish palette). */
const TIER_COLOR: Record<ContextTier, string> = {
  healthy: '#3fb950',
  watch: '#d29922',
  handoff: '#f85149',
};

const TIER_LABEL: Record<ContextTier, string> = {
  healthy: 'context',
  watch: 'context · finish up',
  handoff: 'context · hand off',
};

/**
 * Live context-window occupancy for a pane: a small `NN%` pill colored by tier.
 * When the pane crosses the hand-off line it grows a "Hand off" button that
 * copies a handoff-brief scaffold for the next session (the export trigger from
 * the context-rot writeup, parts 2–3). Pure presentational — the parent owns the
 * reading and the brief.
 */
export function ContextHealthBadge({
  health,
  onHandoff,
}: {
  health: ContextHealth;
  onHandoff?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const color = TIER_COLOR[health.tier];
  const pct = Math.round(health.pct * 100);
  const title =
    `${health.occupied.toLocaleString()} / ${health.windowMax.toLocaleString()} ` +
    `tokens (${pct}%) — ${health.model ?? 'unknown model'}`;

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span
        title={title}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          padding: '1px 8px',
          borderRadius: 999,
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: 0.3,
          textTransform: 'uppercase',
          color,
          background: `color-mix(in srgb, ${color} 16%, transparent)`,
          border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`,
        }}
      >
        <span
          style={{ width: 7, height: 7, borderRadius: '50%', background: color }}
        />
        {pct}% {TIER_LABEL[health.tier]}
      </span>
      {health.tier === 'handoff' && onHandoff && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onHandoff();
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          }}
          title="Copy a handoff-brief scaffold for the next session"
          style={{
            fontSize: 10,
            fontWeight: 700,
            padding: '1px 8px',
            borderRadius: 999,
            cursor: 'pointer',
            color: copied ? '#3fb950' : color,
            background: 'transparent',
            border: `1px solid color-mix(in srgb, ${copied ? '#3fb950' : color} 55%, transparent)`,
          }}
        >
          {copied ? 'Copied ✓' : 'Hand off'}
        </button>
      )}
    </span>
  );
}
