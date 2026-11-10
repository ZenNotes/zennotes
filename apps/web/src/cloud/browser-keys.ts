/**
 * Where this browser keeps the unlocked account key
 * (docs/ideas/cloud-in-browser.md, "End-to-end encryption in the tab"). The
 * apps keep it in the OS keychain. Here it is either sealed in IndexedDB under
 * the non-extractable key, like the sign-in, or, with "Lock when I close this
 * tab", held only in this tab's memory: a reload or a closed tab forgets it,
 * and each tab unlocks for itself. Vault keys stay in memory either way.
 *
 * On a shared computer (shared-session.ts) the account key is always held in
 * memory only, and the sign-in itself stays out of IndexedDB: this tab's
 * `sessionStorage` and memory hold it instead.
 */
import type { SecretStorage } from '@zennotes/portable-vault/host'
import { idbDelete, idbGet, idbPut } from './idb'
import { idbSecretStorage } from './idb-storage'
import {
  clearSharedCredential,
  isSharedCredential,
  isSharedSession,
  readSharedCredential,
  writeSharedCredential
} from './shared-session'

const LOCK_ON_CLOSE_KEY = 'zn-browser:lock-on-close'
const NOTICE_SEEN_KEY = 'zn-browser:e2ee-notice-seen'
/** How the package names an account's key (mobile-cloud-auth.ts). */
const ACCOUNT_KEY_PREFIXES = ['e2ee-account-key.', 'cloud-e2ee:']
/** The package's name for the sign-in (mobile-cloud-auth.ts). */
const CREDENTIAL_SECRET = 'credential'

function isAccountKey(key: string): boolean {
  return ACCOUNT_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))
}

let lockOnClose = false
const heldInMemory = new Map<string, string>()

/** Read once at boot, before anything can unlock. */
export async function loadLockOnClose(): Promise<boolean> {
  lockOnClose = (await idbGet<string>('preferences', LOCK_ON_CLOSE_KEY).catch(() => undefined)) === 'on'
  return lockOnClose
}

export function locksOnClose(): boolean {
  return lockOnClose || sharedHere()
}

/** Signed in as a shared computer, including the moment after the sign-in
 *  arrives and before the session is recorded. */
function sharedHere(): boolean {
  return isSharedSession() || readSharedCredential() !== null
}

/**
 * The browser's secrets: sealed in IndexedDB, except an account key while
 * "Lock when I close this tab" is on or on a shared computer, and a shared
 * computer's sign-in. A secret kept out of IndexedDB is never also stored
 * there, and every sweep (`keys`, `remove`) sees every place.
 */
export function accountKeySecretStorage(inner: SecretStorage): SecretStorage {
  return {
    available: () => inner.available(),
    prepare: () => inner.prepare?.() ?? Promise.resolve(),
    async get(key) {
      if (key === CREDENTIAL_SECRET) {
        const shared = readSharedCredential()
        if (shared !== null) return shared
        // A shared session never falls back to a sign-in stored for someone
        // else; only a tab outside it reads IndexedDB.
        if (isSharedSession()) return null
      }
      const held = heldInMemory.get(key)
      return held !== undefined ? held : inner.get(key)
    },
    async set(key, value) {
      if (key === CREDENTIAL_SECRET) {
        if (isSharedCredential(value)) {
          writeSharedCredential(value)
          await inner.remove(key)
          return
        }
        clearSharedCredential()
      }
      if (isAccountKey(key) && locksOnClose()) {
        heldInMemory.set(key, value)
        await inner.remove(key)
        return
      }
      heldInMemory.delete(key)
      await inner.set(key, value)
    },
    async remove(key) {
      if (key === CREDENTIAL_SECRET) clearSharedCredential()
      heldInMemory.delete(key)
      await inner.remove(key)
    },
    async keys() {
      const shared = readSharedCredential() !== null ? [CREDENTIAL_SECRET] : []
      return [...new Set([...(await inner.keys()), ...heldInMemory.keys(), ...shared])]
    }
  }
}

/** One store for the page: every host created in this tab shares its memory. */
export const browserSecrets: SecretStorage = accountKeySecretStorage(idbSecretStorage())

/** Applies the choice now, moving an unlocked key to where it belongs. */
export async function setLockOnClose(on: boolean, secrets: SecretStorage = browserSecrets): Promise<void> {
  // A shared computer has no choice to remember: the key is never stored.
  if (sharedHere()) return
  const held = new Map<string, string>()
  for (const key of await secrets.keys()) {
    if (!isAccountKey(key)) continue
    const value = await secrets.get(key)
    if (value !== null) held.set(key, value)
  }
  await idbPut('preferences', LOCK_ON_CLOSE_KEY, on ? 'on' : 'off')
  lockOnClose = on
  for (const [key, value] of held) await secrets.set(key, value)
}

/** Drops the keys only this tab holds: another tab locked or signed out. */
export function forgetKeptAccountKeys(): void {
  heldInMemory.clear()
}

/** Whether the first-unlock notice has been shown through an unlock here. */
export async function encryptionNoticeSeen(): Promise<boolean> {
  return typeof (await idbGet<string>('preferences', NOTICE_SEEN_KEY).catch(() => undefined)) === 'string'
}

export async function markEncryptionNoticeSeen(): Promise<void> {
  await idbPut('preferences', NOTICE_SEEN_KEY, new Date().toISOString()).catch(() => undefined)
}

/** A removed browser starts over: the next account sees the notice again. */
export async function forgetBrowserEncryptionPrefs(): Promise<void> {
  lockOnClose = false
  await idbDelete('preferences', LOCK_ON_CLOSE_KEY).catch(() => undefined)
  await idbDelete('preferences', NOTICE_SEEN_KEY).catch(() => undefined)
}
