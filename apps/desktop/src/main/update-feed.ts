/**
 * The published release feed, read directly for installs the app must not
 * touch.
 *
 * electron-updater reads `latest-linux.yml` from the newest GitHub release to
 * decide whether an update exists, then downloads and installs it. An AUR or
 * tarball install has no updater that can do the second half (pacman owns
 * those files), and the AppImage updater those installs used to fall into
 * refused to run without an AppImage marker and never reported back: the
 * About page sat on "Checking…" for good. This reads the same feed and stops
 * at the first half: is there a newer version, and which one.
 *
 * The feed is a small YAML document written by electron-builder. Only two
 * lines matter here (`version:` and `releaseDate:`), so they are read with a
 * line match rather than a YAML parser the main process does not otherwise
 * carry.
 */

export const LATEST_LINUX_FEED_URL =
  'https://github.com/ZenNotes/zennotes/releases/latest/download/latest-linux.yml'

export interface LatestRelease {
  version: string
  releaseDate: string | null
}

/** `version:` and `releaseDate:` out of an electron-builder feed. Throws when
 *  there is no version line, since a feed without one is not the feed. */
export function parseLatestFeed(feed: string): LatestRelease {
  const version = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(feed)?.[1]
  if (!version) throw new Error('The release feed carried no version.')
  const releaseDate = /^releaseDate:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(feed)?.[1] ?? null
  return { version, releaseDate }
}

/** Dotted numeric parts compared left to right; a prerelease suffix
 *  (`2.43.0-beta.1`) sorts below its release. Enough for this project's
 *  `MAJOR.MINOR.PATCH` tags without carrying a semver library into main. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): { parts: number[]; pre: string } => {
    const [core, ...rest] = v.replace(/^v/, '').split('-')
    return {
      parts: core.split('.').map((p) => Number.parseInt(p, 10) || 0),
      pre: rest.join('-')
    }
  }
  const x = split(a)
  const y = split(b)
  const length = Math.max(x.parts.length, y.parts.length)
  for (let i = 0; i < length; i += 1) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  return x.pre < y.pre ? -1 : 1
}

export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0
}

export type FeedFetch = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

/** The newest published release, from the feed at `url`. */
export async function fetchLatestRelease(
  fetchImpl: FeedFetch = (url) => fetch(url, { headers: { 'user-agent': 'ZenNotes update check' } }),
  url: string = LATEST_LINUX_FEED_URL
): Promise<LatestRelease> {
  const response = await fetchImpl(url)
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} for the release feed.`)
  }
  return parseLatestFeed(await response.text())
}
