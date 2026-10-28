import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const KEYTAR_SERVICE = 'ZenNotes Remote Workspace'
const KEYTAR_ACCOUNT_PREFIX = 'remote-workspace:'
const CLOUD_KEYTAR_SERVICE = 'ZenNotes Cloud'
const CLOUD_KEYTAR_ACCOUNT_PREFIX = 'cloud:'
const CLOUD_E2EE_ACCOUNT_PREFIX = 'cloud-e2ee:'
const FALLBACK_FILE = 'remote-workspace-secrets.json'

let warnedAboutFallback = false
let warnedAboutMissingSecureStorage = false

type KeytarModule = {
  getPassword(service: string, account: string): Promise<string | null>
  setPassword(service: string, account: string, password: string): Promise<void>
  deletePassword(service: string, account: string): Promise<boolean>
}

type SecretMap = Record<string, string>

function accountName(id: string): string {
  return `${KEYTAR_ACCOUNT_PREFIX}${id}`
}

function fallbackPath(): string {
  return path.join(app.getPath('userData'), FALLBACK_FILE)
}

async function loadKeytar(): Promise<KeytarModule | null> {
  try {
    const mod = (await import('keytar')) as Partial<KeytarModule> | { default?: Partial<KeytarModule> }
    const candidate = ('default' in mod ? mod.default : mod) as Partial<KeytarModule> | undefined
    if (
      candidate &&
      typeof candidate.getPassword === 'function' &&
      typeof candidate.setPassword === 'function' &&
      typeof candidate.deletePassword === 'function'
    ) {
      return candidate as KeytarModule
    }
  } catch {
    // keytar is optional; safeStorage fallback handles the common case.
  }
  return null
}

class UnreadableSecretsFile extends Error {}

/** A missing file is an empty store; a file that cannot be parsed is not. */
async function readFallbackSecrets(): Promise<SecretMap> {
  let raw: string
  try {
    raw = await fs.readFile(fallbackPath(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new UnreadableSecretsFile('The ZenNotes secrets file could not be read.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UnreadableSecretsFile('The ZenNotes secrets file is not a secrets map.')
  }
  const out: SecretMap = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string' && value.trim()) out[key] = value
  }
  return out
}

/** Reads never fail a caller: an unreadable store simply holds nothing usable. */
async function loadFallbackSecrets(): Promise<SecretMap> {
  try {
    return await readFallbackSecrets()
  } catch (error) {
    console.warn('[secrets] could not read the secrets file:', (error as Error).message)
    return {}
  }
}

let fallbackUpdates: Promise<unknown> = Promise.resolve()

/**
 * Every change reads, edits and replaces the file inside one queue, so two
 * sign-ins at once cannot drop each other's entry. An unreadable file is moved
 * aside, never overwritten: its other entries stay recoverable by hand.
 */
function updateFallbackSecrets(edit: (secrets: SecretMap) => void): Promise<void> {
  const run = fallbackUpdates.then(async () => {
    let secrets: SecretMap
    try {
      secrets = await readFallbackSecrets()
    } catch (error) {
      if (!(error instanceof UnreadableSecretsFile)) throw error
      const aside = `${fallbackPath()}.unreadable-${Date.now()}`
      await fs.rename(fallbackPath(), aside)
      console.warn(`[secrets] moved an unreadable secrets file aside to ${aside}`)
      secrets = {}
    }
    edit(secrets)
    await saveFallbackSecrets(secrets)
  })
  fallbackUpdates = run.catch(() => {})
  return run
}

/** Written to a private temporary file, synced, then renamed over the old one. */
async function saveFallbackSecrets(next: SecretMap): Promise<void> {
  const target = fallbackPath()
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  const handle = await fs.open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(next, null, 2), 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fs.rename(temporary, target)
  } catch (error) {
    await fs.rm(temporary, { force: true })
    throw error
  }
  await fs.chmod(target, 0o600).catch(() => {})
}

function encodeSecret(secret: string): string | null {
  if (!safeStorage.isEncryptionAvailable()) {
    if (!warnedAboutMissingSecureStorage) {
      warnedAboutMissingSecureStorage = true
      console.warn(
        'ZenNotes could not persist a remote workspace token securely because no OS secret store is available.' +
          (process.platform === 'linux'
            ? ' If a Secret Service keyring is running, launch ZenNotes with --password-store=gnome-libsecret.'
            : '')
      )
    }
    return null
  }
  if (!warnedAboutFallback) {
    warnedAboutFallback = true
    console.warn('ZenNotes is using Electron safeStorage as the fallback remote credential store.')
  }
  return safeStorage.encryptString(secret).toString('base64')
}

function decodeSecret(encoded: string): string | null {
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
  } catch {
    return null
  }
}

export async function getRemoteWorkspaceSecret(id: string): Promise<string | null> {
  const normalizedId = id.trim()
  if (!normalizedId) return null

  const keytar = await loadKeytar()
  if (keytar) {
    return await keytar.getPassword(KEYTAR_SERVICE, accountName(normalizedId))
  }

  const fallback = await loadFallbackSecrets()
  const encoded = fallback[normalizedId]
  return encoded ? decodeSecret(encoded) : null
}

export async function setRemoteWorkspaceSecret(id: string, secret: string | null): Promise<boolean> {
  const normalizedId = id.trim()
  if (!normalizedId) return false

  const keytar = await loadKeytar()
  if (keytar) {
    if (secret && secret.trim()) {
      await keytar.setPassword(KEYTAR_SERVICE, accountName(normalizedId), secret.trim())
    } else {
      await keytar.deletePassword(KEYTAR_SERVICE, accountName(normalizedId))
    }
    return Boolean(secret && secret.trim())
  }

  if (secret && secret.trim()) {
    const encoded = encodeSecret(secret.trim())
    if (!encoded) return false
    await updateFallbackSecrets((fallback) => {
      fallback[normalizedId] = encoded
    })
  } else {
    await updateFallbackSecrets((fallback) => {
      delete fallback[normalizedId]
    })
  }
  return Boolean(secret && secret.trim())
}

export async function deleteRemoteWorkspaceSecret(id: string): Promise<void> {
  const normalizedId = id.trim()
  if (!normalizedId) return

  const keytar = await loadKeytar()
  if (keytar) {
    await keytar.deletePassword(KEYTAR_SERVICE, accountName(normalizedId))
    return
  }

  const fallback = await loadFallbackSecrets()
  if (!(normalizedId in fallback)) return
  await updateFallbackSecrets((secrets) => {
    delete secrets[normalizedId]
  })
}

function cloudFallbackKey(baseUrl: string): string {
  return `${CLOUD_KEYTAR_ACCOUNT_PREFIX}${baseUrl}`
}

export async function getCloudServiceSecret(baseUrl: string): Promise<string | null> {
  const normalizedBaseUrl = baseUrl.trim()
  if (!normalizedBaseUrl) return null

  const keytar = await loadKeytar()
  if (keytar) {
    return await keytar.getPassword(
      CLOUD_KEYTAR_SERVICE,
      `${CLOUD_KEYTAR_ACCOUNT_PREFIX}${normalizedBaseUrl}`
    )
  }

  const fallback = await loadFallbackSecrets()
  const encoded = fallback[cloudFallbackKey(normalizedBaseUrl)]
  return encoded ? decodeSecret(encoded) : null
}

export async function setCloudServiceSecret(baseUrl: string, secret: string): Promise<boolean> {
  const normalizedBaseUrl = baseUrl.trim()
  const normalizedSecret = secret.trim()
  if (!normalizedBaseUrl || !normalizedSecret) return false

  const keytar = await loadKeytar()
  if (keytar) {
    await keytar.setPassword(
      CLOUD_KEYTAR_SERVICE,
      `${CLOUD_KEYTAR_ACCOUNT_PREFIX}${normalizedBaseUrl}`,
      normalizedSecret
    )
    return true
  }

  const encoded = encodeSecret(normalizedSecret)
  if (!encoded) return false
  await updateFallbackSecrets((fallback) => {
    fallback[cloudFallbackKey(normalizedBaseUrl)] = encoded
  })
  return true
}

export async function deleteCloudServiceSecret(baseUrl: string): Promise<void> {
  const normalizedBaseUrl = baseUrl.trim()
  if (!normalizedBaseUrl) return

  const keytar = await loadKeytar()
  if (keytar) {
    await keytar.deletePassword(
      CLOUD_KEYTAR_SERVICE,
      `${CLOUD_KEYTAR_ACCOUNT_PREFIX}${normalizedBaseUrl}`
    )
    return
  }

  const fallback = await loadFallbackSecrets()
  const key = cloudFallbackKey(normalizedBaseUrl)
  if (!(key in fallback)) return
  await updateFallbackSecrets((secrets) => {
    delete secrets[key]
  })
}

/**
 * The unlocked end-to-end encryption account key for one Cloud account, kept
 * only in the OS-protected store. It is a cache: the passphrase or recovery
 * key can always unlock the account again, so a lost entry costs a prompt,
 * never data. Scoped by account so a second account never reads it.
 */
function cloudAccountKeyName(baseUrl: string, accountEmail: string): string {
  return `${CLOUD_E2EE_ACCOUNT_PREFIX}${baseUrl.trim()}#${accountEmail.trim().toLowerCase()}`
}

export async function getCloudAccountKeySecret(baseUrl: string, accountEmail: string): Promise<string | null> {
  const name = cloudAccountKeyName(baseUrl, accountEmail)
  const keytar = await loadKeytar()
  if (keytar) return keytar.getPassword(CLOUD_KEYTAR_SERVICE, name)
  const encoded = (await loadFallbackSecrets())[name]
  return encoded ? decodeSecret(encoded) : null
}

export async function setCloudAccountKeySecret(
  baseUrl: string,
  accountEmail: string,
  value: string
): Promise<boolean> {
  const name = cloudAccountKeyName(baseUrl, accountEmail)
  const keytar = await loadKeytar()
  if (keytar) {
    await keytar.setPassword(CLOUD_KEYTAR_SERVICE, name, value)
    return true
  }
  const encoded = encodeSecret(value)
  if (!encoded) return false
  await updateFallbackSecrets((fallback) => {
    fallback[name] = encoded
  })
  return true
}

export async function deleteCloudAccountKeySecret(baseUrl: string, accountEmail: string): Promise<void> {
  const name = cloudAccountKeyName(baseUrl, accountEmail)
  const keytar = await loadKeytar()
  if (keytar) {
    await keytar.deletePassword(CLOUD_KEYTAR_SERVICE, name)
    return
  }
  if (!(name in (await loadFallbackSecrets()))) return
  await updateFallbackSecrets((fallback) => {
    delete fallback[name]
  })
}

/** Deletes every account key stored for one Cloud service, whichever account it belonged to. */
export async function deleteCloudAccountKeySecrets(baseUrl: string): Promise<void> {
  const prefix = `${CLOUD_E2EE_ACCOUNT_PREFIX}${baseUrl.trim()}#`
  const stale = Object.keys(await loadFallbackSecrets()).filter((name) => name.startsWith(prefix))
  if (stale.length === 0) return
  await updateFallbackSecrets((fallback) => {
    for (const name of stale) delete fallback[name]
  })
}

const UNSPLASH_KEYTAR_SERVICE = 'ZenNotes Unsplash'
const UNSPLASH_ACCESS_KEY_NAME = 'unsplash:access-key'

/**
 * The person's own Unsplash Access Key, for the cover picker's Unsplash tab.
 * Kept only in the OS-protected store, like the Cloud credential: never in
 * config.toml, vault.json or anything the renderer keeps (main tells the
 * renderer only whether there is one).
 */
export async function getUnsplashAccessKeySecret(): Promise<string | null> {
  const keytar = await loadKeytar()
  if (keytar) return keytar.getPassword(UNSPLASH_KEYTAR_SERVICE, UNSPLASH_ACCESS_KEY_NAME)
  const encoded = (await loadFallbackSecrets())[UNSPLASH_ACCESS_KEY_NAME]
  return encoded ? decodeSecret(encoded) : null
}

export async function setUnsplashAccessKeySecret(key: string): Promise<boolean> {
  const normalized = key.trim()
  if (!normalized) return false
  const keytar = await loadKeytar()
  if (keytar) {
    await keytar.setPassword(UNSPLASH_KEYTAR_SERVICE, UNSPLASH_ACCESS_KEY_NAME, normalized)
    return true
  }
  const encoded = encodeSecret(normalized)
  if (!encoded) return false
  await updateFallbackSecrets((fallback) => {
    fallback[UNSPLASH_ACCESS_KEY_NAME] = encoded
  })
  return true
}

export async function deleteUnsplashAccessKeySecret(): Promise<void> {
  const keytar = await loadKeytar()
  if (keytar) {
    await keytar.deletePassword(UNSPLASH_KEYTAR_SERVICE, UNSPLASH_ACCESS_KEY_NAME)
    return
  }
  if (!(UNSPLASH_ACCESS_KEY_NAME in (await loadFallbackSecrets()))) return
  await updateFallbackSecrets((fallback) => {
    delete fallback[UNSPLASH_ACCESS_KEY_NAME]
  })
}

/** Whether a secret saved now would be encrypted by the OS. */
export function canStoreSecretsSecurely(): boolean {
  return safeStorage.isEncryptionAvailable()
}
