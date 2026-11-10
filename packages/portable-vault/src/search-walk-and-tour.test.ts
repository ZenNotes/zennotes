import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'vitest'
import { DEMO_TOUR_NOTES } from '@zennotes/shared-domain/demo-tour-data'
import { MemoryVaultFileSystem } from './memory-fs'
import { PortableVault } from './vault-fs'
import { installTestHost } from '../test/test-host'

/** Records every listing and read path, the way a document-provider folder
 *  would bill them. */
class CountingFs extends MemoryVaultFileSystem {
  readonly listed: string[] = []
  readonly read: string[] = []
  override async readdirStrict(relPath: string) {
    this.listed.push(relPath)
    return super.readdirStrict(relPath)
  }
  override async readText(relPath: string) {
    this.read.push(relPath)
    return super.readText(relPath)
  }
}

describe('searching a vault with a template folder (#1024)', () => {
  beforeEach(() => {
    installTestHost()
  })

  // Template notes are placeholders nobody searches for. The iPhone read every
  // one and dropped them after collecting; Android never walks the folder,
  // which matters where each listing and read is a provider query.
  it('never lists or reads a path inside the template folder, and still finds real notes', async () => {
    const fs = new CountingFs()
    fs.put('.zennotes/vault.json', JSON.stringify({
      primaryNotesLocation: 'root',
      templates: { folder: 'Templates' }
    }))
    fs.put('Templates/Meeting.md', '# Meeting\n\nquarterly agenda\n')
    fs.put('Templates/Nested/Deep.md', 'quarterly agenda\n')
    fs.put('Projects/Plan.md', '# Plan\n\nquarterly agenda\n')
    const vault = new PortableVault('Test', fs)
    await vault.open()
    fs.listed.length = 0
    fs.read.length = 0

    const matches = await vault.searchVaultText('quarterly')
    assert.deepEqual(matches.map((match) => match.path), ['Projects/Plan.md'])
    assert.equal(fs.listed.some((path) => path === 'Templates' || path.startsWith('Templates/')), false)
    assert.equal(fs.read.some((path) => path.startsWith('Templates/')), false)
  })
})

describe('removing the demo tour', () => {
  beforeEach(() => {
    installTestHost()
  })

  // Core 2.68.0 renamed the tour's notes from "NN <U+2014> Title" to "NN Title".
  // Regenerate and Remove delete what the older-name match returns, so only a
  // file may match; a folder of the user's that carries such a name stays.
  it('neither deletes nor reports a folder named like an older tour note', async () => {
    const fs = new MemoryVaultFileSystem()
    fs.put('.zennotes/vault.json', JSON.stringify({ primaryNotesLocation: 'inbox' }))
    const current = DEMO_TOUR_NOTES[0]!.path
    const slash = current.lastIndexOf('/')
    const [, number, title] = /^(\d{2}b?) (.+)$/.exec(current.slice(slash + 1))!
    const older = `${current.slice(0, slash)}/${number} \u2014 ${title}`
    fs.put(`${older}/mine.md`, 'my own note\n')
    const vault = new PortableVault('Test', fs)
    await vault.open()

    const removed = await vault.removeDemoTour()
    assert.equal(removed.notePaths.includes(older), false)
    assert.equal(fs.text(`${older}/mine.md`), 'my own note\n')
  })

  it('still removes a tour note left under its older name', async () => {
    const fs = new MemoryVaultFileSystem()
    fs.put('.zennotes/vault.json', JSON.stringify({ primaryNotesLocation: 'inbox' }))
    const current = DEMO_TOUR_NOTES[0]!.path
    const slash = current.lastIndexOf('/')
    const [, number, title] = /^(\d{2}b?) (.+)$/.exec(current.slice(slash + 1))!
    const older = `${current.slice(0, slash)}/${number} \u2014 ${title}`
    fs.put(older, '# old tour note\n')
    const vault = new PortableVault('Test', fs)
    await vault.open()

    const removed = await vault.removeDemoTour()
    assert.equal(removed.notePaths.includes(older), true)
    assert.equal(fs.files.has(older), false)
  })
})
