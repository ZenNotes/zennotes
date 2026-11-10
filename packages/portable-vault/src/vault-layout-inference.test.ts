import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { PortableVaultFiles } from './host'
import { MemoryVaultFileSystem } from './memory-fs'
import { PortableVault } from './vault-fs'

// A folder opened before its notes arrived (#1023): this app makes `inbox/` on
// first open, and nothing may keep the notes that land beside it out of view.
function fixture(files: string[], dirs: string[] = []) {
  const fs = new MemoryVaultFileSystem()
  for (const file of files) fs.put(file, '')
  for (const dir of dirs) fs.directories.add(dir)
  const vault = new PortableVault('Fixture', fs)
  return { fs, vault }
}
const layout = async (vault: PortableVault) => (await vault.getVaultSettings()).primaryNotesLocation

test('an empty inbox does not hold back folders that arrived beside it', async () => {
  assert.equal(await layout(fixture(['Trips/Rome.md', 'Work/Plan.md'], ['inbox', 'quick', 'archive', 'trash']).vault), 'root')
})

test('an empty inbox does not hold back a loose note at the root', async () => {
  assert.equal(await layout(fixture(['Loose.md'], ['inbox']).vault), 'root')
})

test('dotfiles inside the inbox are not notes', async () => {
  assert.equal(await layout(fixture(['inbox/.DS_Store', 'Trips/Rome.md'], ['inbox']).vault), 'root')
})

test('an inbox with anything in it stays inbox mode, loose folders or not', async () => {
  assert.equal(await layout(fixture(['inbox/Welcome.md', 'Daily/2026-11-04.md']).vault), 'inbox')
})

test('an empty vault and a media-only vault stay inbox mode', async () => {
  assert.equal(await layout(fixture([], ['inbox']).vault), 'inbox')
  assert.equal(await layout(fixture(['VID_1.mp4'], ['inbox']).vault), 'inbox')
})

test('the banner sees notes an inbox-mode vault.json hides when the inbox is empty', async () => {
  const { vault } = fixture(['Trips/Rome.md'], ['inbox'])
  Object.assign(vault, { settingsCache: { ...(await vault.getVaultSettings()), primaryNotesLocation: 'inbox' } })
  assert.equal(await vault.rootContentHiddenByInboxMode(), true)
})

test('the banner speaks up when an inbox with a note hides folders beside it', async () => {
  const { vault } = fixture(['inbox/First.md', 'Trips/Rome.md'])
  assert.equal(await layout(vault), 'inbox')
  assert.equal(await vault.rootContentHiddenByInboxMode(), true)
})

test('the banner stays quiet with nothing loose at the root', async () => {
  const { vault } = fixture(['inbox/First.md', 'VID_1.mp4'], ['quick', 'archive', 'trash'])
  assert.equal(await vault.rootContentHiddenByInboxMode(), false)
})

test('a resume that settles the layout re-reads it', async () => {
  const { fs, vault } = fixture([], ['inbox'])
  assert.equal(await layout(vault), 'inbox')
  fs.put('Trips/Rome.md', '')
  Object.assign(vault, { listNotes: async () => [] })
  await vault.rescan()
  assert.equal(await layout(vault), 'root')
})

// The inbox as an empty folder among the notes, once the vault reads root mode.
// A scripted file system, not a disk: every read answers `vaultJson`, writes
// keep nothing, and each mkdir and removal is recorded in the order it ran.
function layoutFixture(vaultJson: string | null, inboxEntries: string[] = []) {
  const made: string[] = []
  const removed: string[] = []
  const fs: Partial<PortableVaultFiles> = {
    rootLabel: '/fixture',
    readdir: async (dir: string) =>
      dir === 'inbox'
        ? inboxEntries.map((name) => ({ name, type: 'file' as const, size: 0, mtime: 0 }))
        : dir === ''
          ? [{ name: 'inbox', type: 'directory' as const, size: 0, mtime: 0 }]
          : [],
    statVerified: async (rel: string) => (rel === 'inbox/.DS_Store' && inboxEntries.includes('.DS_Store') ? 'file' : null),
    deleteFile: async (rel: string) => { removed.push(rel) },
    readTextOrNull: async () => vaultJson,
    writeText: async () => {},
    mkdir: async (dir: string) => { made.push(dir) },
    rmdirIfEmpty: async (dir: string) => { removed.push(dir) },
    rmdir: async () => { throw new Error('never the recursive rmdir') }
  }
  const vault = new PortableVault('Fixture', fs as PortableVaultFiles)
  return { vault, made, removed }
}
const stated = (primary: string, extra: object = {}) => JSON.stringify({ primaryNotesLocation: primary, ...extra })

test('a folder that states no layout gets no inbox on open', async () => {
  const { vault, made } = layoutFixture(null)
  await vault.ensureVaultLayout()
  assert.deepEqual(made, ['quick', 'archive', 'trash'])
})

test('a vault that states inbox mode still gets its inbox on open', async () => {
  const { vault, made } = layoutFixture(stated('inbox'))
  await vault.ensureVaultLayout()
  assert.deepEqual(made, ['inbox', 'quick', 'archive', 'trash'])
})

test('going to root mode takes an empty inbox with it', async () => {
  const { vault, removed } = layoutFixture(stated('inbox'))
  await vault.setVaultSettings({ ...(await vault.getVaultSettings()), primaryNotesLocation: 'root' })
  assert.deepEqual(removed, ['inbox'])
})

test('going to root mode leaves an inbox holding anything, a dotfile included', async () => {
  for (const entries of [['Welcome.md'], ['.obsidian']]) {
    const { vault, removed } = layoutFixture(stated('inbox'), entries)
    await vault.setVaultSettings({ ...(await vault.getVaultSettings()), primaryNotesLocation: 'root' })
    assert.deepEqual(removed, [])
  }
})

test("going to root mode reads past Finder's .DS_Store, as the desktop does", async () => {
  const { vault, removed } = layoutFixture(stated('inbox'), ['.DS_Store'])
  await vault.setVaultSettings({ ...(await vault.getVaultSettings()), primaryNotesLocation: 'root' })
  assert.deepEqual(removed, ['inbox/.DS_Store', 'inbox'])
})

test('a vault already in root mode keeps a folder of its own named inbox', async () => {
  const { vault, removed } = layoutFixture(stated('root'))
  await vault.setVaultSettings({ ...(await vault.getVaultSettings()), primaryNotesLocation: 'root' })
  assert.deepEqual(removed, [])
})

test('going to root mode leaves a folder the inbox was remapped to', async () => {
  const { vault, removed } = layoutFixture(stated('inbox', { systemFolderPaths: { inbox: '01 - Entry' } }))
  await vault.setVaultSettings({ ...(await vault.getVaultSettings()), primaryNotesLocation: 'root' })
  assert.deepEqual(removed, [])
})
