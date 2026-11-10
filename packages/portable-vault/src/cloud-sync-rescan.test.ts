import assert from 'node:assert/strict'
import { it } from 'vitest'
import { onVaultChange } from './events'
import { PortableVault } from './vault-fs'

it('batches a foreground/cloud refresh into one resync without triggering local autosync events', async () => {
  const events: unknown[] = []
  const unsubscribe = onVaultChange((event: unknown) => events.push(event))
  const invalidated: string[] = []
  const vault = {
    settingsCache: {},
    metaCache: new Map([
      ['deleted.md', { meta: { updatedAt: 1 }, size: 1 }],
      ['changed.md', { meta: { updatedAt: 1 }, size: 1 }]
    ]),
    listNotes: async () => [
      { path: 'changed.md', updatedAt: 2, size: 2, folder: 'inbox' },
      { path: 'new.md', updatedAt: 2, size: 2, folder: 'inbox' }
    ],
    invalidateMeta: (path: string) => invalidated.push(path),
    folderOf: async () => 'inbox',
    settleSeededInbox: async () => false
  }
  try {
    await PortableVault.prototype.rescan.call(vault)
    assert.deepEqual(events, [{ kind: 'change', path: '', folder: 'inbox', scope: 'resync' }])
    assert.deepEqual(invalidated, ['deleted.md'])
    assert.equal(vault.settingsCache, null)
  } finally { unsubscribe() }
})
