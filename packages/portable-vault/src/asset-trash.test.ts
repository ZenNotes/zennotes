import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'vitest'
import { MemoryVaultFileSystem } from './memory-fs'
import { PortableVault } from './vault-fs'
import { installTestHost } from '../test/test-host'

// Deleting an attachment moves it into .zennotes/deleted-assets/<token>/ beside
// a .zn-deleted.json record, the store desktop and the server share. Android
// moved the file first and wrote the record second, so a write that failed in
// between left the asset in a token folder the Trash view skips (it lists only
// folders with a record): gone from the vault, invisible in the app. The
// iPhone wrote the record first and rolled back on failure (since 1242f16);
// the package keeps that order for both, and reads the record, not the
// caller, when restoring.

const META = '.zn-deleted.json'

async function openVault(): Promise<{ vault: PortableVault<MemoryVaultFileSystem>; fs: MemoryVaultFileSystem }> {
  const fs = new MemoryVaultFileSystem()
  fs.put('.zennotes/vault.json', JSON.stringify({ primaryNotesLocation: 'inbox' }))
  fs.put('inbox/Note.md', '# Note\n\n![[photo.png]]\n')
  fs.put('assets/photo.png', new Uint8Array([137, 80, 78, 71]))
  const vault = new PortableVault('Test', fs)
  await vault.open()
  return { vault, fs }
}

function tokenDirs(fs: MemoryVaultFileSystem): string[] {
  return [...fs.directories].filter((dir) => /^\.zennotes\/deleted-assets\/[^/]+$/.test(dir))
}

describe('deleting an attachment', () => {
  beforeEach(() => {
    installTestHost()
  })

  it('records where it came from before moving it, and lists it for restore', async () => {
    const { vault, fs } = await openVault()
    const deleted = await vault.deleteAsset('assets/photo.png')
    assert.equal(fs.files.has('assets/photo.png'), false)
    const record = JSON.parse(fs.text(`.zennotes/deleted-assets/${deleted.undoToken}/${META}`) ?? 'null')
    assert.equal(record.path, 'assets/photo.png')
    assert.equal(record.name, 'photo.png')
    assert.deepEqual((await vault.listDeletedAssets()).map((asset) => asset.undoToken), [deleted.undoToken])
  })

  it('leaves the asset where it was, with no token folder, when the record cannot be written', async () => {
    const { vault, fs } = await openVault()
    fs.failNext('writeText', new Error('disk full'))
    await assert.rejects(vault.deleteAsset('assets/photo.png'), /disk full/)
    assert.equal(fs.files.has('assets/photo.png'), true)
    assert.deepEqual(tokenDirs(fs), [])
    assert.deepEqual(await vault.listDeletedAssets(), [])
  })

  it('leaves the asset where it was, and drops the record, when the move fails', async () => {
    const { vault, fs } = await openVault()
    fs.failNext('rename', new Error('busy'))
    await assert.rejects(vault.deleteAsset('assets/photo.png'), /busy/)
    assert.equal(fs.files.has('assets/photo.png'), true)
    assert.deepEqual(tokenDirs(fs), [])
  })
})

describe('restoring a deleted attachment', () => {
  beforeEach(() => {
    installTestHost()
  })

  it('puts it back where the record says, whatever name and path the caller sends', async () => {
    const { vault, fs } = await openVault()
    const deleted = await vault.deleteAsset('assets/photo.png')
    const restored = await vault.restoreDeletedAsset({ ...deleted, name: META, path: 'elsewhere/evil.png' })
    assert.equal(restored.path, 'assets/photo.png')
    assert.equal(fs.files.has('assets/photo.png'), true)
    assert.equal(fs.files.has('elsewhere/evil.png'), false)
    assert.deepEqual(tokenDirs(fs), [])
  })

  it('refuses a record that names its own metadata file or a nested path', async () => {
    for (const name of [META, 'nested/photo.png', '   ']) {
      const { vault, fs } = await openVault()
      const deleted = await vault.deleteAsset('assets/photo.png')
      fs.put(`.zennotes/deleted-assets/${deleted.undoToken}/${META}`, JSON.stringify({ path: 'assets/photo.png', name }))
      await assert.rejects(vault.restoreDeletedAsset(deleted), /can no longer be restored/)
      // The real bytes are still in the store, not destroyed by a cleanup.
      assert.equal(fs.files.has(`.zennotes/deleted-assets/${deleted.undoToken}/photo.png`), true)
    }
  })

  it('refuses a token that is not one the store hands out', async () => {
    const { vault } = await openVault()
    await assert.rejects(
      vault.restoreDeletedAsset({ path: 'a.png', name: 'a.png', undoToken: '../../etc' }),
      /Invalid restore token/
    )
  })
})
