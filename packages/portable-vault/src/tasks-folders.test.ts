import assert from 'node:assert/strict'
import { test } from 'vitest'
import { MemoryVaultFileSystem } from './memory-fs'
import { PortableVault } from './vault-fs'

// The vault's Tasks folder lists from vault.json, read by the on-device
// scanners: `tasks.excludedFolders` (#458) keeps folders out, and
// `tasks.includedFolders`, the Task folders (#962), narrows Tasks to the notes
// inside them, the excluded list still applying within. Same rule as desktop
// main, the Go server and the Go CLI.

const SETTINGS = '.zennotes/vault.json'

/** The in-memory disk. Like the providers, a move never lands on something
 *  that is already there. */
class MemoryFs extends MemoryVaultFileSystem {
  override async rename(from: string, to: string): Promise<void> {
    assert.ok(await this.exists(from)); assert.equal(await this.exists(to), false)
    await super.rename(from, to)
  }
}

function fixture(tasks: unknown) {
  const fs = new MemoryFs(), vault = new PortableVault('Fixture', fs)
  fs.put(SETTINGS, JSON.stringify({ primaryNotesLocation: 'inbox', ...(tasks === undefined ? {} : { tasks }) }))
  fs.put('inbox/Tasks/Plan.md', '# Plan\n\n- [ ] in the Task folder\n')
  fs.put('inbox/Tasks/Done/Old.md', '# Old\n\n- [ ] in a left-out folder inside it\n')
  fs.put('inbox/Tasksheet.md', '# Tasksheet\n\n- [ ] beside it, sharing a name prefix\n')
  fs.put('inbox/Projects/Site.md', '# Site\n\n- [ ] outside the Task folder\n')
  fs.put('trash/Gone.md', '# Gone\n\n- [ ] in the trash\n')
  Object.assign(vault, {
    invalidateMeta: () => {},
    // The scanners walk listNotes(); answer from the memory files so a rename
    // shows up in the next scan.
    listNotes: async () => [...fs.files.keys()]
      .filter(path => path.endsWith('.md'))
      .map(path => ({
        path,
        title: path.split('/').pop()!.replace(/\.md$/, ''),
        folder: path.startsWith('trash/') ? 'trash' : 'inbox'
      }))
  })
  return { fs, vault }
}

const scanned = async (vault: PortableVault): Promise<string[]> =>
  [...new Set<string>((await vault.scanTasks()).map((task: { sourcePath: string }) => task.sourcePath))].sort()

const rescanned = async (vault: PortableVault, fs: MemoryFs): Promise<string[]> => {
  const out: string[] = []
  for (const path of [...fs.files.keys()].filter(path => path.endsWith('.md')).sort()) {
    if ((await vault.scanTasksForPath(path)).length > 0) out.push(path)
  }
  return out
}

test('Task folders narrow Tasks to the notes inside them, and the excluded list still applies within', async () => {
  const { fs, vault } = fixture({ includedFolders: ['inbox/Tasks'], excludedFolders: ['inbox/Tasks/Done'] })
  assert.deepEqual(await scanned(vault), ['inbox/Tasks/Plan.md'])
  // A single-note rescan agrees, or an edit would bring a left-out note back.
  assert.deepEqual(await rescanned(vault, fs), ['inbox/Tasks/Plan.md'])
})

test('no Task folders means the whole vault, less the excluded folders and the trash', async () => {
  const { fs, vault } = fixture({ excludedFolders: ['inbox/Projects'] })
  const expected = ['inbox/Tasks/Done/Old.md', 'inbox/Tasks/Plan.md', 'inbox/Tasksheet.md']
  assert.deepEqual(await scanned(vault), expected)
  assert.deepEqual(await rescanned(vault, fs), expected)
})

test('a vault.json without Tasks settings lists every live note', async () => {
  const { vault } = fixture(undefined)
  assert.deepEqual(await scanned(vault), [
    'inbox/Projects/Site.md', 'inbox/Tasks/Done/Old.md', 'inbox/Tasks/Plan.md', 'inbox/Tasksheet.md'
  ])
})

test('the folder lists are validated on read, and a save from this device keeps the Task folders', async () => {
  const { fs, vault } = fixture({
    includedFolders: ['inbox/Tasks/', '../escape', '', 'inbox/Tasks', 7],
    excludedFolders: 'not a list',
    mode: 'tagged'
  })
  const settings = await vault.getVaultSettings()
  assert.deepEqual(settings.tasks, { mode: 'tagged', includedFolders: ['inbox/Tasks'] })
  await vault.setVaultSettings({ ...settings, favorites: ['inbox/Tasks/Plan.md'] })
  const written = JSON.parse(fs.text(SETTINGS)!)
  assert.deepEqual(written.tasks, { mode: 'tagged', includedFolders: ['inbox/Tasks'] })
  assert.deepEqual(written.favorites, ['inbox/Tasks/Plan.md'])
})

test('lists that end up empty leave no tasks stub in vault.json', async () => {
  const { fs, vault } = fixture({ includedFolders: [], excludedFolders: ['', '..'] })
  const settings = await vault.getVaultSettings()
  assert.equal('tasks' in settings, false)
  await vault.setVaultSettings(settings)
  assert.equal('tasks' in JSON.parse(fs.text(SETTINGS)!), false)
})

test('renaming a folder repoints both lists, so the Task folder keeps its tasks', async () => {
  const { fs, vault } = fixture({ includedFolders: ['inbox/Tasks', 'inbox/Projects'], excludedFolders: ['inbox/Tasks/Done'] })
  await vault.renameFolder('inbox', 'Tasks', 'Todo')
  assert.deepEqual(JSON.parse(fs.text(SETTINGS)!).tasks, {
    excludedFolders: ['inbox/Todo/Done'],
    includedFolders: ['inbox/Todo', 'inbox/Projects']
  })
  assert.deepEqual(await scanned(vault), ['inbox/Projects/Site.md', 'inbox/Todo/Plan.md'])
  // A folder that is neither listed nor inside a listed one leaves the lists alone.
  fs.put('inbox/Notes/Loose.md', '# Loose\n')
  await vault.renameFolder('inbox', 'Notes', 'Kept')
  assert.deepEqual(JSON.parse(fs.text(SETTINGS)!).tasks.includedFolders, ['inbox/Todo', 'inbox/Projects'])
})
