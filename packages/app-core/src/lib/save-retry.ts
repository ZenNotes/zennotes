/**
 * The pure half of retrying a note save that failed (#1108).
 *
 * A remote vault has no local copy: when the server cannot be reached, a save
 * fails and the edit lives only in the editor's buffer. Before this, the
 * failure went to the console and nothing ever tried again, so the edit was
 * gone the moment the app quit, even if the server had come back long before.
 */

/** Waits between retries: quick at first, since most outages are a blip
 *  (a Wi-Fi handoff, a server restart), then once a minute for as long as the
 *  buffer stays dirty. A reconnecting change feed retries at once anyway. */
export const SAVE_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000] as const

export function saveRetryDelay(attempt: number): number {
  const index = Math.min(Math.max(attempt, 0), SAVE_RETRY_DELAYS_MS.length - 1)
  return SAVE_RETRY_DELAYS_MS[index]
}

/**
 * Where the server's version of a note goes when it changed while this app
 * could not save over it: `Note (server copy).md`, then `Note (server copy
 * 2).md`. The buffer the user is looking at keeps the original path, the same
 * keep-both outcome Cloud sync gives a conflict, so neither side is lost.
 */
export function serverCopyPath(path: string, taken: (candidate: string) => boolean): string {
  const slash = path.lastIndexOf('/')
  const directory = slash === -1 ? '' : path.slice(0, slash + 1)
  const name = path.slice(slash + 1)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  for (let n = 1; n <= 10_000; n++) {
    const suffix = n === 1 ? '(server copy)' : `(server copy ${n})`
    const candidate = `${directory}${stem} ${suffix}${extension}`
    if (!taken(candidate)) return candidate
  }
  throw new Error(`Every name for a server copy of “${path}” is taken.`)
}

/**
 * Whether the bytes now on the server are ones this app may overwrite. The
 * buffer drifted from `base` (what was on disk when the edit began); a server
 * still holding `base`, or already holding the buffer, has nothing of anyone
 * else's to lose. Without a base there is nothing to compare, and the save
 * goes ahead exactly as it would have before the outage.
 */
export function serverBodyIsSafeToOverwrite(
  serverBody: string,
  base: string | undefined,
  buffer: string
): boolean {
  if (base === undefined) return true
  return serverBody === base || serverBody === buffer
}
