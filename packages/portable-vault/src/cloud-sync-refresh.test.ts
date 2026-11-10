import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { trackCloudSyncChanges } from './cloud-sync-refresh'

describe('cloud sync refresh', () => {
  it('retains a failed refresh for the next host operation', async () => {
    const state = { changed: false }
    const fs = { readdir: async () => [], stat: async () => null, readBase64: async () => '',
      writeText: async () => {}, writeBase64: async () => {}, deleteFile: async () => {}, rename: async () => {} }
    const first = trackCloudSyncChanges(fs, async () => { throw new Error('unavailable') }, state)
    first.markChanged()
    await assert.rejects(first.refresh(), /unavailable/)
    let refreshes = 0
    const next = trackCloudSyncChanges(fs, async () => { refreshes++ }, state)
    await next.refresh()
    await next.refresh()
    assert.equal(refreshes, 1)
  })
  function fixture(failWrite = false) {
    let refreshes = 0
    const changes = trackCloudSyncChanges({
      readdir: async () => [], stat: async () => null, readBase64: async () => '',
      writeText: async () => { if (failWrite) throw new Error('disk full') },
      writeBase64: async () => {}, deleteFile: async () => {}, rename: async () => {}
    }, async () => { refreshes++ })
    return { changes, count: () => refreshes }
  }

  it('does not refresh the editor after a read-only / no-op sync', async () => {
    const { changes, count } = fixture()
    await changes.fs.readdir('')
    await changes.fs.readBase64('note.md')
    await changes.refresh()
    assert.equal(count(), 0)
  })

  it('refreshes once for a batch of pulled notes, assets, moves and deletions', async () => {
    const { changes, count } = fixture()
    await changes.fs.writeText('note.md', 'new content')
    await changes.fs.writeBase64('image.png', 'AA==')
    await changes.fs.rename('note.md', 'renamed.md')
    await changes.fs.deleteFile('old.md')
    await changes.refresh()
    assert.equal(count(), 1)
  })

  it('still refreshes partial filesystem changes when a sync fails', async () => {
    const { changes, count } = fixture(true)
    await assert.rejects(changes.fs.writeText('note.md', 'partial'), /disk full/)
    await changes.refresh()
    assert.equal(count(), 1)
  })

  it('refreshes externally changed files found during scanning without a pull', async () => {
    const { changes, count } = fixture()
    changes.markChanged()
    await changes.refresh()
    assert.equal(count(), 1)
  })
})
