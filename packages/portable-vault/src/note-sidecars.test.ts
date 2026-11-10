import assert from 'node:assert/strict'
import { test } from 'vitest'
import { DEFAULT_VAULT_SETTINGS } from '@zennotes/bridge-contract/ipc'
import { MemoryVaultFileSystem } from './memory-fs'
import { PortableVault } from './vault-fs'

// A note's two app-owned sidecars, at the paths desktop writes them
// (apps/desktop/src/main/note-sidecars.ts and note-creation-metadata.ts). A
// rename or move that leaves either behind loses the comments and the
// creation date on every device, and Cloud sync carries the orphan around.
const comments = (rel: string): string => `.zennotes/comments/${rel}.comments.json`
const created = (rel: string): string => `.zennotes/note-metadata/${rel}.metadata.json`

/** The in-memory disk, with a move the provider can refuse. Like the
 *  providers, a rename never overwrites and a delete of a missing file fails
 *  (MemoryVaultFileSystem's own deleteFile already does). */
class MemoryFs extends MemoryVaultFileSystem {
  failMove: ((from: string, to: string) => boolean) | null = null
  override async rename(from: string, to: string): Promise<void> {
    if (this.failMove?.(from, to)) throw new Error('Provider refused move')
    assert.ok(await this.exists(from), `nothing to move at ${from}`)
    assert.equal(await this.exists(to), false, `a move must never overwrite ${to}`)
    await super.rename(from, to)
  }
}
/** Every file's text by path, the shape the phone's fake kept its files in. */
const snapshot = (fs: MemoryVaultFileSystem) => new Map([...fs.files.keys()].map((key) => [key, fs.text(key)!]))

const NOTE_BODY = '# One\n\nExact café 日本語.\n'
const COMMENTS_BODY = '{"version":1,"comments":[{"id":"c1","body":"keep me"}]}'
const CREATED_BODY = '{"version":1,"createdAt":1726000000000}\n'

/** One note with both sidecars, in a vault whose system folders are remapped
 *  (inbox `Notes`, archive `Old`, trash `Bin`), or with the inbox at the root. */
function fixture(rootMode = false) {
  const fs = new MemoryFs()
  const vault = new PortableVault('Fixture', fs)
  Object.assign(vault, {
    settingsCache: {
      ...structuredClone(DEFAULT_VAULT_SETTINGS),
      primaryNotesLocation: rootMode ? 'root' : 'inbox',
      systemFolderPaths: { inbox: 'Notes', archive: 'Old', trash: 'Bin', quick: 'Capture' }
    },
    listNotes: async () => [],
    invalidateMeta: () => {},
    metaForPath: async (path: string) => ({ path, title: path.split('/').pop() })
  })
  const primary = rootMode ? '' : 'Notes/'
  const note = `${primary}Work/One.md`
  fs.put(note, NOTE_BODY)
  fs.put(comments(note), COMMENTS_BODY)
  fs.put(created(note), CREATED_BODY)
  return { fs, vault, primary, note, original: snapshot(fs) }
}

/** The note and both sidecars sit at `to`, byte for byte, and nothing at `from`. */
function assertCarried(fs: MemoryFs, from: string, to: string): void {
  assert.equal(fs.text(to), NOTE_BODY)
  assert.equal(fs.text(comments(to)), COMMENTS_BODY)
  assert.equal(fs.text(created(to)), CREATED_BODY)
  for (const left of [from, comments(from), created(from)]) {
    assert.equal(fs.files.has(left), false, `${left} was left behind`)
  }
}

for (const rootMode of [false, true]) {
  test(`renaming a note carries its comments and creation date (root=${rootMode})`, async () => {
    const s = fixture(rootMode)
    const result = await s.vault.renameNote(s.note, 'Two')
    assert.equal(result.path, `${s.primary}Work/Two.md`)
    assertCarried(s.fs, s.note, result.path)
  })

  test(`archive, trash and restore carry the creation date through remapped folders (root=${rootMode})`, async () => {
    const s = fixture(rootMode)
    const archived = await s.vault.archiveNote(s.note)
    assert.equal(archived.path, 'Old/Work/One.md')
    assertCarried(s.fs, s.note, archived.path)
    const unarchived = await s.vault.unarchiveNote(archived.path)
    assert.equal(unarchived.path, s.note)
    const trashed = await s.vault.moveToTrash(s.note)
    assert.equal(trashed.path, 'Bin/Work/One.md')
    assertCarried(s.fs, s.note, trashed.path)
    const restored = await s.vault.restoreFromTrash(trashed.path)
    assert.equal(restored.path, s.note)
    assert.deepEqual(snapshot(s.fs), s.original)
  })
}

test('moving a note to another folder carries its creation date', async () => {
  const s = fixture()
  const result = await s.vault.moveNote(s.note, 'inbox', 'Elsewhere/Deeper')
  assert.equal(result.path, 'Notes/Elsewhere/Deeper/One.md')
  assertCarried(s.fs, s.note, result.path)
})

test('renaming a folder carries the creation dates of every note inside it', async () => {
  const s = fixture()
  s.fs.put('Notes/Work/Deep/Two.md', '# Two\n')
  s.fs.put(created('Notes/Work/Deep/Two.md'), '{"version":1,"createdAt":1}\n')
  await s.vault.renameFolder('inbox', 'Work', 'Moved')
  assertCarried(s.fs, s.note, 'Notes/Moved/One.md')
  assert.equal(s.fs.text(created('Notes/Moved/Deep/Two.md')), '{"version":1,"createdAt":1}\n')
  assert.equal([...s.fs.files.keys()].some(key => key.includes('/Work/')), false)
})

test('a moved note with no sidecars moves alone and gains none', async () => {
  const s = fixture()
  s.fs.files.delete(comments(s.note))
  s.fs.files.delete(created(s.note))
  await s.vault.renameNote(s.note, 'Two')
  assert.deepEqual([...s.fs.files.keys()], ['Notes/Work/Two.md'])
})

// ZenNotes #839: a creation date with no note beside it belongs to nobody
// (its note was moved or deleted outside ZenNotes). Desktop discards it, the
// way creating a note does, instead of handing it to the next note there.
test('a creation date left at the destination by a vanished note is discarded, not inherited', async () => {
  const s = fixture()
  s.fs.put(created('Notes/Work/Two.md'), '{"version":1,"createdAt":5}\n')
  await s.vault.renameNote(s.note, 'Two')
  assertCarried(s.fs, s.note, 'Notes/Work/Two.md')

  const bare = fixture()
  bare.fs.files.delete(created(bare.note))
  bare.fs.put(created('Notes/Elsewhere/One.md'), '{"version":1,"createdAt":5}\n')
  await bare.vault.moveNote(bare.note, 'inbox', 'Elsewhere')
  assert.equal(bare.fs.files.has(created('Notes/Elsewhere/One.md')), false)
  assert.equal(bare.fs.text(comments('Notes/Elsewhere/One.md')), COMMENTS_BODY)
})

// Taking over another note's discussion and deleting it are both wrong, so
// leftover comments refuse the move, in desktop's words, naming the file.
test('leftover comments at the destination refuse a rename or move and change nothing', async () => {
  const s = fixture()
  s.fs.put(comments('Notes/Work/Two.md'), 'an earlier discussion')
  s.fs.put(comments('Notes/Elsewhere/One.md'), 'another discussion')
  const before = snapshot(s.fs)
  await assert.rejects(s.vault.renameNote(s.note, 'Two'), {
    message: 'Comments from an earlier note named “Two” are still in .zennotes/comments/Notes/Work/Two.md.comments.json. Move or delete that file to use this name.'
  })
  await assert.rejects(s.vault.moveNote(s.note, 'inbox', 'Elsewhere'), {
    message: 'Comments from an earlier note named “One” are still in .zennotes/comments/Notes/Elsewhere/One.md.comments.json. Move or delete that file to use this name.'
  })
  assert.deepEqual(snapshot(s.fs), before)
})

test('a creation date that cannot move puts the note and its comments back', async () => {
  const s = fixture()
  s.fs.failMove = from => from.startsWith('.zennotes/note-metadata/')
  await assert.rejects(s.vault.renameNote(s.note, 'Two'), /Provider refused move/)
  assert.deepEqual(snapshot(s.fs), s.original)
  await assert.rejects(s.vault.renameFolder('inbox', 'Work', 'Moved'), /Provider refused move/)
  assert.deepEqual(snapshot(s.fs), s.original)
})

// Desktop's relocateFolderTrees refuses any existing destination tree.
test('renaming a folder onto a leftover creation-date tree refuses and changes nothing', async () => {
  const s = fixture()
  s.fs.put(created('Notes/Moved/Ghost.md'), '{"version":1,"createdAt":5}\n')
  const before = snapshot(s.fs)
  await assert.rejects(
    s.vault.renameFolder('inbox', 'Work', 'Moved'),
    /Destination already exists: \.zennotes\/note-metadata\/Notes\/Moved$/
  )
  assert.deepEqual(snapshot(s.fs), before)
})

// Deleting takes the creation date along, as on desktop. Otherwise the phone
// would plant the leftover trees that refuse a later folder rename.
test('deleting a note, a folder or the trash leaves no creation date behind', async () => {
  const note = fixture()
  await note.vault.deleteNote(note.note)
  assert.equal(note.fs.files.size, 0)

  const folder = fixture()
  await folder.vault.deleteFolder('inbox', 'Work')
  assert.equal(folder.fs.files.size, 0)

  const trash = fixture()
  await trash.vault.moveToTrash(trash.note)
  await trash.vault.emptyTrash()
  assert.equal(trash.fs.files.size, 0)
})

test('a folder deleted on the phone does not block renaming another folder onto its name', async () => {
  const s = fixture()
  s.fs.put('Notes/Gone/Old.md', '# Old\n')
  s.fs.put(created('Notes/Gone/Old.md'), '{"version":1,"createdAt":5}\n')
  await s.vault.deleteFolder('inbox', 'Gone')
  await s.vault.renameFolder('inbox', 'Work', 'Gone')
  assertCarried(s.fs, s.note, 'Notes/Gone/One.md')
  assert.equal(s.fs.files.has(created('Notes/Gone/Old.md')), false)
})
