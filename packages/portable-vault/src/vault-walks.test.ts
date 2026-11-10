import assert from 'node:assert/strict'
import { afterEach, beforeEach, test, vi } from 'vitest'
import { MemoryVaultFileSystem } from './memory-fs'
import { PortableVault } from './vault-fs'

// app-core asks for notes and folders together on every refresh, with two
// refreshes at once when a note is created or the app comes back, so one New
// note listed the tree four times over. On Android, where a picked folder
// answers every listing with a document-provider query, that took 12 to 15
// seconds on a budget phone (zennotesandroid#128), and these walks are the
// same code. Overlapping walks now share their listings, a write the vault
// makes never lets a listing taken before it be reused, and the task scan
// reads only notes whose listing changed.

/** The in-memory disk, counting listings and reads per path. Its writes move
 *  the write generation the way the phones' NativeFs does. */
class CountingFs extends MemoryVaultFileSystem {
  readonly listings = new Map<string, number>()
  readonly reads = new Map<string, number>()

  override async readdirStrict(path: string) {
    this.listings.set(path, (this.listings.get(path) ?? 0) + 1)
    return await super.readdirStrict(path)
  }
  override async readText(path: string): Promise<string> {
    this.reads.set(path, (this.reads.get(path) ?? 0) + 1)
    return await super.readText(path)
  }
  listingsOf(path: string): number {
    return this.listings.get(path) ?? 0
  }
  totalReads(): number {
    // Notes only: vault.json and the meta cache are read on their own terms.
    return [...this.reads.entries()].filter(([path]) => path.endsWith('.md')).reduce((n, [, count]) => n + count, 0)
  }
}

function fixture() {
  const fs = new CountingFs()
  fs.put('.zennotes/vault.json', JSON.stringify({ primaryNotesLocation: 'inbox' }))
  fs.put('inbox/Plan.md', '# Plan\n\n- [ ] write the plan\n')
  fs.put('inbox/Projects/Site.md', '# Site\n\n- [ ] ship the site\n')
  fs.put('inbox/Projects/Notes.md', '# Notes\n\nno tasks here\n')
  fs.put('quick/Quick Note.md', '# Quick Note\n\n- [ ] call back\n')
  fs.put('archive/Old.md', '# Old\n\n- [x] done long ago\n')
  fs.put('trash/Gone.md', '# Gone\n\n- [ ] in the trash\n')
  fs.put('attachements/photo.png', 'png')
  const vault = new PortableVault('Fixture', fs)
  return { fs, vault }
}

const paths = (notes: { path: string }[]): string[] => notes.map((note) => note.path).sort()

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(() => {
  vi.useRealTimers()
})

test('a refresh lists each folder once while notes, folders and assets are walked together', async () => {
  const { fs, vault } = fixture()
  const [notes, folders, assets] = await Promise.all([
    vault.listNotes(), vault.listFolders(), vault.listAssets(),
    // The second refresh a new note starts, overlapping the first.
    vault.listNotes(), vault.listFolders()
  ])
  assert.deepEqual(paths(notes), [
    'archive/Old.md', 'inbox/Plan.md', 'inbox/Projects/Notes.md', 'inbox/Projects/Site.md',
    'quick/Quick Note.md', 'trash/Gone.md'
  ])
  assert.deepEqual(folders.map((f: { subpath: string }) => f.subpath), ['Projects'])
  assert.deepEqual(assets.map((a: { path: string }) => a.path), ['attachements/photo.png'])
  for (const dir of ['inbox', 'inbox/Projects', 'quick', 'archive', 'trash']) {
    assert.equal(fs.listingsOf(dir), 1, `${dir} listed once`)
  }
})

test('a write the vault makes is never hidden by a listing taken before it', async () => {
  const { fs, vault } = fixture()
  await vault.listNotes()
  await vault.writeNote('inbox/Fresh.md', '# Fresh\n')
  // Within the grace window, right after the write: the note is listed.
  assert.ok(paths(await vault.listNotes()).includes('inbox/Fresh.md'))
  assert.equal(fs.listingsOf('inbox/Projects'), 2)
})

test('a walk after the grace window lists afresh, so a rescan sees outside changes', async () => {
  const { fs, vault } = fixture()
  await vault.listNotes()
  // Syncthing drops a note in; the vault made no write.
  fs.put('inbox/From Desktop.md', '# From Desktop\n')
  assert.equal(paths(await vault.listNotes()).includes('inbox/From Desktop.md'), false)
  vi.advanceTimersByTime(1000)
  assert.equal(paths(await vault.listNotes()).includes('inbox/From Desktop.md'), true)
})

test('the task scan reads a note again only when its listing changed', async () => {
  const { fs, vault } = fixture()
  const titles = async (): Promise<string[]> =>
    (await vault.scanTasks()).map((task: { content: string }) => task.content).sort()

  assert.deepEqual(await titles(), ['call back', 'done long ago', 'ship the site', 'write the plan'])
  const firstReads = fs.totalReads()

  vi.advanceTimersByTime(1000)
  assert.deepEqual(await titles(), ['call back', 'done long ago', 'ship the site', 'write the plan'])
  assert.equal(fs.totalReads(), firstReads, 'an unchanged vault is not read again')

  // Edited elsewhere: new mtime and size in the listing.
  fs.put('inbox/Projects/Site.md', '# Site\n\n- [ ] ship it today\n')
  const readsBefore = new Map(fs.reads)
  vi.advanceTimersByTime(1000)
  assert.deepEqual(await titles(), ['call back', 'done long ago', 'ship it today', 'write the plan'])
  const readAgain = [...fs.reads].filter(([path, n]) => path.endsWith('.md') && n !== readsBefore.get(path))
  assert.deepEqual(readAgain.map(([path]) => path), ['inbox/Projects/Site.md'])
})

test('a note the app writes is read again by the next task scan', async () => {
  const { fs, vault } = fixture()
  await vault.scanTasks()
  const before = fs.reads.get('inbox/Plan.md') ?? 0
  await vault.writeNote('inbox/Plan.md', '# Plan\n\n- [x] write the plan\n')
  const plan = (await vault.scanTasks()).filter((task: { sourcePath: string }) => task.sourcePath === 'inbox/Plan.md')
  assert.deepEqual(plan.map((task: { checked: boolean }) => task.checked), [true])
  assert.equal((fs.reads.get('inbox/Plan.md') ?? 0) > before, true)
})
