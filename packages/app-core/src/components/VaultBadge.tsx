/**
 * Colorful square badge shown next to the vault name in the sidebar.
 *
 * The hue is deterministically derived from the vault name so every
 * distinct vault gets its own identity color, but the same vault always
 * lands on the same color across sessions. The first letter of the vault
 * name is painted on top of a diagonal gradient — similar to the way
 * Slack workspace avatars work.
 */

function hash(str: string): number {
  // djb2 — compact, deterministic, collision-friendly enough for hueing.
  let h = 5381
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

export function vaultHue(name: string): number {
  return hash(name || 'zen') % 360
}

export function VaultBadge({
  name,
  size = 28
}: {
  name: string
  size?: number
}): JSX.Element {
  const hue = vaultHue(name)
  const bgTop = `hsl(${hue} 80% 64%)`
  const bgBottom = `hsl(${(hue + 18) % 360} 72% 44%)`
  const glow = `hsl(${hue} 92% 82% / 0.58)`
  const shade = `hsl(${(hue + 24) % 360} 74% 32% / 0.36)`
  const initial = (name?.trim().charAt(0) || 'Z').toUpperCase()

  return (
    <div
      className="relative flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold text-white shadow-[0_1px_0_rgba(255,255,255,0.32)_inset,0_8px_18px_-12px_rgba(0,0,0,0.45)]"
      style={{
        width: size,
        height: size,
        background: [
          `radial-gradient(circle at 34% 26%, ${glow}, transparent 42%)`,
          `radial-gradient(circle at 78% 88%, ${shade}, transparent 56%)`,
          `linear-gradient(145deg, ${bgTop}, ${bgBottom})`,
        ].join(', '),
        fontSize: Math.round(size * 0.48),
        lineHeight: 1
      }}
      aria-hidden="true"
    >
      {/* Subtle upper glint so the avatar reads as a soft identity marker. */}
      <div
        className="pointer-events-none absolute inset-x-[18%] top-[10%] h-[28%] rounded-full"
        style={{
          background: 'linear-gradient(180deg, rgb(255 255 255 / 0.35), transparent)'
        }}
      />
      <span className="relative z-10 drop-shadow-[0_1px_0_rgba(0,0,0,0.2)]">
        {initial}
      </span>
    </div>
  )
}
