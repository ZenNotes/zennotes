/**
 * Vault paths as OPFS sees them. Shared by the OPFS worker, the read-only
 * reader and the service worker, so the three agree on every name.
 *
 * Two names are refused rather than mapped (spike results, November 10):
 * - a backslash, which Chrome's OPFS rejects, and which the Cloud wire format
 *   already reads as a folder separator (normalizeCloudSyncPath), so no synced
 *   vault can hold one;
 * - a name over 255 UTF-8 bytes, which Safari's OPFS fails with UnknownError.
 *   Desktop file systems stop at 255 bytes too, so a vault that came from one
 *   never has such a name. Refusing everywhere keeps a vault that works in
 *   Chrome from breaking the day it opens in Safari.
 */
import { OPFS_BAD_NAME, OpfsError } from './opfs-errors'

/** Every vault lives under this folder of the origin's OPFS root. */
export const VAULTS_DIR = 'vaults'

/** Prefix of the temp file a write goes through before it moves into place.
 *  Hidden from listings, swept on open. */
export const TEMP_PREFIX = '.zn-tmp-'

/** Where a folder move records itself before it starts, so a tab closed in
 *  the middle finishes it on the next open. */
export const MOVE_JOURNAL_DIR = '.zennotes/.zn-moves'

export const MAX_NAME_BYTES = 255

const encoder = new TextEncoder()

export function utf8Length(value: string): number {
  return encoder.encode(value).byteLength
}

/** The refusal for one name, or null when OPFS can hold it in every engine. */
export function nameProblem(name: string): string | null {
  if (!name || name === '.' || name === '..') return 'an empty or relative name'
  if (name.includes('\\')) return 'a backslash, which browsers cannot store in a name'
  if (name.includes('\u0000')) return 'a null character'
  if (utf8Length(name) > MAX_NAME_BYTES) return `more than ${MAX_NAME_BYTES} bytes, the most a browser can store`
  return null
}

export function assertStorableName(name: string, path: string): void {
  const problem = nameProblem(name)
  if (problem) {
    throw new OpfsError(OPFS_BAD_NAME, `“${path}” cannot be saved in this browser: its name has ${problem}.`, 'OpfsNameError')
  }
}

/** Vault-relative POSIX path to its segments; '' is the vault root. Rejects
 *  `..` and absolute paths outright, never resolving them. */
export function splitVaultPath(path: string): string[] {
  const segments = String(path ?? '')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
  for (const segment of segments) {
    if (segment === '..') {
      throw new OpfsError(OPFS_BAD_NAME, `“${path}” leaves the vault.`, 'OpfsNameError')
    }
  }
  return segments
}

export function joinSegments(segments: readonly string[]): string {
  return segments.join('/')
}

/** A vault key names one folder under `vaults/`: short, ASCII, no separators. */
export function isValidVaultKey(key: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(key) && key !== '..'
}

/** The same-origin URL the service worker answers for a vault file. */
export function vaultAssetUrl(vaultKey: string, relPath: string): string {
  const segments = splitVaultPath(relPath)
  return `/_vault/${encodeURIComponent(vaultKey)}/${segments.map(encodeURIComponent).join('/')}`
}

/** `/_vault/<key>/<path>` back to its parts, or null for anything else. */
export function parseVaultAssetUrl(pathname: string): { vaultKey: string; segments: string[] } | null {
  const match = /^\/_vault\/([^/]+)\/(.+)$/.exec(pathname)
  if (!match) return null
  try {
    const vaultKey = decodeURIComponent(match[1]!)
    if (!isValidVaultKey(vaultKey)) return null
    const segments = match[2]!.split('/').map((segment) => decodeURIComponent(segment))
    if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('/'))) {
      return null
    }
    return { vaultKey, segments }
  } catch {
    return null
  }
}
