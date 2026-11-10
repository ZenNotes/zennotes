import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'vitest'
import { MemoryVaultFileSystem } from './memory-fs'
import { PortableVault } from './vault-fs'

// Core 2.80.0's template folder (ZenNotes/zennotes#1024) lives in vault.json
// as `templates.folder`. app-core reads it for every host (the picker, the
// Settings row, the tag surfaces), but the on-device vault writes vault.json
// and scans tasks and text itself, so it keeps the setting through a save,
// follows a folder rename, and leaves the folder out of Tasks and search, as
// desktop main and the Go server do. Its task scan also hands the Kanban board
// each subtask's parent (#1028), held to the core's contract fixture.

const SETTINGS = '.zennotes/vault.json'

/** The in-memory disk. Like the providers, a move never lands on something
 *  that is already there. */
class MemoryFs extends MemoryVaultFileSystem {
  override async rename(from: string, to: string): Promise<void> {
    assert.ok(await this.exists(from)); assert.equal(await this.exists(to), false)
    await super.rename(from, to)
  }
}

function fixture(settings: Record<string, unknown>) {
  const fs = new MemoryFs(), vault = new PortableVault('Fixture', fs)
  fs.put(SETTINGS, JSON.stringify({ primaryNotesLocation: 'inbox', ...settings }))
  fs.put('inbox/Templates/Meeting.md', '# Meeting\n\n- [ ] agenda item\nquarterly review\n')
  fs.put('inbox/Templates/Work/Standup.md', '# Standup\n\n- [ ] yesterday\n')
  fs.put('inbox/Templates Old/Kept.md', '# Kept\n\n- [ ] a real task\nquarterly review\n')
  fs.put('inbox/Plan.md', '# Plan\n\n- [ ] ship it\nquarterly review\n')
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

const written = (fs: MemoryFs) => JSON.parse(fs.text(SETTINGS)!)

const scanned = async (vault: PortableVault): Promise<string[]> =>
  [...new Set<string>((await vault.scanTasks()).map((task: { sourcePath: string }) => task.sourcePath))].sort()

const rescanned = async (vault: PortableVault, fs: MemoryFs): Promise<string[]> => {
  const out: string[] = []
  for (const path of [...fs.files.keys()].filter(path => path.endsWith('.md')).sort()) {
    if ((await vault.scanTasksForPath(path)).length > 0) out.push(path)
  }
  return out
}

test('a save from this device keeps a desktop user\'s template folder', async () => {
  const { fs, vault } = fixture({ templates: { folder: 'inbox/Templates' } })
  const settings = await vault.getVaultSettings()
  assert.deepEqual(settings.templates, { folder: 'inbox/Templates' })
  await vault.setVaultSettings({ ...settings, favorites: ['inbox/Plan.md'] })
  assert.deepEqual(written(fs).templates, { folder: 'inbox/Templates' })
  assert.deepEqual(written(fs).favorites, ['inbox/Plan.md'])
})

test('the folder is normalized as shared-domain normalizes it: cleaned, folder only, an unusable one dropped', async () => {
  const cases: [unknown, unknown][] = [
    [{ folder: ' inbox//Templates/ ' }, { folder: 'inbox/Templates' }],
    [{ folder: 'inbox\\Templates' }, { folder: 'inbox/Templates' }],
    [{ folder: 'inbox/.hidden' }, undefined],
    [{ folder: '../outside' }, undefined],
    [{ folder: '' }, undefined],
    [{ folder: 7 }, undefined],
    ['Templates', undefined],
    [['Templates'], undefined],
    // Only the folder is kept, as desktop main and the Go server keep it.
    [{ folder: 'inbox/Templates', later: true }, { folder: 'inbox/Templates' }],
    [{ folder: '..', later: true }, undefined]
  ]
  for (const [raw, expected] of cases) {
    const { fs, vault } = fixture({ templates: raw })
    const settings = await vault.getVaultSettings()
    assert.deepEqual(settings.templates, expected, JSON.stringify(raw))
    await vault.setVaultSettings(settings)
    // No empty stub in vault.json when nothing usable is left.
    assert.deepEqual(written(fs).templates, expected, JSON.stringify(raw))
    assert.equal('templates' in written(fs), expected !== undefined, JSON.stringify(raw))
  }
})

test('the template folder stays out of Tasks, even inside a Task folder, and its neighbour stays in', async () => {
  const { fs, vault } = fixture({ templates: { folder: 'inbox/Templates' } })
  const expected = ['inbox/Plan.md', 'inbox/Templates Old/Kept.md']
  assert.deepEqual(await scanned(vault), expected)
  // A single-note rescan agrees, or an edit would bring a template's tasks back.
  assert.deepEqual(await rescanned(vault, fs), expected)

  const inside = fixture({ templates: { folder: 'inbox/Templates' }, tasks: { includedFolders: ['inbox'] } })
  assert.deepEqual(await scanned(inside.vault), expected)
  assert.deepEqual(await rescanned(inside.vault, inside.fs), expected)
})

test('a vault without a template folder keeps every note\'s tasks', async () => {
  const { vault } = fixture({})
  assert.deepEqual(await scanned(vault), [
    'inbox/Plan.md', 'inbox/Templates Old/Kept.md', 'inbox/Templates/Meeting.md', 'inbox/Templates/Work/Standup.md'
  ])
})

test('renaming the folder, or one it sits in, carries the setting along', async () => {
  const { fs, vault } = fixture({ templates: { folder: 'inbox/Templates/Work' } })
  await vault.renameFolder('inbox', 'Templates/Work', 'Templates/Office')
  assert.deepEqual(written(fs).templates, { folder: 'inbox/Templates/Office' })
  await vault.renameFolder('inbox', 'Templates', 'Library/Templates')
  assert.deepEqual(written(fs).templates, { folder: 'inbox/Library/Templates/Office' })
  assert.deepEqual(await scanned(vault), [
    'inbox/Library/Templates/Meeting.md', 'inbox/Plan.md', 'inbox/Templates Old/Kept.md'
  ])
  // A folder that is neither the template folder nor holds it leaves it alone.
  await vault.renameFolder('inbox', 'Templates Old', 'Archive Old')
  assert.deepEqual(written(fs).templates, { folder: 'inbox/Library/Templates/Office' })
})

test('text search leaves template notes out before ranking', async () => {
  const { vault } = fixture({ templates: { folder: 'inbox/Templates' } })
  const paths = (await vault.searchVaultText('quarterly review')).map((match: { path: string }) => match.path).sort()
  assert.deepEqual(paths, ['inbox/Plan.md', 'inbox/Templates Old/Kept.md'])
  const none = fixture({})
  const all = (await none.vault.searchVaultText('quarterly review')).map((match: { path: string }) => match.path).sort()
  assert.deepEqual(all, ['inbox/Plan.md', 'inbox/Templates Old/Kept.md', 'inbox/Templates/Meeting.md'])
})

interface SubtaskCase {
  id: string
  note: { path: string; title: string; folder: string }
  body: string
  expectedTasks: { id: string; parentId?: string }[]
}

test('each scanned task names its parent the way the core contract fixture says (#1028)', async () => {
  // The phones read the fixture from the installed bridge-contract package;
  // here it is the monorepo's own copy.
  const fixtureUrl = new URL('../../bridge-contract/fixtures/task-subtasks.json', import.meta.url)
  const { cases } = JSON.parse(readFileSync(fixtureUrl, 'utf8')) as { cases: SubtaskCase[] }
  assert.ok(cases.length > 0)
  for (const testCase of cases) {
    const fs = new MemoryFs(), vault = new PortableVault('Fixture', fs)
    fs.put(SETTINGS, JSON.stringify({ primaryNotesLocation: 'inbox' }))
    fs.put(testCase.note.path, testCase.body)
    Object.assign(vault, {
      invalidateMeta: () => {},
      listNotes: async () => [{ path: testCase.note.path, title: testCase.note.title, folder: testCase.note.folder }]
    })
    const links = (tasks: { id: string; parentId?: string }[]) =>
      tasks.map(task => ('parentId' in task ? { id: task.id, parentId: task.parentId } : { id: task.id }))
    assert.deepEqual(links(await vault.scanTasksForPath(testCase.note.path)), testCase.expectedTasks, testCase.id)
    assert.deepEqual(links(await vault.scanTasks()), testCase.expectedTasks, testCase.id)
  }
})
