const WINDOWS_RESERVED_CHARACTERS = /[:*?"<>|]/
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const LOCAL_ONLY_DIRECTORIES = new Set(['.git', '.hg', '.svn', 'node_modules'])

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
    lower.startsWith('.zennotes/templates/') ||
    lower.startsWith('.zennotes/workflows/')
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
