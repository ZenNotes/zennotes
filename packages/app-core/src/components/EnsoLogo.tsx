/**
 * Enso-brand logo. Inline SVG so it's crisp at every size and can pick
 * up theme colors through `currentColor`.
 *
 * - `size`    — pixel dimensions (square)
 * - `framed`  — if true, draws the dark rounded-square icon frame
 *               around the enso stroke (matches the app icon artwork).
 *               If false, just the enso ring — useful inside a row.
 */
export function EnsoLogo({
  size = 40,
  framed = true,
  className
}: {
  size?: number
  framed?: boolean
  className?: string
}): JSX.Element {
  const strokeColor = framed ? '#f3e8c4' : 'currentColor'

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={className}
      aria-hidden="true"
    >
      {framed && (
        <>
          <defs>
            <linearGradient id="ensoFrame" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#1e2129" />
              <stop offset="1" stopColor="#0c0f14" />
            </linearGradient>
            <radialGradient id="ensoGlow" cx="50%" cy="50%" r="50%">
              <stop offset="0" stopColor="#fff8d6" stopOpacity="0.55" />
              <stop offset="1" stopColor="#fff8d6" stopOpacity="0" />
            </radialGradient>
          </defs>
          <rect
            x="2"
            y="2"
            width="96"
            height="96"
            rx="22"
            ry="22"
            fill="url(#ensoFrame)"
          />
          <circle cx="50" cy="50" r="40" fill="url(#ensoGlow)" />
        </>
      )}
      {/*
        Two stacked strokes create a subtle luminous effect — an outer
        wider stroke at low opacity, and a crisp inner stroke on top.
        The dash array leaves a small opening at the top-right, the
        traditional enso gap.
       */}
      <circle
        cx="50"
        cy="50"
        r="33"
        fill="none"
        stroke={strokeColor}
        strokeOpacity={framed ? 0.45 : 0.25}
        strokeWidth={framed ? 11 : 10}
        strokeLinecap="round"
        strokeDasharray="172 220"
        strokeDashoffset="22"
        transform="rotate(-115 50 50)"
      />
      <circle
        cx="50"
        cy="50"
        r="33"
        fill="none"
        stroke={strokeColor}
        strokeWidth={framed ? 5 : 5.5}
        strokeLinecap="round"
        strokeDasharray="172 220"
        strokeDashoffset="22"
        transform="rotate(-115 50 50)"
      />
    </svg>
  )
}
