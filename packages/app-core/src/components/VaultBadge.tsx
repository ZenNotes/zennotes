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
  const bgTop = `hsl(${hue} 78% 62%)`
  const bgBottom = `hsl(${(hue + 18) % 360} 72% 46%)`
  const shine = `hsl(${hue} 90% 80% / 0.6)`
  const initial = (name?.trim().charAt(0) || 'Z').toUpperCase()

  return (
    <div
      className="relative flex shrink-0 items-center justify-center overflow-hidden rounded-[8px] font-semibold text-white shadow-[0_1px_0_rgba(255,255,255,0.25)_inset,0_6px_14px_-6px_rgba(0,0,0,0.35)]"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(145deg, ${bgTop}, ${bgBottom})`,
        fontSize: Math.round(size * 0.48),
        lineHeight: 1
      }}
      aria-hidden="true"
    >
      {/* Subtle inner highlight for depth */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-1/2 rounded-t-[8px]"
        style={{
          background: `linear-gradient(180deg, ${shine}, transparent)`
        }}
      />
      <span className="relative z-10 drop-shadow-[0_1px_0_rgba(0,0,0,0.2)]">
        {initial}
      </span>
    </div>
  )
}
