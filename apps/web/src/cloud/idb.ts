/**
 * The browser host's one IndexedDB database, usable from the page, the OPFS
 * worker and the service worker. Each store holds plain values by string key:
 *
 * - `storage`: HostStorage, the durable JSON the package keeps (Cloud link,
 *   sync state, scan cache) under its `zennotes-cloud-sync/...` keys;
 * - `preferences`: HostStorage for small settings;
 * - `secrets`: SecretStorage values, sealed with AES-GCM;
 * - `keys`: the non-extractable key that seals them;
 * - `fence`: one increasing number per vault, the generation of the tab that
 *   holds its lock (vault-lock.ts); the OPFS worker refuses a write from an
 *   older one.
 */

export const BROWSER_DB_NAME = 'zennotes-browser'
const BROWSER_DB_VERSION = 1
export const STORES = ['storage', 'preferences', 'secrets', 'keys', 'fence'] as const
export type BrowserStore = (typeof STORES)[number]

let opening: Promise<IDBDatabase> | null = null

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

function settled(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
  })
}

export function openBrowserDb(): Promise<IDBDatabase> {
  if (opening) return opening
  opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(BROWSER_DB_NAME, BROWSER_DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name)
      }
    }
    request.onsuccess = () => {
      const db = request.result
      // Another context upgrading the schema closes this connection; the
      // next call opens a fresh one.
      db.onversionchange = () => {
        db.close()
        opening = null
      }
      resolve(db)
    }
    request.onerror = () => reject(request.error ?? new Error('IndexedDB is not available'))
    request.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'))
  }).catch((error) => {
    opening = null
    throw error
  })
  return opening
}

/** For tests: forget the cached connection. */
export function resetBrowserDbForTests(): void {
  opening = null
}

export async function idbGet<T>(store: BrowserStore, key: string): Promise<T | undefined> {
  const db = await openBrowserDb()
  const transaction = db.transaction(store, 'readonly')
  return (await promisify(transaction.objectStore(store).get(key))) as T | undefined
}

export async function idbPut(store: BrowserStore, key: string, value: unknown): Promise<void> {
  const db = await openBrowserDb()
  const transaction = db.transaction(store, 'readwrite')
  transaction.objectStore(store).put(value, key)
  await settled(transaction)
}

export async function idbDelete(store: BrowserStore, key: string): Promise<void> {
  const db = await openBrowserDb()
  const transaction = db.transaction(store, 'readwrite')
  transaction.objectStore(store).delete(key)
  await settled(transaction)
}

export async function idbKeys(store: BrowserStore): Promise<string[]> {
  const db = await openBrowserDb()
  const transaction = db.transaction(store, 'readonly')
  const keys = await promisify(transaction.objectStore(store).getAllKeys())
  return keys.map((key) => String(key))
}

/** Reads, changes and writes one value inside a single transaction, so two
 *  tabs bumping it at once cannot both see the same old value. */
export async function idbUpdate<T>(
  store: BrowserStore,
  key: string,
  change: (current: T | undefined) => T
): Promise<T> {
  const db = await openBrowserDb()
  const transaction = db.transaction(store, 'readwrite')
  const objects = transaction.objectStore(store)
  const next = change((await promisify(objects.get(key))) as T | undefined)
  objects.put(next, key)
  await settled(transaction)
  return next
}

/** The generation that owns `vaultKey` now; 0 before any tab took its lock. */
export async function readFenceGeneration(vaultKey: string): Promise<number> {
  const value = await idbGet<number>('fence', vaultKey)
  return typeof value === 'number' ? value : 0
}

export async function bumpFenceGeneration(vaultKey: string): Promise<number> {
  return idbUpdate<number>('fence', vaultKey, (current) => (typeof current === 'number' ? current : 0) + 1)
}
