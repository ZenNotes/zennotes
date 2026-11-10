/**
 * When this browser's copy of the account must go (docs/ideas/cloud-in-browser.md,
 * "Signing in as a device" and "Losing nothing"):
 *
 * - Cloud answers 401 `DEVICE_REVOKED` (this browser was removed under
 *   Connected apps) or 403 `ACTIVE_DEVICE_REQUIRED`: the copy is wiped, its
 *   unsynced changes with it, as the website's Disconnect button says.
 * - A plain 401 (`UNAUTHENTICATED`, the sign-in expired after 30 days unused)
 *   only signs this browser out; app-core says so and the copy stays, so
 *   signing in again picks up where it was.
 * - Signing into another account wipes the previous account's vaults, after
 *   asking when some of them hold changes Cloud never got.
 *
 * The wipe removes each Cloud vault's OPFS folder and its folder-move
 * journal, every Cloud record in IndexedDB (link, sync state, scan cache, the
 * credential, pending sign-ins, account keys wherever they are kept, the
 * vault registry entries),
 * app-core's workspace state in localStorage, and runtime caches that are not
 * the app's own build. Try mode's local vault is not the account's and stays,
 * unless it was kept in Cloud.
 */
import type { HttpTransport, HttpTransportRequest, HttpTransportResponse } from '@zennotes/portable-vault/host'
import { announceAccount } from './cloud-account'
import { forgetKeptAccountKeys, forgetBrowserEncryptionPrefs } from './browser-keys'
import { idbDelete, idbKeys, openBrowserDb } from './idb'
import {
  listBrowserVaults,
  removeBrowserVaults,
  setCurrentBrowserVaultKey,
  unsyncedPreferenceKey,
  type BrowserVaultEntry
} from './browser-vaults'
import { originOpfsRoot } from './opfs-handles'
import { VAULTS_DIR } from './opfs-paths'

export type RevocationReason = 'revoked'

/** Whether a Cloud answer means this browser was removed from the account. */
export function isRevocationAnswer(status: number, data: unknown): boolean {
  const code = (data as { error?: { code?: unknown } } | null)?.error?.code
  return (status === 401 && code === 'DEVICE_REVOKED') || (status === 403 && code === 'ACTIVE_DEVICE_REQUIRED')
}

function sendsCredential(request: HttpTransportRequest): boolean {
  const headers = request.headers ?? {}
  return Object.keys(headers).some((name) => name.toLowerCase() === 'authorization' && /^Bearer\s/i.test(headers[name] ?? ''))
}

/**
 * The page's HTTP with one more duty: an authenticated Cloud request that
 * hears this browser was removed starts the wipe. The answer still goes back
 * to the caller, so the request fails as it would anyway.
 */
export function revocationAwareTransport(base: HttpTransport, onRevoked: () => void): HttpTransport {
  return {
    ...base,
    async request(options): Promise<HttpTransportResponse> {
      const response = await base.request(options)
      if (sendsCredential(options) && isRevocationAnswer(response.status, response.data)) onRevoked()
      return response
    }
  }
}

const SW_CACHE_PREFIX = 'zn-cloud-'
/** localStorage keys that are settings, not vault content; everything else
 *  app-core keeps there (workspace tabs, manual note order, command history)
 *  names notes and goes with the vault. */
const KEPT_LOCAL_KEYS = new Set(['zen:prefs:v2'])

export interface WipeHooks {
  /** Stops this tab's sync and closes its vault worker first. */
  closeOpenVault(): Promise<void> | void
}

/** Deletes `vaults/<key>` and its folder-move journal, under the vault's
 *  lock (stolen if a frozen tab still holds it, which also fences off any
 *  write that tab has in flight). */
async function deleteVaultFolder(key: string): Promise<void> {
  const remove = async (): Promise<void> => {
    const root = await originOpfsRoot()
    const vaults = await root.getDirectoryHandle(VAULTS_DIR, { create: false }).catch(() => null)
    if (!vaults) return
    await vaults.removeEntry(key, { recursive: true }).catch((error: unknown) => {
      if ((error as { name?: string } | null)?.name !== 'NotFoundError') throw error
    })
    const journals = await vaults.getDirectoryHandle('.zn-journal', { create: false }).catch(() => null)
    await journals?.removeEntry(key, { recursive: true }).catch(() => undefined)
  }
  if (typeof navigator !== 'undefined' && navigator.locks) {
    await navigator.locks.request(`zennotes:vault:${key}`, { steal: true }, async () => {
      await remove()
    })
  } else {
    await remove()
  }
  await idbDelete('fence', key).catch(() => undefined)
}

async function clearStore(store: 'storage' | 'secrets' | 'keys'): Promise<void> {
  const db = await openBrowserDb()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(store, 'readwrite')
    transaction.objectStore(store).clear()
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB clear failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB clear aborted'))
  })
}

/** app-core's per-vault state in localStorage (open tabs, note order,
 *  command history), which names notes. The wipe clears it, and the next
 *  boot clears it again: the app still running in the wiped tab writes its
 *  workspace back on the way out. */
export function clearLocalState(): void {
  try {
    for (const key of Object.keys(localStorage)) {
      if (!KEPT_LOCAL_KEYS.has(key)) localStorage.removeItem(key)
    }
    sessionStorage.clear()
  } catch {
    // storage blocked: nothing kept there either
  }
}

async function clearRuntimeCaches(): Promise<void> {
  if (typeof caches === 'undefined') return
  for (const name of await caches.keys().catch(() => [] as string[])) {
    // The service worker's caches hold only the app's own build files.
    if (!name.startsWith(SW_CACHE_PREFIX)) await caches.delete(name).catch(() => false)
  }
}

/** The vaults a wipe removes: every Cloud vault (Try's too once it was kept
 *  in Cloud), or only the ones named. */
async function cloudEntries(only?: readonly BrowserVaultEntry[]): Promise<BrowserVaultEntry[]> {
  if (only) return [...only]
  return (await listBrowserVaults()).filter((entry) => entry.kind === 'cloud')
}

/**
 * Removes the account's copy from this browser. `entries` limits it to some
 * vaults (switching accounts removes the previous one's); without it every
 * Cloud vault goes, with the credential and every Cloud record.
 */
export async function wipeBrowserCloudData(
  hooks: WipeHooks,
  options: { entries?: readonly BrowserVaultEntry[]; reason: 'revoked' | 'account-switch' }
): Promise<void> {
  await hooks.closeOpenVault()
  // Other tabs close their workers and stop, before their folders go.
  announceAccount({ type: 'wiped', reason: options.reason })
  const entries = await cloudEntries(options.entries)
  for (const entry of entries) await deleteVaultFolder(entry.key)
  await removeBrowserVaults(entries.map((entry) => entry.key))
  for (const entry of entries) {
    await idbDelete('preferences', unsyncedPreferenceKey(entry.key)).catch(() => undefined)
    // Try's vault, kept in Cloud and now removed: /try seeds the tour again.
    await idbDelete('preferences', `zn-browser:seeded:${entry.key}`).catch(() => undefined)
    await idbDelete('preferences', `zn-browser:opened:${entry.key}`).catch(() => undefined)
  }
  if (!options.entries) {
    // The whole account: every link, state and scan cache, the credential,
    // pending sign-ins and account keys, and the key that sealed them.
    forgetKeptAccountKeys()
    await clearStore('storage')
    await clearStore('secrets')
    await clearStore('keys')
    await forgetBrowserEncryptionPrefs()
    for (const key of await idbKeys('preferences')) {
      if (key.startsWith('zn-browser:opened:')) await idbDelete('preferences', key).catch(() => undefined)
    }
  } else {
    // Another account signed in: its credential stays, the previous
    // account's sync records go with its vaults (the sync records are keyed
    // by a hash of each vault's syncKey, so they are removed by key list).
    for (const entry of entries) {
      for (const key of await idbKeys('storage')) {
        if (await belongsToVault(key, entry.key)) await idbDelete('storage', key).catch(() => undefined)
      }
    }
  }
  await setCurrentBrowserVaultKey(null)
  clearLocalState()
  await clearRuntimeCaches()
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Whether a package storage key (`zennotes-cloud-sync/<kind>/<sha256(syncKey)>...`)
 *  belongs to the browser vault `key`. */
async function belongsToVault(storageKey: string, vaultKey: string): Promise<boolean> {
  const hashed = await sha256Hex(`browser/${vaultKey}`)
  return storageKey.includes(`/${hashed}`)
}
