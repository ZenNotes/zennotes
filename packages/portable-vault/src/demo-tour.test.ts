import assert from 'node:assert/strict'
import { test } from 'vitest'
import { DEMO_TOUR_ASSETS, DEMO_TOUR_NOTES } from '@zennotes/shared-domain/demo-tour-data'
import { MemoryVaultFileSystem } from './memory-fs'
import { PortableVault } from './vault-fs'

// Before core 2.68.0 the demo tour named its notes "NN <U+2014> Title"; it now
// writes "NN Title". Desktop's vault.ts removes and replaces the notes under
// either name, and a tour seeded by an older build (on this phone, or synced
// from a desktop) must not survive Remove or come back doubled by Regenerate.
// Both delete what they match, so the match is exact: only the old separator,
// and only a name that becomes one of the tour's own notes.

// The in-memory disk stands in for the phones' NativeFs: like the providers, a
// delete of a missing file fails, and like Filesystem.readdir, an empty folder
// is listed too.

const currentPaths: string[] = DEMO_TOUR_NOTES.map((note: { path: string }) => note.path)
const olderName = (path: string): string => path.replace(/^(inbox\/demo\/\d{2}b?) /, '$1 \u2014 ')
// Only a note named "NN Title" or "NNb Title" can have had the older name;
// one added since, like "05c D2 Diagrams", never did.
const renamedPaths = currentPaths.filter((path) => olderName(path) !== path)
const assetPaths = new Set<string>(DEMO_TOUR_ASSETS.map((asset: { path: string }) => asset.path))

/** The user's own notes beside the tour. Each looks related, and none is the
 *  tour's: a tour title behind a middle dot or an en dash instead of the old
 *  separator, the old separator in front of a title the tour never had, and a
 *  plain note. Remove and Regenerate must leave every one byte for byte. */
const USER_NOTES = new Map<string, string>([
  ['inbox/demo/00 \u00b7 Start Here.md', '# Middle dot\n'],
  ['inbox/demo/01 \u2013 Markdown Basics.md', '# En dash\n'],
  ['inbox/demo/99 \u2014 Not from the tour.md', '# Old separator, own title\n'],
  ['inbox/demo/My own note.md', '# Mine\n']
])

function vaultWith(paths: (path: string) => string) {
  const fs = new MemoryVaultFileSystem()
  for (const note of DEMO_TOUR_NOTES) fs.put(paths(note.path), note.body)
  for (const asset of DEMO_TOUR_ASSETS) fs.put(asset.path, asset.body)
  for (const [path, body] of USER_NOTES) fs.put(path, body)
  const vault = new PortableVault('Fixture', fs)
  Object.assign(vault, { ensureVaultLayout: async () => {} })
  return { fs, vault }
}

const tourNotesOnDisk = (fs: MemoryVaultFileSystem): string[] =>
  [...fs.files.keys()].filter((key) => key.startsWith('inbox/demo/') && !USER_NOTES.has(key) && !assetPaths.has(key)).sort()

function assertUserNotesKept(fs: MemoryVaultFileSystem): void {
  for (const [path, body] of USER_NOTES) assert.equal(fs.text(path), body, `${path} was touched`)
}

test('the older names are the tour notes behind the old separator', () => {
  assert.equal(currentPaths.length, 22)
  assert.ok(renamedPaths.includes('inbox/demo/00 Start Here.md'))
  assert.ok(!renamedPaths.includes('inbox/demo/05c D2 Diagrams.md'))
})

test('removing the tour deletes the notes it wrote under their older names', async () => {
  const { fs, vault } = vaultWith(olderName)

  const result = await vault.removeDemoTour()

  assert.deepEqual(tourNotesOnDisk(fs), [])
  for (const asset of DEMO_TOUR_ASSETS) assert.equal(fs.files.has(asset.path), false)
  assertUserNotesKept(fs)
  // The core unlinks every reported path, so the older names must be in it.
  assert.deepEqual(
    [...result.notePaths].sort(),
    [...currentPaths, ...renamedPaths.map(olderName)].sort()
  )
})

test('regenerating replaces a tour seeded under the older names instead of adding a second copy', async () => {
  const { fs, vault } = vaultWith(olderName)

  const result = await vault.generateDemoTour()

  assert.deepEqual(tourNotesOnDisk(fs), [...currentPaths].sort())
  for (const note of DEMO_TOUR_NOTES) assert.equal(fs.text(note.path), note.body)
  assertUserNotesKept(fs)
  assert.deepEqual(result.notePaths, currentPaths)
})

test('a tour under the current names is removed as before', async () => {
  const { fs, vault } = vaultWith((path) => path)

  const result = await vault.removeDemoTour()

  assert.deepEqual(tourNotesOnDisk(fs), [])
  assertUserNotesKept(fs)
  assert.deepEqual(result.notePaths, currentPaths)
})

test('removing the tour takes the sample database folder with it', async () => {
  // Core 2.71.0 ships a database, which is a folder of its own; the tour
  // folder could not go while that folder stayed behind.
  const fs = new MemoryVaultFileSystem()
  const vault = new PortableVault('Fixture', fs)
  Object.assign(vault, { ensureVaultLayout: async () => {} })

  await vault.generateDemoTour()
  assert.ok(fs.directories.has('inbox/demo/Reading List.base'))
  await vault.removeDemoTour()

  assert.equal(fs.directories.has('inbox/demo/Reading List.base'), false)
  assert.equal(fs.directories.has('inbox/demo'), false)
})
