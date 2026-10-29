const WINDOWS_RESERVED_CHARACTERS = /[:*?"<>|]/
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
// Mobile app storage can sit inside a user-selected Documents vault. Its
// bookkeeping must never become either a sync source or a remote destination.
const LOCAL_ONLY_DIRECTORIES = new Set(['.git', '.hg', '.svn', 'node_modules', 'zennotes-cloud-sync'])

function invalidSyncPath(path: string): never {
  throw new Error(`Invalid sync path: ${JSON.stringify(path)}`)
}

/**
 * Return the portable, vault-relative representation used by the sync wire
 * protocol. ZenNotes vaults may move between case-sensitive and
 * case-insensitive file systems, so paths accepted here must be valid on all
 * supported platforms.
 */
export function normalizeCloudSyncPath(path: string): string {
  const normalized = path.replaceAll('\\', '/').normalize('NFC')

  if (
    normalized === '' ||
    normalized.startsWith('/') ||
    normalized.endsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    CONTROL_CHARACTERS.test(normalized)
  ) {
    return invalidSyncPath(path)
  }

  const segments = normalized.split('/')
  if (
    segments.some(
      (segment) =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        WINDOWS_RESERVED_CHARACTERS.test(segment)
    )
  ) {
    return invalidSyncPath(path)
  }

  return normalized
}

/** A case-folded collision key; the original path remains user-visible. */
export function cloudSyncPathKey(path: string): string {
  return normalizeCloudSyncPath(path).toLowerCase()
}

/**
 * Whether a vault file is user-authored state that should cross devices.
 * Unknown files inside `.zennotes` default to local-only so a new cache or
 * credential file cannot silently enter sync.
 */
export function shouldSyncVaultPath(path: string): boolean {
  let normalized: string
  try {
    normalized = normalizeCloudSyncPath(path)
  } catch {
    return false
  }

  const lower = normalized.toLowerCase()
  const segments = lower.split('/')
  const name = lower.slice(lower.lastIndexOf('/') + 1)

  if (
    segments.some((segment) => LOCAL_ONLY_DIRECTORIES.has(segment)) ||
    name === '.ds_store' ||
    name === 'thumbs.db' ||
    name.endsWith('.tmp') ||
    name.endsWith('.bak') ||
    name.endsWith('~')
  ) {
    return false
  }

  if (!lower.startsWith('.zennotes/')) {
    return true
  }

  return (
    lower === '.zennotes/vault.json' ||
    lower.startsWith('.zennotes/comments/') ||
    // What a note said before an assistant edited it, so the change can be
    // reviewed on whichever device the user picks up next.
    (lower.startsWith('.zennotes/agent-edits/') && lower.endsWith('.json')) ||
    (lower.startsWith('.zennotes/note-metadata/') && lower.endsWith('.metadata.json')) ||
    lower.startsWith('.zennotes/templates/') ||
    lower.startsWith('.zennotes/workflows/')
  )
}

/**
 * The longest path ZenNotes Cloud takes, in characters as its request rules
 * count them (max:1024 on a mutation's path and on a direct upload's).
 */
export const CLOUD_SYNC_MAX_PATH_CHARACTERS = 1024

/**
 * Whether Cloud takes a path of this length. Cloud counts characters (code
 * points), so a path outside the BMP may run past 1,024 UTF-16 units.
 *
 * This is not part of shouldSyncVaultPath on purpose. A path too long for
 * Cloud belongs in sync as much as any other, and leaving it out of the scan
 * would make a note renamed to one look deleted: Cloud and every other device
 * would lose it. The coordinator holds it the way it holds a path Cloud
 * refused, without the request Cloud would refuse, and Settings asks for a
 * shorter path.
 */
export function cloudSyncPathFitsCloud(path: string): boolean {
  return (
    path.length <= CLOUD_SYNC_MAX_PATH_CHARACTERS ||
    Array.from(path).length <= CLOUD_SYNC_MAX_PATH_CHARACTERS
  )
}

/** The one file under `.zennotes` that carries user-authored vault settings. */
export const CLOUD_SYNC_VAULT_SETTINGS_PATH = '.zennotes/vault.json'

/**
 * Where the cloud's settings wait while the user decides which side to keep.
 *
 * Settings are not a note: a numbered pile of conflict copies inside a hidden
 * folder is not something anyone can act on, so the newest remote version
 * lands at one fixed path and the app asks. The local settings stay in use
 * until the user says otherwise.
 */
export const CLOUD_SYNC_SETTINGS_CONFLICT_PATH = '.zennotes/vault.cloud-conflict.json'

export function isCloudSyncVaultSettingsPath(path: string): boolean {
  try {
    return normalizeCloudSyncPath(path).toLowerCase() === CLOUD_SYNC_VAULT_SETTINGS_PATH
  } catch {
    return false
  }
}

/**
 * Where a remote version is parked when it cannot replace the local file.
 *
 * Sync refuses to overwrite a file it cannot vouch for, and refusing used to
 * stop the whole run: the cursor never advanced, so every later sync retried
 * the same change and failed the same way, forever. Keeping both versions ends
 * that. The local file stays exactly where it is and the incoming one lands
 * beside it, which is the outcome every other sync tool converged on because
 * it cannot lose either side.
 */
export function cloudSyncConflictCopyPath(path: string, attempt: number): string {
  const normalized = normalizeCloudSyncPath(path)
  const slash = normalized.lastIndexOf('/')
  const directory = slash === -1 ? '' : normalized.slice(0, slash + 1)
  const name = normalized.slice(slash + 1)
  // A leading dot is part of the name, not an extension: `.gitignore` keeps it.
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  const suffix = attempt > 1 ? `(cloud conflict ${attempt})` : '(cloud conflict)'
  return `${directory}${stem} ${suffix}${extension}`
}

/**
 * The first free name beside `path` for a file that has to make room:
 * `Note 2.md`, then `Note 3.md`, the names the app gives a note moved into a
 * folder that already holds one of the same name (Move to Trash, Archive).
 * `taken` answers for this device; nothing here knows what Cloud holds.
 */
export async function cloudSyncFreePath(
  path: string,
  taken: (candidate: string) => Promise<boolean>
): Promise<string> {
  const normalized = normalizeCloudSyncPath(path)
  const slash = normalized.lastIndexOf('/')
  const directory = slash === -1 ? '' : normalized.slice(0, slash + 1)
  const name = normalized.slice(slash + 1)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  for (let n = 2; n <= 10_000; n++) {
    const candidate = `${directory}${stem} ${n}${extension}`
    if (!(await taken(candidate))) return candidate
  }
  throw new Error(`Every name for “${normalized}” is taken. Rename a few of those files, then try again.`)
}

/** Recognize copies created by pre-v2.44 sync without treating them as safe
 * to delete. The returned original path is only a review hint. */
export function cloudSyncLegacyConflictOriginalPath(value: string): string | null {
  let normalized: string
  try {
    normalized = normalizeCloudSyncPath(value)
  } catch {
    return null
  }
  const slash = normalized.lastIndexOf('/')
  const directory = slash === -1 ? '' : normalized.slice(0, slash + 1)
  const name = normalized.slice(slash + 1)
  const match = /^(.*) \(cloud conflict(?: (?:[2-9]|[1-9]\d+))?\)((?:\.[^.]*)*)$/.exec(name)
  if (!match?.[1]) return null
  return `${directory}${match[1]}${match[2] ?? ''}`
}

/** Skip large device-local trees before reading their contents. */
export function shouldTraverseCloudSyncDirectory(path: string): boolean {
  let normalized: string
  try {
    normalized = normalizeCloudSyncPath(path)
  } catch {
    return false
  }

  return !normalized
    .toLowerCase()
    .split('/')
    .some((segment) => LOCAL_ONLY_DIRECTORIES.has(segment))
}
