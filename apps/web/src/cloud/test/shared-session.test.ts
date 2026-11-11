/**
 * Signing in on a shared computer: where the sign-in and the key live, how a
 * load tells a live session from one closed without signing out, and what a
 * wipe leaves behind.
 */
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'vitest'
import type { SecretStorage } from '@zennotes/portable-vault/host'
import { accountKeySecretStorage, forgetKeptAccountKeys, locksOnClose } from '../browser-keys'
import { keepsAttachments, loadKeepAttachments, recordAttachmentOpened, setKeepAttachments } from '../browser-storage'
import { saveBrowserVault, listBrowserVaults, markVaultUnsynced } from '../browser-vaults'
import {
  clearForSharedSession,
  finishLocalScrub,
  revocationAwareTransport,
  watchDeviceRevocation,
  wipeBrowserCloudData,
  wipeEverythingInBrowser
} from '../cloud-session'
import { bumpFenceGeneration, idbGet, idbKeys, idbPut, resetBrowserDbForTests } from '../idb'
import {
  beginSharedSession,
  markSharedSessionClean,
  markTabLeaving,
  isSharedSession,
  readSharedCredential,
  readSharedSessionRecord,
  resetSharedSessionForTests,
  settleSharedSession,
  sharedSessionLockName,
  SHARED_SESSION_RECORD_KEY,
  writeSharedCredential
} from '../shared-session'
import { FakeOpfs } from './opfs-fake'

class MemoryStorage {
  private readonly values = new Map<string, string>()
  get length(): number {
    return this.values.size
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
  removeItem(key: string): void {
    this.values.delete(key)
  }
  clear(): void {
    this.values.clear()
  }
  keysList(): string[] {
    return [...this.values.keys()]
  }
}

/** Keys of a Storage object are its own enumerable properties; a Proxy gives
 *  `Object.keys(localStorage)` the shape the code relies on. */
function storageObject(): MemoryStorage {
  const backing = new MemoryStorage()
  return new Proxy(backing, {
    ownKeys: () => backing.keysList(),
    getOwnPropertyDescriptor: (_target, key) =>
      typeof key === 'string' && backing.getItem(key) !== null
        ? { configurable: true, enumerable: true, value: backing.getItem(key) }
        : undefined
  })
}

/** Web Locks with the one rule these tests need: exclusive vs shared. */
class FakeLocks {
  held = new Map<string, { mode: string; count: number }>()
  async request(
    name: string,
    options: { mode?: 'shared' | 'exclusive'; ifAvailable?: boolean; steal?: boolean },
    callback: (lock: unknown) => unknown
  ): Promise<unknown> {
    const mode = options.mode ?? 'exclusive'
    const current = this.held.get(name)
    const busy = !options.steal && !!current && (mode === 'exclusive' || current.mode === 'exclusive')
    if (busy) {
      if (options.ifAvailable) return callback(null)
      throw new Error('This fake never waits for a lock')
    }
    this.held.set(name, { mode, count: (current?.count ?? 0) + 1 })
    const release = (): void => {
      const entry = this.held.get(name)
      if (!entry) return
      entry.count -= 1
      if (entry.count === 0) this.held.delete(name)
    }
    // As the real API: request() settles with the callback's result, and the
    // lock is held until then. A held-for-life lock's request never settles,
    // which the code under test never waits for.
    try {
      return await callback({ name, mode })
    } finally {
      release()
    }
  }
  async query(): Promise<{ held: Array<{ name: string }> }> {
    return { held: [...this.held.keys()].map((name) => ({ name })) }
  }
}

let opfs: FakeOpfs
let locks: FakeLocks
let session: MemoryStorage
let local: MemoryStorage

function install(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

/** A new tab: same origin storage and locks, this page's memory gone. */
function newTab(): void {
  resetSharedSessionForTests()
  session = storageObject()
  install('sessionStorage', session)
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  resetBrowserDbForTests()
  resetSharedSessionForTests()
  forgetKeptAccountKeys()
  opfs = new FakeOpfs('chrome')
  locks = new FakeLocks()
  session = storageObject()
  local = storageObject()
  install('sessionStorage', session)
  install('localStorage', local)
  install('navigator', { locks, storage: { getDirectory: async () => opfs.root } })
  install('caches', { keys: async () => ['runtime-x', 'zn-cloud-shell-1'], delete: async (name: string) => deletedCaches.push(name) })
  deletedCaches.length = 0
})

const deletedCaches: string[] = []
const SHARED_CREDENTIAL = JSON.stringify({ token: 't', account: { device: { shared: true } } })
const ORDINARY_CREDENTIAL = JSON.stringify({ token: 't', account: { device: { shared: false } } })
const ACCOUNT_KEY = 'e2ee-account-key.abc'
const LEFT_AT_KEY = 'zn-browser:shared-left-at'

function innerStore(): SecretStorage & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    available: () => true,
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => void values.set(key, value),
    remove: async (key: string) => void values.delete(key),
    keys: async () => [...values.keys()]
  }
}

async function startSession(): Promise<void> {
  writeSharedCredential(SHARED_CREDENTIAL)
  await beginSharedSession()
}

describe('where a shared computer keeps its sign-in and key', () => {
  it('keeps the sign-in out of IndexedDB, in this tab only', async () => {
    const inner = innerStore()
    inner.values.set('credential', ORDINARY_CREDENTIAL)
    const secrets = accountKeySecretStorage(inner)

    await secrets.set('credential', SHARED_CREDENTIAL)

    assert.equal(inner.values.has('credential'), false)
    assert.equal(await secrets.get('credential'), SHARED_CREDENTIAL)
    assert.ok(session.keysList().some((key) => session.getItem(key) === SHARED_CREDENTIAL))
    assert.ok((await secrets.keys()).includes('credential'))
    assert.equal(local.length, 0)
  })

  it('leaves an ordinary sign-in where it was', async () => {
    const inner = innerStore()
    const secrets = accountKeySecretStorage(inner)
    await secrets.set('credential', ORDINARY_CREDENTIAL)
    assert.equal(inner.values.get('credential'), ORDINARY_CREDENTIAL)
    assert.equal(session.length, 0)
  })

  it('never stores the account key, and a new page does not have it', async () => {
    await startSession()
    const inner = innerStore()
    const secrets = accountKeySecretStorage(inner)

    await secrets.set(ACCOUNT_KEY, 'key-bytes')

    assert.equal(inner.values.has(ACCOUNT_KEY), false)
    assert.equal(await secrets.get(ACCOUNT_KEY), 'key-bytes')
    assert.equal(session.keysList().some((key) => session.getItem(key)?.includes('key-bytes')), false)
    assert.equal(locksOnClose(), true)
    forgetKeptAccountKeys()
    assert.equal(await secrets.get(ACCOUNT_KEY), null)
  })

  it('does not fall back to a sign-in stored for someone else', async () => {
    await startSession()
    const inner = innerStore()
    inner.values.set('credential', ORDINARY_CREDENTIAL)
    const secrets = accountKeySecretStorage(inner)
    await secrets.remove('credential')
    inner.values.set('credential', ORDINARY_CREDENTIAL)
    assert.equal(await secrets.get('credential'), null)
  })

  it('always stubs attachments, whatever the preference says', async () => {
    await setKeepAttachments(true)
    await loadKeepAttachments()
    assert.equal(keepsAttachments(), true)
    await startSession()
    assert.equal(keepsAttachments(), false)
  })
})

describe('what a load does about a shared session', () => {
  const noWipe = async (): Promise<void> => assert.fail('nothing should be wiped')

  it('leaves a browser with no session alone', async () => {
    assert.equal(await settleSharedSession(noWipe), 'none')
    assert.equal(isSharedSession(), false)
  })

  it('keeps a reload in the session', async () => {
    await startSession()
    // pagehide on the way out of the reload.
    session.setItem(LEFT_AT_KEY, String(Date.now() - 400))
    resetSharedSessionForTests()
    assert.equal(await settleSharedSession(noWipe), 'member')
    assert.equal(isSharedSession(), true)
    assert.equal(readSharedCredential(), SHARED_CREDENTIAL)
    assert.equal(session.getItem(LEFT_AT_KEY), null)
  })

  it('wipes a session closed without signing out', async () => {
    await startSession()
    const record = await readSharedSessionRecord()
    // The tab closes: its session storage and its lock go with it.
    locks.held.delete(sharedSessionLockName(record!.id))
    newTab()
    let wiped = false
    assert.equal(await settleSharedSession(async () => { wiped = true }), 'wiped')
    assert.equal(wiped, true)
    assert.equal(isSharedSession(), false)
  })

  it('wipes under the lock, so no tab joins halfway', async () => {
    await startSession()
    const record = await readSharedSessionRecord()
    const name = sharedSessionLockName(record!.id)
    locks.held.delete(name)
    newTab()
    let modeDuringWipe: string | undefined
    await settleSharedSession(async () => { modeDuringWipe = locks.held.get(name)?.mode })
    assert.equal(modeDuringWipe, 'exclusive')
  })

  it('never wipes under a tab still in the session', async () => {
    await startSession()
    newTab()
    assert.equal(await settleSharedSession(noWipe), 'open-elsewhere')
    assert.equal(isSharedSession(), false)
    assert.ok(await readSharedSessionRecord())
  })

  it('treats a marker with no sign-in as not in the session', async () => {
    await startSession()
    const record = await readSharedSessionRecord()
    locks.held.delete(sharedSessionLockName(record!.id))
    const markerKey = session.keysList().find((key) => session.getItem(key) === record!.id)!
    newTab()
    session.setItem(markerKey, record!.id)
    let wiped = false
    assert.equal(await settleSharedSession(async () => { wiped = true }), 'wiped')
    assert.equal(wiped, true)
  })

  it('drops a tab whose copy another load already wiped', async () => {
    await startSession()
    await idbPut('preferences', SHARED_SESSION_RECORD_KEY, undefined)
    resetSharedSessionForTests()
    assert.equal(await settleSharedSession(noWipe), 'none')
    assert.equal(session.length, 0)
    assert.equal(readSharedCredential(), null)
  })
})

// Review finding 1: browsers restore sessionStorage with a reopened tab
// (reopen closed tab, History, "continue where you left off").
describe('a tab that comes back', () => {
  const wipeFlag = (): { wiped: boolean; run: () => Promise<void> } => {
    const flag = { wiped: false, run: async () => { flag.wiped = true } }
    return flag
  }

  /** The tab closes; its lock goes, its sessionStorage is kept for a restore. */
  async function closeTab(): Promise<void> {
    const record = await readSharedSessionRecord()
    locks.held.delete(sharedSessionLockName(record!.id))
    resetSharedSessionForTests()
  }

  it('does not sign a reopened closed tab back in', async () => {
    await startSession()
    session.setItem(LEFT_AT_KEY, String(Date.now() - 60_000))
    await closeTab()
    const wipe = wipeFlag()
    assert.equal(await settleSharedSession(wipe.run), 'wiped')
    assert.equal(wipe.wiped, true)
    assert.equal(isSharedSession(), false)
    assert.equal(readSharedCredential(), null)
  })

  it('does not trust a tab restored after a crash, which never said it was leaving', async () => {
    await startSession()
    await closeTab()
    const wipe = wipeFlag()
    assert.equal(await settleSharedSession(wipe.run), 'wiped')
    assert.equal(readSharedCredential(), null)
  })

  it('leaves a restored tab out while the session is open in another tab', async () => {
    await startSession()
    const record = await readSharedSessionRecord()
    // Another tab of the session is still open and holds the lock.
    resetSharedSessionForTests()
    assert.ok(locks.held.has(sharedSessionLockName(record!.id)))
    assert.equal(await settleSharedSession(async () => assert.fail('nothing should be wiped')), 'open-elsewhere')
    assert.equal(readSharedCredential(), null)
  })

  it('lets a window the session opened join it (the PDF export window)', async () => {
    await startSession()
    const record = await readSharedSessionRecord()
    resetSharedSessionForTests()
    const outcome = await settleSharedSession(async () => assert.fail('nothing should be wiped'), {
      openerMarker: () => record!.id
    })
    assert.equal(outcome, 'member')
  })

  it('marks the tab as leaving on its way out', async () => {
    await startSession()
    markTabLeaving(12345)
    assert.equal(session.getItem(LEFT_AT_KEY), '12345')
  })
})

// Review finding 2a: the session begins right after the exchange, before the
// account switch is settled.
describe('a shared sign-in that never finished starting', () => {
  it('leaves the earlier copy alone when it is closed before the switch was settled', async () => {
    await idbPut('preferences', SHARED_SESSION_RECORD_KEY, JSON.stringify({ id: 'never-started', startedAt: 1, clean: false }))
    assert.equal(await settleSharedSession(async () => assert.fail('the earlier copy must stay')), 'none')
    assert.equal(await readSharedSessionRecord(), null)
  })

  it('a session begun before the switch says so until it is clean', async () => {
    writeSharedCredential(SHARED_CREDENTIAL)
    await beginSharedSession({ clean: false })
    assert.equal((await readSharedSessionRecord())?.clean, false)
    await markSharedSessionClean()
    assert.notEqual((await readSharedSessionRecord())?.clean, false)
  })
})

describe('what a wipe leaves', () => {
  async function seed(): Promise<void> {
    const vaults = await opfs.root.getDirectoryHandle('vaults', { create: true })
    await (await vaults.getDirectoryHandle('cloud-a', { create: true })).getFileHandle('note.md', { create: true })
    await (await vaults.getDirectoryHandle('try', { create: true })).getFileHandle('tour.md', { create: true })
    await vaults.getDirectoryHandle('orphan', { create: true })
    await saveBrowserVault({ key: 'cloud-a', name: 'A', kind: 'cloud', vaultId: 'a', lastOpenedAt: 1 })
    await markVaultUnsynced('cloud-a', true)
    await idbPut('storage', 'zennotes-cloud-sync/state/x', '{}')
    await idbPut('secrets', 'e2ee-account-key.abc', { iv: 1 })
    await idbPut('keys', 'secrets-aes-gcm', 'k')
    await idbPut('fence', 'cloud-a', 3)
    local.setItem('zen:prefs:v2', '{}')
    local.setItem('zen:workspace', 'note.md')
  }

  async function opfsEntries(): Promise<string[]> {
    const names: string[] = []
    for await (const [name] of opfs.root.entries()) names.push(name)
    return names
  }

  it('removes OPFS, IndexedDB, local state and runtime caches, the record last', async () => {
    await startSession()
    await seed()
    let closed = false
    await wipeEverythingInBrowser({ closeOpenVault: () => { closed = true } })

    assert.equal(closed, true)
    assert.deepEqual(await opfsEntries(), [])
    for (const store of ['storage', 'secrets', 'keys'] as const) assert.deepEqual(await idbKeys(store), [], store)
    // Only the generation floor stays: it names no vault.
    assert.deepEqual((await idbKeys('fence')).filter((key) => !key.startsWith('#')), [])
    assert.deepEqual(await listBrowserVaults(), [])
    assert.equal(await readSharedSessionRecord(), null)
    assert.equal(local.length, 0)
    assert.equal(session.length, 0)
    assert.deepEqual(deletedCaches, ['runtime-x'])
  })

  // Review finding 7a: a frozen tab's old generation must never be current again.
  it('never lets lock generations start over', async () => {
    await startSession()
    await seed()
    for (let i = 0; i < 3; i += 1) await bumpFenceGeneration('cloud-a')
    await wipeEverythingInBrowser({ closeOpenVault: () => {} })
    assert.deepEqual((await idbKeys('fence')).filter((key) => key === 'cloud-a'), [])
    assert.ok((await bumpFenceGeneration('cloud-a')) > 4)
  })

  it('never lets lock generations start over when one account\u2019s vaults go', async () => {
    await seed()
    for (let i = 0; i < 3; i += 1) await bumpFenceGeneration('cloud-a')
    const entries = await listBrowserVaults()
    await wipeBrowserCloudData({ closeOpenVault: () => {} }, { entries, reason: 'account-switch' })
    assert.ok((await bumpFenceGeneration('cloud-a')) > 4)
  })

  it('keeps the record when a wipe is cut short, so it runs again', async () => {
    await startSession()
    await seed()
    opfs.breakStorage(new DOMException('gone wrong', 'InvalidStateError'))
    await assert.rejects(wipeEverythingInBrowser({ closeOpenVault: () => {} }))
    assert.ok(await idbGet('preferences', SHARED_SESSION_RECORD_KEY))
  })

  // Safari, 2026-11-11: an image opened just before Sign out was recorded 2 s
  // later, after the wipe, so the vault's key and the file's path outlived it.
  const openedRecords = async (): Promise<string[]> =>
    (await idbKeys('preferences')).filter((key) => key.startsWith('zn-browser:opened:'))
  const pastOpenedFlush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 2_200))

  it('writes back no attachment opened just before the wipe', async () => {
    await startSession()
    await seed()
    recordAttachmentOpened('cloud-a', 'assets/photo.png')
    await wipeEverythingInBrowser({ closeOpenVault: () => {} })
    await pastOpenedFlush()
    assert.deepEqual(await openedRecords(), [])
  })

  it('writes back no attachment opened just before a removed browser\u2019s vaults go', async () => {
    await seed()
    recordAttachmentOpened('cloud-a', 'assets/photo.png')
    const entries = await listBrowserVaults()
    await wipeBrowserCloudData({ closeOpenVault: () => {} }, { entries, reason: 'revoked' })
    await pastOpenedFlush()
    assert.deepEqual(await openedRecords(), [])
  })

  it('clears what the dying app writes back, on the next load', async () => {
    await startSession()
    await wipeEverythingInBrowser({ closeOpenVault: () => {} })
    local.setItem('zen:workspace', 'note.md')
    await finishLocalScrub()
    assert.equal(local.length, 0)
    await finishLocalScrub()
  })

  it('starts a shared sign-in without what an earlier sign-in stored, keeping this tab', async () => {
    await seed()
    writeSharedCredential(SHARED_CREDENTIAL)
    await clearForSharedSession({ closeOpenVault: () => {} })

    assert.deepEqual(await idbKeys('secrets'), [])
    assert.deepEqual(await idbKeys('keys'), [])
    assert.deepEqual(await idbKeys('storage'), [])
    assert.deepEqual(await listBrowserVaults(), [])
    assert.equal(readSharedCredential(), SHARED_CREDENTIAL)
    assert.ok(session.keysList().some((key) => session.getItem(key) === SHARED_CREDENTIAL))
  })
})

describe('what the transport tells a shared computer', () => {
  const answering = (status: number, data: unknown = null) => ({
    request: async () => ({ status, headers: {}, data }),
    putFile: async () => ({ status: 200 })
  }) as unknown as Parameters<typeof revocationAwareTransport>[0]
  const bearer = { url: 'https://zennotes.org/api/v1/vaults', headers: { Authorization: 'Bearer t' } }
  const revocation = { ...bearer, method: 'DELETE', url: 'https://zennotes.org/api/v1/devices/current' }

  it('tells an ended sign-in from a removed browser', async () => {
    const heard: string[] = []
    const listen = (status: number, data: unknown): ReturnType<typeof revocationAwareTransport> =>
      revocationAwareTransport(answering(status, data), () => heard.push('removed'), () => heard.push('ended'))
    await listen(401, { error: { code: 'UNAUTHENTICATED' } }).request(bearer)
    await listen(401, { error: { code: 'DEVICE_REVOKED' } }).request(bearer)
    await listen(401, null).request({ url: bearer.url })
    await listen(200, null).request(bearer)
    assert.deepEqual(heard, ['ended', 'removed'])
  })

  // Review item D: the service stops a browser whose account CLOUD_WEB no
  // longer allows with 403 CLOUD_WEB_NOT_ENABLED on any device call. That is
  // not a removal: the copy stays.
  it('tells a browser that is not allowed any more from a removed one', async () => {
    const heard: string[] = []
    const listen = (status: number, data: unknown): ReturnType<typeof revocationAwareTransport> =>
      revocationAwareTransport(answering(status, data), () => heard.push('removed'), () => heard.push('ended'), () => heard.push('not-enabled'))
    await listen(403, { error: { code: 'CLOUD_WEB_NOT_ENABLED' } }).request(bearer)
    await listen(403, { error: { code: 'ACTIVE_DEVICE_REQUIRED' } }).request(bearer)
    await listen(403, { error: { code: 'CLOUD_WEB_NOT_ENABLED' } }).request({ url: bearer.url })
    assert.deepEqual(heard, ['not-enabled', 'removed'])
  })

  it('reports whether a sign-out reached Cloud', async () => {
    const heard: boolean[] = []
    await watchDeviceRevocation(answering(204), (ok) => heard.push(ok)).request(revocation)
    await watchDeviceRevocation(answering(401), (ok) => heard.push(ok)).request(revocation)
    await watchDeviceRevocation(answering(500), (ok) => heard.push(ok)).request(revocation)
    await watchDeviceRevocation(answering(204), (ok) => heard.push(ok)).request(bearer)
    const offline = { request: async () => { throw new TypeError('Failed to fetch') } } as unknown as Parameters<typeof watchDeviceRevocation>[0]
    await assert.rejects(watchDeviceRevocation(offline, (ok) => heard.push(ok)).request(revocation))
    assert.deepEqual(heard, [true, true, false, false])
  })
})
