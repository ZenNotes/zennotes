/**
 * The independent review of the browser app (Phases 4 to 7), findings that
 * live in modules which already existed: each case fails on the code before
 * its fix.
 */
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'vitest'
import { unzipSync } from 'fflate'
import { bumpFenceGeneration, resetBrowserDbForTests } from '../idb'
import { idbHostStorage } from '../idb-storage'
import { buildVaultArchive } from '../download-folder'
import { createOpfsDispatcher } from '../opfs-dispatch'
import { OpfsVaultFileSystem, directTransport } from '../opfs-fs'
import { FakeOpfs } from './opfs-fake'

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  resetBrowserDbForTests()
})

describe('finding 5: Download as a folder works with attachments only in Cloud', () => {
  it('leaves out an attachment it cannot download and says which', async () => {
    const origin = new FakeOpfs('chrome')
    const fs = new OpfsVaultFileSystem('cloud-a', directTransport(createOpfsDispatcher({ root: async () => origin.root })), { generation: 0 })
    await fs.init()
    await fs.writeText('inbox/Note.md', '# Note\n')
    await fs.writeCloudStub('assets/big.png', {
      item_id: 'i1', revision: 1, sha256: 'a'.repeat(64), byte_length: 2_000_000, media_type: 'image/png'
    } as never)
    // Offline: no hydrator can bring the bytes.
    const { blob, fileCount, leftOut } = await buildVaultArchive(fs, 'Fixture')
    assert.equal(fileCount, 1)
    assert.deepEqual(leftOut, ['assets/big.png'])
    const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()))
    assert.ok(entries['Fixture/inbox/Note.md'])
    assert.equal(entries['Fixture/assets/big.png'], undefined)
    const notice = new TextDecoder().decode(entries['Not included.txt'])
    assert.match(notice, /assets\/big\.png/)
  })
})

describe('finding 7b: sync state is fenced like the files', () => {
  it('refuses a write from a tab whose lock was taken', async () => {
    const held = { vaultKey: 'cloud-a', generation: await bumpFenceGeneration('cloud-a') }
    const storage = idbHostStorage('storage', () => held)
    await storage.write('zennotes-cloud-sync/state/x', '{"cursor":5}')
    await bumpFenceGeneration('cloud-a')
    await assert.rejects(storage.write('zennotes-cloud-sync/state/x', '{"cursor":3}'))
    await assert.rejects(storage.remove('zennotes-cloud-sync/state/x'))
    assert.equal(await storage.read('zennotes-cloud-sync/state/x'), '{"cursor":5}')
  })
})

