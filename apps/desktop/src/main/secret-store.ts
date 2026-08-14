import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const KEYTAR_SERVICE = 'ZenNotes Remote Workspace'
const KEYTAR_ACCOUNT_PREFIX = 'remote-workspace:'
const CLOUD_KEYTAR_SERVICE = 'ZenNotes Cloud'
const CLOUD_KEYTAR_ACCOUNT_PREFIX = 'cloud:'
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

async function loadFallbackSecrets(): Promise<SecretMap> {
  try {
    const raw = await fs.readFile(fallbackPath(), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: SecretMap = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value.trim()) out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

async function saveFallbackSecrets(next: SecretMap): Promise<void> {
  await fs.mkdir(path.dirname(fallbackPath()), { recursive: true })
  await fs.writeFile(fallbackPath(), JSON.stringify(next, null, 2), 'utf8')
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

  const fallback = await loadFallbackSecrets()
  if (secret && secret.trim()) {
    const encoded = encodeSecret(secret.trim())
    if (!encoded) return false
    fallback[normalizedId] = encoded
  } else {
    delete fallback[normalizedId]
  }
  await saveFallbackSecrets(fallback)
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
  delete fallback[normalizedId]
  await saveFallbackSecrets(fallback)
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
  const fallback = await loadFallbackSecrets()
  fallback[cloudFallbackKey(normalizedBaseUrl)] = encoded
  await saveFallbackSecrets(fallback)
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
  delete fallback[key]
  await saveFallbackSecrets(fallback)
}
