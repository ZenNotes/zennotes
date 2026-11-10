/**
 * HostStorage and SecretStorage over IndexedDB (idb.ts).
 *
 * HostStorage: `read` answers null only for a key that is not there (an
 * IndexedDB `get` that succeeds with undefined); a failed request throws, so a
 * Cloud link or sync state never reads as missing because the database did
 * not answer.
 *
 * SecretStorage: values are sealed with AES-GCM under a key generated in
 * this browser as non-extractable and kept in IndexedDB. Script on the page
 * can use the key but never read its bytes, so a copy of the profile's
 * storage alone does not open the secrets. It is not protection from code
 * running on this origin, which is why the origin runs nothing but the app.
 */
import type { HostStorage, SecretStorage } from '@zennotes/portable-vault/host'
import { idbDelete, idbGet, idbKeys, idbPut, idbUpdate, type BrowserStore } from './idb'

export function idbHostStorage(store: Extract<BrowserStore, 'storage' | 'preferences'>): HostStorage {
  return {
    async read(key) {
      const value = await idbGet<unknown>(store, key)
      if (value === undefined) return null
      if (typeof value !== 'string') throw new Error(`Stored value for ${key} is not text.`)
      return value
    },
    async write(key, value) {
      await idbPut(store, key, value)
    },
    async remove(key) {
      await idbDelete(store, key)
    }
  }
}

interface SealedSecret {
  iv: Uint8Array
  data: ArrayBuffer
}

const WRAPPING_KEY_ID = 'secrets-aes-gcm'

let wrappingKey: Promise<CryptoKey> | null = null

async function secretsKey(): Promise<CryptoKey> {
  if (!wrappingKey) {
    wrappingKey = (async () => {
      const existing = await idbGet<CryptoKey>('keys', WRAPPING_KEY_ID)
      if (existing) return existing
      const created = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
      // Two tabs creating at once: the first one stored wins, and both use it.
      return await idbUpdate<CryptoKey>('keys', WRAPPING_KEY_ID, (current) => current ?? created)
    })().catch((error) => {
      wrappingKey = null
      throw error
    })
  }
  return wrappingKey
}

/** For tests: forget the cached key handle. */
export function resetSecretsKeyForTests(): void {
  wrappingKey = null
}

export function idbSecretStorage(): SecretStorage {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  return {
    available: () => typeof indexedDB !== 'undefined' && typeof crypto !== 'undefined' && !!crypto.subtle,
    async prepare() {
      await secretsKey()
    },
    async get(key) {
      const sealed = await idbGet<SealedSecret>('secrets', key)
      if (!sealed) return null
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(sealed.iv) }, await secretsKey(), sealed.data)
      return decoder.decode(plain)
    },
    async set(key, value) {
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await secretsKey(), encoder.encode(value))
      await idbPut('secrets', key, { iv, data } satisfies SealedSecret)
    },
    async remove(key) {
      await idbDelete('secrets', key)
    },
    keys: () => idbKeys('secrets')
  }
}
