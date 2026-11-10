import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, vi } from 'vitest'
import { MemoryVaultFileSystem } from './memory-fs'
import { installTestHost } from '../test/test-host'

// Cloud sync mirrors paths verbatim; it knows nothing of a vault's layout. A
// fresh phone vault keeps its notes under inbox/ while most desktop vaults
// keep them at the root, so linking one to the other merged two trees and
// showed every daily note twice (zennotesandroid#17). Before the first sync
// of a new link, the vault now moves its own notes to the cloud's layout,
// read from the manifest's paths alone. Android's fix, both phones' now.

let cloudPaths: string[] = []
let manifestFails = false

beforeEach(() => {
  cloudPaths = []
  manifestFails = false
  installTestHost()
  vi.doMock('./mobile-cloud-auth', () => ({
    authenticatedClient: async () => ({
      manifest: async (_vaultId: string, options: { page: number }) => {
        if (manifestFails) throw new Error('offline')
        assert.equal(options.page, 1)
        return { data: cloudPaths.map((path) => ({ path })), next_page: null }
      }
    })
  }))
})

afterEach(() => {
  vi.doUnmock('./mobile-cloud-auth')
  vi.resetModules()
})

async function openVault(files: Record<string, string>) {
  const { installPortableHost } = await import('./host')
  installPortableHost(installTestHost())
  const { PortableVault } = await import('./vault-fs')
  const fs = new MemoryVaultFileSystem()
  for (const [path, body] of Object.entries(files)) fs.put(path, body)
  const vault = new PortableVault('Test', fs)
  await vault.open()
  return { vault, fs, layout: await import('./cloud-layout') }
}

describe('joining a Cloud vault with the other layout', () => {
  it('moves an inbox vault\'s notes to the root of a root-layout cloud vault', async () => {
    cloudPaths = ['Daily Notes/2026-11-01.md', 'Projects/Plan.md', '.zennotes/vault.json']
    const { vault, fs, layout } = await openVault({
      '.zennotes/vault.json': JSON.stringify({ primaryNotesLocation: 'inbox' }),
      'inbox/Daily Notes/2026-11-02.md': 'today\n',
      'inbox/Ideas.md': 'idea\n'
    })
    await layout.reconcileLayoutForCloudJoin(vault, 'vault-1')
    assert.equal(fs.text('Daily Notes/2026-11-02.md'), 'today\n')
    assert.equal(fs.text('Ideas.md'), 'idea\n')
    assert.equal(fs.directories.has('inbox'), false, 'the emptied inbox goes')
    assert.equal((await vault.getVaultSettings()).primaryNotesLocation, 'root')
  })

  it('moves a root vault\'s loose notes into the inbox of an inbox-layout cloud vault', async () => {
    cloudPaths = ['inbox/Welcome.md', 'archive/Old.md']
    const { vault, fs, layout } = await openVault({
      '.zennotes/vault.json': JSON.stringify({ primaryNotesLocation: 'root' }),
      'Ideas.md': 'idea\n',
      'Projects/Plan.md': 'plan\n',
      'assets/photo.png': 'png'
    })
    await layout.reconcileLayoutForCloudJoin(vault, 'vault-1')
    assert.equal(fs.text('inbox/Ideas.md'), 'idea\n')
    assert.equal(fs.text('inbox/Projects/Plan.md'), 'plan\n')
    assert.equal(fs.text('assets/photo.png'), 'png', 'attachments are machinery and never move')
    assert.equal((await vault.getVaultSettings()).primaryNotesLocation, 'inbox')
  })

  it('leaves a note where it is when the other layout already has one by that name', async () => {
    cloudPaths = ['Ideas.md']
    const { vault, fs, layout } = await openVault({
      '.zennotes/vault.json': JSON.stringify({ primaryNotesLocation: 'inbox' }),
      'inbox/Ideas.md': 'mine\n',
      'Ideas.md': 'already at the root\n'
    })
    await layout.reconcileLayoutForCloudJoin(vault, 'vault-1')
    assert.equal(fs.text('inbox/Ideas.md'), 'mine\n')
    assert.equal(fs.text('Ideas.md'), 'already at the root\n')
  })

  it('changes nothing when the cloud tree says nothing about its layout', async () => {
    cloudPaths = ['assets/photo.png', 'archive/Old.md', '.zennotes/vault.json']
    const files = {
      '.zennotes/vault.json': JSON.stringify({ primaryNotesLocation: 'inbox' }),
      'inbox/Ideas.md': 'idea\n'
    }
    const { vault, fs, layout } = await openVault(files)
    await layout.reconcileLayoutForCloudJoin(vault, 'vault-1')
    assert.equal(fs.text('inbox/Ideas.md'), 'idea\n')
    assert.equal((await vault.getVaultSettings()).primaryNotesLocation, 'inbox')
  })

  it('reports a failed manifest read to its caller, which keeps the link', async () => {
    manifestFails = true
    const { vault, layout } = await openVault({ '.zennotes/vault.json': JSON.stringify({ primaryNotesLocation: 'inbox' }) })
    await assert.rejects(layout.reconcileLayoutForCloudJoin(vault, 'vault-1'), /offline/)
  })
})
