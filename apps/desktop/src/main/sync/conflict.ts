/**
 * Conflict resolution policy. The default `keep-both` never overwrites: the
 * losing version is written next to the original as a conflict copy. The
 * `last-write-wins` policy is scaffolded for a future opt-in.
 */

export type ConflictPolicy = 'keep-both' | 'last-write-wins'

/** Two-digit zero-padded. */
function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** `YYYY-MM-DD HHmmss` in local time, for conflict-copy filenames. */
export function formatConflictTimestamp(now: Date): string {
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  )
}

/**
 * Build the conflict-copy path for `originalPath`, preserving its folder and
 * extension: `inbox/Note.md` → `inbox/Note (conflict 1a2b3c4d 2026-06-17 150405).md`.
 */
export function conflictCopyPath(originalPath: string, deviceId: string, now: Date): string {
  const slash = originalPath.lastIndexOf('/')
  const dot = originalPath.lastIndexOf('.')
  const hasExt = dot > slash
  const ext = hasExt ? originalPath.slice(dot) : ''
  const stem = hasExt ? originalPath.slice(0, dot) : originalPath
  const device = deviceId.slice(0, 8)
  return `${stem} (conflict ${device} ${formatConflictTimestamp(now)})${ext}`
}

/** A conflict copy this engine produced (so it never conflicts with itself). */
const CONFLICT_MARKER = /\(conflict [0-9a-f]{8} \d{4}-\d{2}-\d{2} \d{6}\)/

export function isConflictCopyPath(path: string): boolean {
  return CONFLICT_MARKER.test(path)
}
