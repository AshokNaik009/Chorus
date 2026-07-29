/**
 * LEAP Chorus brand lockup — a two-tone bolt avatar plus the wordmark.
 * The mark is inline SVG so it needs no asset pipeline and inherits the theme
 * background on both hosts.
 */

/** Bolt avatar only — used on the collapsed sidebar rail. */
export function BrandMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="LEAP Chorus"
      style={{ flexShrink: 0, display: 'block' }}
    >
      <defs>
        {/* Hard stop at the midpoint: warm on the left half, cool on the right. */}
        <linearGradient id="leap-bolt" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#f7c948" />
          <stop offset="50%" stopColor="#e8871e" />
          <stop offset="50%" stopColor="#4c8dff" />
          <stop offset="100%" stopColor="#1d4ed8" />
        </linearGradient>
      </defs>
      <path
        d="M19.8 2 4.8 18.4h7.6L11.1 30 27.2 13.2h-7.9z"
        fill="url(#leap-bolt)"
      />
    </svg>
  );
}

/** Avatar + wordmark, for the sidebar header. */
export function BrandLockup({ size = 20 }: { size?: number }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        minWidth: 0,
      }}
    >
      <BrandMark size={size} />
      <span
        className="disp"
        style={{
          fontSize: 13,
          fontWeight: 700,
          letterSpacing: '-0.01em',
          whiteSpace: 'nowrap',
          color: 'var(--text)',
        }}
      >
        LEAP <span style={{ color: 'var(--accent)' }}>Chorus</span>
      </span>
    </span>
  );
}
