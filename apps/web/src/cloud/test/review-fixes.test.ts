/**
 * The independent review of the browser app (Phases 4 to 7): one case per
 * finding, each written to fail on the code before its fix.
 */
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'vitest'
import type { CloudSyncRunSummary } from '@zennotes/bridge-contract/cloud-sync'
import { resetBrowserDbForTests } from '../idb'
import { chooseHomeVault, type BrowserVaultEntry } from '../browser-vaults'
import { syncLeftNothingBehind, UnsyncedChanges } from '../unsynced'
import { forgetAfterSignIn, rememberAfterSignIn, settleAfterSignIn, stampAfterSignIn, takeAfterSignIn } from '../after-sign-in'
import { mayServeVaultFile } from '../vault-access'
import { applyTryVimDefault, dropTryVimDefault } from '../try-vim'

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  resetBrowserDbForTests()
})

const summary = (extra: Partial<CloudSyncRunSummary> = {}): CloudSyncRunSummary => ({
  cursor: 1,
  pulled: 0,
  pushed: 1,
  conflicts: [],
  bootstrap_conflicts: [],
  local_conflicts: [],
  pending_conflicts: [],
  refused_paths: [],
  ...extra
})

describe('finding 2b: home never opens another account’s vault with this sign-in', () => {
  const alice = { baseUrl: 'https://zennotes.org', email: 'alice@example.com' }
  const bob = { baseUrl: 'https://zennotes.org', email: 'bob@example.com' }
  const entries: BrowserVaultEntry[] = [
    { key: 'cloud-a', name: 'Alice', kind: 'cloud', vaultId: 'a', account: alice, lastOpenedAt: 2 },
    { key: 'try', name: 'Try ZenNotes', kind: 'try', lastOpenedAt: 1 }
  ]

  it('refuses the previous account’s vault, asked for or remembered', () => {
    assert.equal(chooseHomeVault({ entries, wanted: 'cloud-a', lastKey: 'cloud-a', account: bob }), undefined)
    assert.equal(chooseHomeVault({ entries, wanted: null, lastKey: 'cloud-a', account: bob }), undefined)
  })

  it('opens the signed-in account’s vault, and a signed-out copy as before', () => {
    assert.equal(chooseHomeVault({ entries, wanted: null, lastKey: 'cloud-a', account: alice })?.key, 'cloud-a')
    assert.equal(chooseHomeVault({ entries, wanted: null, lastKey: null, account: null })?.key, 'cloud-a')
    assert.equal(chooseHomeVault({ entries, wanted: 'try', lastKey: null, account: bob })?.key, 'try')
  })
})

describe('finding 3: a run that set something aside is not "synced"', () => {
  it('keeps the unsynced mark for parked conflicts and refused files', () => {
    assert.equal(syncLeftNothingBehind(summary()), true)
    assert.equal(syncLeftNothingBehind(summary({ pending_conflicts: [{ id: 'c1' } as never] })), false)
    assert.equal(syncLeftNothingBehind(summary({ local_conflicts: [{ path: 'a.md' } as never] })), false)
    assert.equal(syncLeftNothingBehind(summary({ refused_paths: [{ path: 'b.md' } as never] })), false)
    assert.equal(syncLeftNothingBehind(summary({ bootstrap_conflicts: [{ path: 'c.md' } as never] })), false)
  })

  it('so the tracker keeps the vault marked', async () => {
    const changes = new UnsyncedChanges('cloud-a')
    changes.changed()
    await changes.track(async () => summary({ refused_paths: [{ path: 'b.md' } as never] }))
    assert.equal(changes.pending, true)
    await changes.track(async () => summary())
    assert.equal(changes.pending, false)
  })
})

describe('finding 4: a reload remembers unsynced edits', () => {
  it('reads the mark back on load', async () => {
    const before = new UnsyncedChanges('cloud-a')
    before.changed()
    await before.settled()
    const after = new UnsyncedChanges('cloud-a')
    assert.equal(after.pending, false)
    await after.restore()
    assert.equal(after.pending, true)
  })

  // Found in the end-to-end run: the sync service hands a second caller the
  // run already in flight, which started before the edit.
  it('a call that joins a run already going cannot clear the mark', async () => {
    const changes = new UnsyncedChanges('cloud-a')
    let finish!: (value: CloudSyncRunSummary) => void
    const inFlight = new Promise<CloudSyncRunSummary>((resolve) => (finish = resolve))
    const first = changes.track(() => inFlight)
    changes.changed()
    const joined = changes.track(() => inFlight)
    finish(summary())
    await Promise.all([first, joined])
    assert.equal(changes.pending, true)
  })

  it('a run that joined one the page did not start cannot clear the mark', async () => {
    const changes = new UnsyncedChanges('cloud-a', undefined, () => true)
    changes.changed()
    await changes.track(async () => summary())
    assert.equal(changes.pending, true)
  })

  // Found in Safari: the sign-out's final push joined the sync the edit had
  // started, could not vouch for it, and asked to discard changes that had
  // reached Cloud. Pushing until settled runs once more, fresh.
  it('a push that only joined a run goes again and then settles', async () => {
    let inFlight = true
    const changes = new UnsyncedChanges('cloud-a', undefined, () => inFlight)
    changes.changed()
    let runs = 0
    await changes.pushUntilSettled(async () => {
      runs += 1
      inFlight = false
      return summary()
    })
    assert.equal(changes.pending, false)
    assert.equal(runs, 2)
  })

  it('pushing until settled stops at a run that set something aside', async () => {
    const changes = new UnsyncedChanges('cloud-a')
    changes.changed()
    let runs = 0
    await changes.pushUntilSettled(async () => {
      runs += 1
      return summary({ refused_paths: [{ path: 'b.md' } as never] })
    })
    assert.equal(changes.pending, true)
    assert.ok(runs <= 3)
  })

  it('a change during a run keeps the mark', async () => {
    const changes = new UnsyncedChanges('cloud-a')
    await changes.track(async () => {
      changes.changed()
      return summary()
    })
    assert.equal(changes.pending, true)
  })
})

describe('finding 6: Keep it in ZenNotes Cloud belongs to the sign-in that asked', () => {
  it('is dropped when another sign-in finishes', async () => {
    await rememberAfterSignIn('keep-try')
    await stampAfterSignIn('https://zennotes.org/app/connect?state=person-a&code_challenge=x')
    assert.equal(await settleAfterSignIn('person-b'), false)
    assert.equal(await takeAfterSignIn(), null)
  })

  it('carries over the sign-in it started', async () => {
    await rememberAfterSignIn('keep-try')
    await stampAfterSignIn('https://zennotes.org/app/connect?state=person-a&code_challenge=x')
    assert.equal(await settleAfterSignIn('person-a'), true)
    assert.equal(await takeAfterSignIn(), 'keep-try')
    assert.equal(await takeAfterSignIn(), null)
  })

  it('is not taken before its sign-in finished, and can be forgotten', async () => {
    await rememberAfterSignIn('keep-try')
    await stampAfterSignIn('https://zennotes.org/app/connect?state=person-a')
    assert.equal(await takeAfterSignIn(), null)
    await rememberAfterSignIn('keep-try')
    await stampAfterSignIn('https://zennotes.org/app/connect?state=person-a')
    await forgetAfterSignIn()
    assert.equal(await settleAfterSignIn('person-a'), false)
  })
})

describe('finding 8: a locked encrypted vault’s files are not served', () => {
  const facts = (over: Partial<Parameters<typeof mayServeVaultFile>[1]> = {}) => ({
    sharedCopyClosed: async () => false,
    encrypted: async () => true,
    unlockedOwner: async () => false,
    ...over
  })

  it('needs a live tab holding the key', async () => {
    assert.equal(await mayServeVaultFile('cloud-e', facts()), false)
    assert.equal(await mayServeVaultFile('cloud-e', facts({ unlockedOwner: async () => true })), true)
  })

  it('serves a readable vault as before, and never a closed shared copy', async () => {
    assert.equal(await mayServeVaultFile('cloud-a', facts({ encrypted: async () => false })), true)
    assert.equal(await mayServeVaultFile('cloud-a', facts({ encrypted: async () => false, sharedCopyClosed: async () => true })), false)
  })
})

describe('Try mode starts with Vim mode off', () => {
  class Store {
    values = new Map<string, string>()
    getItem(key: string): string | null {
      return this.values.get(key) ?? null
    }
    setItem(key: string, value: string): void {
      this.values.set(key, value)
    }
    removeItem(key: string): void {
      this.values.delete(key)
    }
  }
  const prefs = (store: Store): Record<string, unknown> => JSON.parse(store.getItem('zen:prefs:v2') ?? '{}')

  it('on a first visit, and keeps the onboarding wizard', () => {
    const store = new Store()
    assert.equal(applyTryVimDefault(store), true)
    assert.equal(prefs(store).vimMode, false)
    assert.equal(prefs(store).hasCompletedOnboarding, false)
  })

  it('never overrides a choice already made', () => {
    const store = new Store()
    store.setItem('zen:prefs:v2', JSON.stringify({ vimMode: true, hasCompletedOnboarding: true }))
    assert.equal(applyTryVimDefault(store), false)
    assert.equal(prefs(store).vimMode, true)
  })

  it('leaves a Cloud vault on the app’s own default', () => {
    const store = new Store()
    applyTryVimDefault(store)
    assert.equal(dropTryVimDefault(store), true)
    assert.equal('vimMode' in prefs(store), false)
  })

  it('keeps Vim mode off in a Cloud vault when the person chose it in Try', () => {
    const store = new Store()
    applyTryVimDefault(store)
    // Turned on, then off again by hand: a choice, not the default.
    store.setItem('zen:prefs:v2', JSON.stringify({ ...prefs(store), vimMode: true }))
    assert.equal(dropTryVimDefault(store), false)
    store.setItem('zen:prefs:v2', JSON.stringify({ ...prefs(store), vimMode: false }))
    assert.equal(dropTryVimDefault(store), false)
    assert.equal(prefs(store).vimMode, false)
  })
})
