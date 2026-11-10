/**
 * What this tab is running, for Settings: the release folder it was served
 * from and the SHA-256 of that release's manifest, hashed here from the bytes
 * this browser received. The manifest lists every file of the release with
 * its hash and is published with the release, so the two can be compared. The
 * website installs it beside the release files as `artifact-manifest.json`. A
 * local run has none.
 */
import type { BrowserRelease } from '@zennotes/bridge-contract/bridge'
import appPackage from '../../package.json'

const RELEASE_BASE = /\/vendor\/cloud-web\/releases\/([^/]+)\/$/

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function runningRelease(
  base: string = import.meta.env.BASE_URL,
  fetchImpl: typeof fetch = (...args) => fetch(...args)
): Promise<BrowserRelease> {
  const release = RELEASE_BASE.exec(base)?.[1] ?? `${appPackage.version} (local build)`
  try {
    const response = await fetchImpl(`${base}artifact-manifest.json`, { credentials: 'omit' })
    if (!response.ok) return { release, manifestVersion: null, manifestSha256: null }
    const bytes = await response.arrayBuffer()
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as { version?: unknown }
    if (typeof manifest.version !== 'string') return { release, manifestVersion: null, manifestSha256: null }
    return { release, manifestVersion: manifest.version, manifestSha256: hex(await crypto.subtle.digest('SHA-256', bytes)) }
  } catch {
    // Offline before it was ever fetched, or a local server's HTML fallback.
    return { release, manifestVersion: null, manifestSha256: null }
  }
}
