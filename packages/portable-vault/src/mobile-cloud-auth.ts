import type {
  CloudAccountConnectResult,
  CloudAccountStatus,
  CloudPublishedNote,
  CloudPublishedNoteResult,
  CloudPublishNoteInput,
  CloudServiceAccount,
  CloudSyncVault
} from '@zennotes/bridge-contract/cloud-sync'
import {
  CloudAuthFlow,
  parseCloudAuthCallback,
  parseCloudAuthFragmentCallback,
  type CloudAuthCredential,
  type CloudAuthExchangeRequest,
  type CloudAuthPending,
  type CloudAuthStorage
} from '@zennotes/shared-domain/cloud-auth-flow'
import {
  CloudE2eeKeyring,
  type CloudAccountKeyStore,
  type StoredCloudAccountKey
} from '@zennotes/shared-domain/cloud-e2ee-account'
import { createCloudSyncClient, firstValidationMessage, stopMobileCloudRequests, resumeMobileCloudRequests, mobileCloudRequestSignal } from './cloud-sync-client'
import { publishWithStagedUploads, type CloudPublishAssetPlatform } from '@zennotes/shared-domain/cloud-publish-uploads'
import { portableHost } from './host'

const PRODUCTION_CLOUD_BASE_URL = 'https://zennotes.org'
const LEGACY_CLOUD_BASE_URL = 'https://zennotes.laravel.cloud'

/** The host's development service, if its build names one. The trailing-slash
 *  strip matters: allowedInsecureOrigins and the exchange URL are
 *  compared/joined against an origin with no trailing slash. */
function developmentCloudBaseUrl(): string | undefined {
  return portableHost().shell.cloud.developmentBaseUrl?.trim().replace(/\/+$/, '') || undefined
}

function defaultCloudBaseUrl(): string {
  return developmentCloudBaseUrl() || PRODUCTION_CLOUD_BASE_URL
}
const PENDING_AUTH_KEY = 'pending-auth'
/** The browser keeps each pending sign-in by its state (`pending-auth:<state>`):
 *  the callback can land in another tab than the one that started it. */
const PENDING_AUTH_BY_STATE_PREFIX = 'pending-auth:'
const CREDENTIAL_KEY = 'credential'
/** The two ways the phones name an account's unlocked key: the iPhone by its
 *  account (`cloud-e2ee:<base url>#<email>`), Android by a fingerprint of it.
 *  Keys a device already holds live under its own scheme, so the host keeps
 *  choosing it (HostCloudConfig.accountKeyScheme); every sweep matches both. */
const ACCOUNT_KEY_PREFIXES = { labeled: 'cloud-e2ee:', hashed: 'e2ee-account-key.' } as const
const accountListeners = new Set<(status: CloudAccountStatus) => void>()

/**
 * This app opens every path an end-to-end encrypted vault's bytes take:
 * inline content through the shared client, references through native
 * staging decryption, large uploads sealed natively, and backup archives
 * refused on the phone. Only with all of them in place may it tell the
 * service it can serve encrypted vaults (docs/specs/cloud-e2ee.md).
 */
export const MOBILE_END_TO_END_ENCRYPTION = true

let authFlow: CloudAuthFlow | null = null
let callbackQueue = Promise.resolve()
let appActive = true

function secrets() {
  return portableHost().secrets
}

// Lazy and retryable so a transient native storage failure does not poison
// every later account read for the session. The host's prepare step is where
// a phone configures its secure store (the iPhone sets its Keychain access
// and moves records an older build kept under the plugin's default prefix);
// every storage call below awaits it, so none sees a half-configured store.
let secureStorageSetup: Promise<void> | null = null
function secureStorageReady(): Promise<void> {
  const store = secrets()
  if (!store.available()) return Promise.resolve()
  if (!secureStorageSetup) {
    secureStorageSetup = (async () => { await store.prepare?.() })()
    secureStorageSetup.catch(() => {
      secureStorageSetup = null
    })
  }
  return secureStorageSetup
}

/** A host whose sign-in returns to a web page keeps pending sign-ins by
 *  state (the browser); the phones keep one. */
function pendingByState(): boolean {
  return !!portableHost().shell.cloud.callbackUrl
}

function pendingKey(state: string): string | null {
  return /^[A-Za-z0-9._-]{1,128}$/.test(state) ? `${PENDING_AUTH_BY_STATE_PREFIX}${state}` : null
}

/** The unexpired pending sign-in that lasts longest, any state; expired
 *  ones are removed on the way. */
async function newestPendingByState(): Promise<unknown> {
  let newest: { value: unknown; expires: number } | null = null
  for (const key of await secrets().keys()) {
    if (!key.startsWith(PENDING_AUTH_BY_STATE_PREFIX)) continue
    const value = parseStoredJson(await secrets().get(key))
    const expires = isRecord(value) && typeof value.expires_at === 'string' ? Date.parse(value.expires_at) : NaN
    if (!Number.isFinite(expires) || expires <= Date.now()) {
      await secrets().remove(key)
      continue
    }
    if (!newest || expires > newest.expires) newest = { value, expires }
  }
  return newest?.value ?? null
}

const storage: CloudAuthStorage = {
  async loadPending(state?: string): Promise<unknown> {
    if (!secrets().available()) return null
    await secureStorageReady()
    if (!pendingByState()) return parseStoredJson(await secrets().get(PENDING_AUTH_KEY))
    if (state === undefined) return newestPendingByState()
    // Completing a sign-in takes its record out as it reads it, so one
    // callback is used once, whichever tab it lands in.
    const key = pendingKey(state)
    if (!key) return null
    const raw = await secrets().get(key)
    if (raw !== null) await secrets().remove(key)
    return parseStoredJson(raw)
  },
  async savePending(pending: CloudAuthPending): Promise<void> {
    assertNativeCloudAuth()
    await secureStorageReady()
    if (!pendingByState()) {
      await secrets().set(PENDING_AUTH_KEY, JSON.stringify(pending))
      return
    }
    const key = pendingKey(pending.state)
    if (!key) throw new Error('ZenNotes could not create a secure cloud sign-in request.')
    await secrets().set(key, JSON.stringify(pending))
  },
  async deletePending(state?: string): Promise<void> {
    if (!secrets().available()) return
    await secureStorageReady()
    if (!pendingByState()) {
      await secrets().remove(PENDING_AUTH_KEY)
      return
    }
    if (state !== undefined) {
      const key = pendingKey(state)
      if (key) await secrets().remove(key)
      return
    }
    for (const key of await secrets().keys()) {
      if (key.startsWith(PENDING_AUTH_BY_STATE_PREFIX)) await secrets().remove(key)
    }
  },
  async loadCredential(): Promise<unknown> {
    if (!secrets().available()) return null
    await secureStorageReady()
    const credential = migrateLegacyCloudCredential(
      parseStoredJson(await secrets().get(CREDENTIAL_KEY))
    )
    if (credential.migrated) {
      await secrets().set(CREDENTIAL_KEY, JSON.stringify(credential.value))
    }
    return credential.value
  },
  async saveCredential(credential: CloudAuthCredential): Promise<void> {
    stopMobileCloudRequests()
    forgetKeyring()
    assertNativeCloudAuth()
    await secureStorageReady()
    const canonicalCredential = migrateLegacyCloudCredential(credential).value as CloudAuthCredential
    // Another account's encryption key does not outlive a switch to this one;
    // signing in again to the same account keeps this device unlocked. Each
    // entry belongs to one account and can never unlock another, so a failed
    // sweep must not block signing in; signing out sweeps again and must work.
    await clearAccountKeys(await accountKeyName(canonicalCredential)).catch(() => {})
    await secrets().set(CREDENTIAL_KEY, JSON.stringify(canonicalCredential))
    if (appActive) resumeMobileCloudRequests()
  },
  async deleteCredential(): Promise<void> {
    stopMobileCloudRequests()
    forgetKeyring()
    if (!secrets().available()) return
    await secureStorageReady()
    // Signing out also forgets this device's encryption keys; the passphrase
    // or the recovery key unlocks the account again. Keys go first, so a
    // sweep that fails leaves the person signed in to try again rather than a
    // key outliving its credential.
    await clearAccountKeys()
    await secrets().remove(CREDENTIAL_KEY)
  }
}

/**
 * One account's unlocked end-to-end encryption key, in the host's secure
 * store (the phones' Keychain and Keystore, whenUnlockedThisDeviceOnly and no
 * iCloud sync on the iPhone). It is a cache: the passphrase or the recovery
 * key can always unlock it again. So a missing or unreadable entry reads as
 * locked: an Android install restored from a backup gets the stored value
 * back without the Keystore key that decrypts it, and a Keychain item can be
 * out of reach while the device is locked during background work. Either
 * must ask for the passphrase again rather than fail every read.
 */
export function mobileCloudAccountKeyStore(
  credential: Pick<CloudAuthCredential, 'base_url' | 'account'>
): CloudAccountKeyStore {
  return {
    async load(): Promise<StoredCloudAccountKey | null> {
      if (!secrets().available()) return null
      try {
        await secureStorageReady()
        return parseStoredAccountKey(await secrets().get(await accountKeyName(credential)))
      } catch {
        return null
      }
    },
    async save(value: StoredCloudAccountKey): Promise<void> {
      assertNativeCloudAuth()
      await secureStorageReady()
      await secrets().set(await accountKeyName(credential), JSON.stringify(value))
    },
    async clear(): Promise<void> {
      if (!secrets().available()) return
      await secureStorageReady()
      await secrets().remove(await accountKeyName(credential))
    }
  }
}

function parseStoredAccountKey(raw: string | null): StoredCloudAccountKey | null {
  if (raw === null) return null
  try {
    const value = JSON.parse(raw) as Partial<StoredCloudAccountKey> | null
    // A 32-byte key is 44 base64 characters; anything else could never open a vault.
    return value?.format === 1 && typeof value.key === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value.key) &&
      typeof value.version === 'number' && Number.isInteger(value.version) && value.version >= 0
      ? { format: 1, key: value.key, version: value.version }
      : null
  } catch {
    return null
  }
}

async function accountKeyName(credential: Pick<CloudAuthCredential, 'base_url' | 'account'>): Promise<string> {
  const email = credential.account.user.email.trim().toLowerCase()
  if ((portableHost().shell.cloud.accountKeyScheme ?? 'labeled') === 'labeled') {
    return `${ACCOUNT_KEY_PREFIXES.labeled}${credential.account.base_url.trim()}#${email}`
  }
  const scope = `${credential.base_url.trim().replace(/\/+$/, '')}\n${email}`
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(scope))
  return ACCOUNT_KEY_PREFIXES.hashed + [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Every stored account key but `keep`, under either scheme. Callers have
 *  awaited the ready gate. */
async function clearAccountKeys(keep: string | null = null): Promise<void> {
  const prefixes = Object.values(ACCOUNT_KEY_PREFIXES)
  for (const name of await secrets().keys()) {
    if (prefixes.some((prefix) => name.startsWith(prefix)) && name !== keep) await secrets().remove(name)
  }
}

let keyringCache: { scope: string; keyring: CloudE2eeKeyring } | null = null

/** Which signed-in credential this is: the account, and the token that signs
 *  in as it. An email that differs only in letter case is the same account. */
export function mobileCloudCredentialScope(credential: CloudAuthCredential): string {
  return JSON.stringify([credential.base_url, credential.account.user.email.toLowerCase(), credential.token])
}

/**
 * One keyring per signed-in credential, so the answers to "is this vault
 * encrypted" and the opened ciphers last across calls but never across
 * accounts or sign-ins.
 */
export function mobileCloudKeyring(credential: CloudAuthCredential): CloudE2eeKeyring {
  const scope = mobileCloudCredentialScope(credential)
  if (keyringCache?.scope === scope) return keyringCache.keyring
  forgetKeyring()
  const keyring = new CloudE2eeKeyring({
    // A plain client: the keyring needs only each vault's encryption fields.
    listVaults: async () => (await createCloudSyncClient(credential.base_url, credential.token, {
      accountId: credential.account.user.email,
      signal: mobileCloudRequestSignal()
    }).listVaults()).data,
    store: mobileCloudAccountKeyStore(credential)
  })
  keyringCache = { scope, keyring }
  return keyring
}

function forgetKeyring(): void {
  keyringCache?.keyring.forget()
  keyringCache = null
}

export async function configureMobileCloudAuth(appVersion: string): Promise<void> {
  if (authFlow) return

  const { shell, lifecycle } = portableHost()
  const developmentBaseUrl = developmentCloudBaseUrl()
  authFlow = new CloudAuthFlow({
    platform: shell.cloud.platform,
    appVersion,
    deviceName: shell.cloud.deviceName,
    storage,
    openExternal: openExternalBrowser,
    exchange: exchangeCloudAuthCode,
    revoke: revokeCloudDevice,
    allowInsecureLoopback: shell.cloud.allowInsecureLoopback,
    allowedInsecureOrigins: developmentBaseUrl
      ? [developmentBaseUrl]
      : undefined,
    ...(shell.cloud.callbackUrl ? { callbackUrl: shell.cloud.callbackUrl } : {}),
    ...(shell.cloud.authLifetimeMs ? { authLifetimeMs: shell.cloud.authLifetimeMs } : {})
  })

  await lifecycle.onOpenUrl((url) => {
    if (isCloudAuthUrl(url)) scheduleAuthCallback(url)
  })
  await lifecycle.onActiveChange((isActive) => {
    appActive = isActive
    // Leaving stops Cloud requests, after a final sync when background sync
    // is on (the phones' background-sync.ts).
    if (isActive) lifecycle.returnedToApp()
    else lifecycle.leftApp()
  })
  const launch = await lifecycle.launchUrl()
  if (launch && isCloudAuthUrl(launch)) scheduleAuthCallback(launch)
}

/** The scheme is shared with the widget links (ui-mobile/widget-links.ts);
 *  only `zennotes://auth…` is this module's to handle, and in the browser the
 *  host's own callback page. */
function isCloudAuthUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl.trim())
    const callbackUrl = portableHost().shell.cloud.callbackUrl
    if (callbackUrl) {
      const expected = new URL(callbackUrl)
      if (parsed.origin === expected.origin && parsed.pathname === expected.pathname) return true
    }
    return (
      parsed.protocol === 'zennotes:' &&
      (parsed.hostname || parsed.pathname.replace(/^\/+/, '')) === 'auth'
    )
  } catch {
    return false
  }
}

function parseAuthCallback(rawUrl: string) {
  const callbackUrl = portableHost().shell.cloud.callbackUrl
  return callbackUrl
    ? parseCloudAuthFragmentCallback(rawUrl, callbackUrl) ?? parseCloudAuthCallback(rawUrl)
    : parseCloudAuthCallback(rawUrl)
}

/**
 * Finishes a sign-in from its callback URL and says how it went: the browser
 * runs this on its callback page before anything else, and shows the error
 * where the phones log it. Calls queue behind each other, like the deep links.
 */
export function completeMobileCloudSignIn(rawUrl: string): Promise<CloudAccountStatus> {
  const callback = parseAuthCallback(rawUrl)
  if (!callback) return Promise.reject(new Error('This sign-in link is not complete. Start signing in again.'))
  const run = callbackQueue.then(async () => {
    const status = await requireAuthFlow().complete(callback)
    notify(status)
    return status
  })
  callbackQueue = run.then(() => undefined, () => undefined)
  return run
}

/** Tells this tab's listeners the account changed elsewhere (another tab
 *  finished signing in or signed out); they read the status again. */
export async function refreshMobileCloudAccountStatus(): Promise<CloudAccountStatus> {
  stopMobileCloudRequests()
  forgetKeyring()
  const status = await requireAuthFlow().status()
  if (appActive && status.state === 'connected') resumeMobileCloudRequests()
  notify(status)
  return status
}

export async function getMobileCloudAccountStatus(): Promise<CloudAccountStatus> {
  return requireAuthFlow().status()
}

export async function connectMobileCloudAccount(
  baseUrl?: string
): Promise<CloudAccountConnectResult> {
  assertNativeCloudAuth()
  const result = await requireAuthFlow().connect(baseUrl ?? defaultCloudBaseUrl())
  await notifyAccountListeners()
  return result
}

export async function logoutMobileCloudAccount(): Promise<CloudAccountStatus> {
  stopMobileCloudRequests()
  const status = await requireAuthFlow().logout()
  notify(status)
  return status
}

export function onMobileCloudAccountChange(
  listener: (status: CloudAccountStatus) => void
): () => void {
  accountListeners.add(listener)
  return () => accountListeners.delete(listener)
}

export async function getMobileCloudServiceAccount(): Promise<CloudServiceAccount> {
  return (await authenticatedClient()).account().then((response) => response.data)
}

export async function listMobileCloudPublishedNotes(): Promise<CloudPublishedNote[]> {
  return (await authenticatedClient()).listPublishedNotes().then((response) => response.data)
}

/** Publish with the note's attachments staged straight to storage first
 *  (shared-domain's publishWithStagedUploads); a service without staged
 *  uploads gets the one-request publish. */
export async function publishMobileCloudNote<Handle>(
  input: CloudPublishNoteInput,
  assets: CloudPublishAssetPlatform<Handle>
): Promise<CloudPublishedNoteResult> {
  return await publishWithStagedUploads(await authenticatedClient(), input, assets)
}

export async function updateMobileCloudPublishedNote<Handle>(
  shareId: number,
  input: CloudPublishNoteInput,
  assets: CloudPublishAssetPlatform<Handle>
): Promise<CloudPublishedNoteResult> {
  return await publishWithStagedUploads(await authenticatedClient(), input, assets, { shareId })
}

export async function unpublishMobileCloudNote(shareId: number): Promise<void> {
  await (await authenticatedClient()).unpublishNote(shareId)
}

export async function listMobileCloudVaults(): Promise<CloudSyncVault[]> {
  return (await authenticatedClient()).listVaults().then((response) => response.data)
}

export async function authenticatedClient() {
  return (await mobileCloudConnection()).client
}

/** The signed-in account's client with its encryption keyring and this device's key store. */
export async function mobileCloudConnection() {
  const signal = mobileCloudRequestSignal()
  const credential = await authenticatedCredential()
  if (signal.aborted) throw new DOMException('Cloud account changed while loading credentials.', 'AbortError')
  const keyring = MOBILE_END_TO_END_ENCRYPTION ? mobileCloudKeyring(credential) : undefined
  return {
    credential,
    client: createCloudSyncClient(credential.base_url, credential.token, {
      accountId: credential.account.user.email,
      signal,
      ...(keyring ? { keyring } : {})
    }),
    keyring,
    keyStore: mobileCloudAccountKeyStore(credential)
  }
}

export async function authenticatedCredential(): Promise<CloudAuthCredential> {
  const credential = await requireAuthFlow().credential()
  if (!credential) throw new Error('Connect ZenNotes Cloud before using sync.')
  return credential
}

function scheduleAuthCallback(rawUrl: string): void {
  if (!parseAuthCallback(rawUrl)) {
    console.error('ZenNotes Cloud ignored an invalid auth callback URL.')
    return
  }
  completeMobileCloudSignIn(rawUrl).catch((error: unknown) => {
    console.error('ZenNotes Cloud could not complete the auth callback.', error)
  })
}

async function notifyAccountListeners(): Promise<void> {
  notify(await requireAuthFlow().status())
}

function notify(status: CloudAccountStatus): void {
  for (const listener of accountListeners) listener(status)
}

function requireAuthFlow(): CloudAuthFlow {
  if (!authFlow) throw new Error('ZenNotes Cloud is not ready yet.')
  return authFlow
}

function assertNativeCloudAuth(): void {
  if (!secrets().available()) {
    throw new Error('ZenNotes Cloud sign-in is only available in the native app.')
  }
}

async function openExternalBrowser(url: string): Promise<void> {
  const shell = portableHost().shell
  if (shell.openExternal) {
    await shell.openExternal(url)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

async function exchangeCloudAuthCode(
  baseUrl: string,
  request: CloudAuthExchangeRequest
): Promise<unknown> {
  const response = await portableHost().http.request({
    method: 'POST',
    url: `${baseUrl}/api/v1/app/exchange`,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    data: request,
    connectTimeout: 30_000,
    readTimeout: 30_000
  })

  if (response.status < 200 || response.status >= 300) {
    const payload = isRecord(response.data) ? response.data : {}
    const error = isRecord(payload.error) ? payload.error : {}
    const message =
      firstValidationMessage(payload.errors) ??
      (typeof error.message === 'string'
        ? error.message
        : typeof payload.message === 'string'
          ? payload.message
          : 'ZenNotes Cloud rejected this sign-in request.')
    // The status and code travel with the message: the browser tells "not
    // available for this account yet" (403 CLOUD_WEB_NOT_ENABLED) apart.
    throw new CloudSignInRefusedError(message, response.status, typeof error.code === 'string' ? error.code : null)
  }

  return response.data
}

/** Ends this device's access on the service at sign-out, as Connected apps on
 *  the website does. The shared flow bounds the wait and signs out whatever
 *  the answer; a 401 means the token is already gone. */
async function revokeCloudDevice(baseUrl: string, token: string): Promise<void> {
  const response = await portableHost().http.request({
    method: 'DELETE',
    url: `${baseUrl}/api/v1/devices/current`,
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    disableRedirects: true,
    connectTimeout: 10_000,
    readTimeout: 10_000
  })
  if ((response.status < 200 || response.status >= 300) && response.status !== 401) {
    throw new Error(`ZenNotes Cloud could not revoke this device (${response.status}).`)
  }
}

/** Cloud answered a sign-in exchange with an error. */
export class CloudSignInRefusedError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message)
    this.name = 'CloudSignInRefusedError'
  }
}

function parseStoredJson(value: string | null): unknown {
  if (value === null) return null
  try {
    return JSON.parse(value) as unknown
  } catch {
    return {}
  }
}

function migrateLegacyCloudCredential(value: unknown): { migrated: boolean; value: unknown } {
  if (!isRecord(value) || value.base_url !== LEGACY_CLOUD_BASE_URL || !isRecord(value.account)) {
    return { migrated: false, value }
  }

  return {
    migrated: true,
    value: {
      ...value,
      base_url: PRODUCTION_CLOUD_BASE_URL,
      account: {
        ...value.account,
        base_url: PRODUCTION_CLOUD_BASE_URL
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}
