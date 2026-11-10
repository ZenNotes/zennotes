import assert from 'node:assert/strict'
import { test } from 'vitest'
import { DEFAULT_VAULT_SETTINGS } from '@zennotes/bridge-contract/ipc'
import { MemoryVaultFileSystem } from './memory-fs'
import { PortableVault } from './vault-fs'

/** The in-memory disk, with a move the provider can refuse. Like the
 *  providers, a move never lands on something that is already there. */
class LifecycleFs extends MemoryVaultFileSystem {
  failMove: ((from: string, to: string) => boolean) | null = null
  override async rename(from: string, to: string): Promise<void> {
    if (this.failMove?.(from, to)) throw new Error('Provider refused move')
    assert.ok(await this.exists(from)); assert.equal(await this.exists(to), false)
    await super.rename(from, to)
  }
}
/** Every file's text by path, the shape the phone's fake kept its files in. */
const snapshot = (fs: MemoryVaultFileSystem) => new Map([...fs.files.keys()].map((key) => [key, fs.text(key)!]))
function fixture(rootMode = false) {
  const fs = new LifecycleFs(), vault = new PortableVault('Fixture', fs)
  Object.assign(vault, {
    settingsCache: { ...structuredClone(DEFAULT_VAULT_SETTINGS), primaryNotesLocation: rootMode ? 'root' : 'inbox',
      systemFolderPaths: { inbox: 'Notes', archive: 'Old', trash: 'Bin', quick: 'Capture' } },
    listNotes: async () => [], invalidateMeta: () => {},
    metaForPath: async (path: string) => ({ path, title: path.split('/').pop() })
  })
  const note = `${rootMode ? '' : 'Notes/'}Work/One.md`
  fs.put(note, '# One\n\nExact café 日本語.  \n')
  fs.put(`.zennotes/comments/${note}.comments.json`, '{malformed but preserved sidecar}')
  return { fs, vault, note, original: snapshot(fs) }
}
for (const rootMode of [false, true]) {
  test(`native move and restore preserve bytes and sidecars with remapping (root=${rootMode})`, async () => {
    const s = fixture(rootMode), result = await s.vault.moveToTrash(s.note)
    assert.equal(result.path, 'Bin/Work/One.md')
    assert.equal(s.fs.text(result.path), s.original.get(s.note))
    assert.equal(s.fs.text(`.zennotes/comments/${result.path}.comments.json`), '{malformed but preserved sidecar}')
    const restored = await s.vault.restoreFromTrash(result.path)
    assert.equal(restored.path, s.note)
    assert.deepEqual(snapshot(s.fs), s.original)
  })
}
test('native note relocation restores content when the comments provider fails', async () => {
  const s = fixture()
  s.fs.failMove = from => from.startsWith('.zennotes/comments/')
  await assert.rejects(s.vault.moveToTrash(s.note), /Provider refused move/)
  assert.deepEqual(snapshot(s.fs), s.original)
})
test('native folder rename moves database files and nested sidecars together', async () => {
  const s = fixture()
  s.fs.put('Notes/Work/Projects.base/data.csv', 'ID,Name\n1,One\n')
  s.fs.put('Notes/Work/Projects.base/schema.json', '{"pages":{"1":"One.md"}}')
  await s.vault.renameFolder('inbox', 'Work', 'Moved')
  assert.equal(s.fs.text('Notes/Moved/Projects.base/data.csv'), 'ID,Name\n1,One\n')
  assert.equal(s.fs.text('.zennotes/comments/Notes/Moved/One.md.comments.json'), '{malformed but preserved sidecar}')
  assert.equal(s.fs.files.has(s.note), false)
})
test('native folder rename restores content, comments and settings on metadata failure', async () => {
  const s = fixture()
  s.fs.put('.zennotes/vault.json', '{"keep":"exact settings"}\n')
  s.original.set('.zennotes/vault.json', '{"keep":"exact settings"}\n')
  s.fs.failNext('writeText', new Error('Settings write refused'))
  await assert.rejects(s.vault.renameFolder('inbox', 'Work', 'Moved'), /Settings write refused/)
  assert.deepEqual(snapshot(s.fs), s.original)
})
test('native Empty Trash rolls back if comments cannot detach, then deletes nested comments on retry', async () => {
  const s = fixture()
  await s.vault.moveToTrash(s.note)
  const before = snapshot(s.fs)
  s.fs.failMove = from => from === '.zennotes/comments/Bin'
  await assert.rejects(s.vault.emptyTrash(), /Provider refused move/)
  assert.deepEqual(snapshot(s.fs), before)
  s.fs.failMove = null
  await s.vault.emptyTrash()
  assert.equal(s.fs.files.size, 0)
  await s.vault.emptyTrash()
})
test('native deletion does not report success after a failed sidecar move', async () => {
  const s = fixture()
  s.fs.failMove = from => from.startsWith('.zennotes/comments/')
  await assert.rejects(s.vault.deleteNote(s.note), /Provider refused move/)
  assert.deepEqual(snapshot(s.fs), s.original)
})
// The phones' NativeFs stays with their shells. The contract it kept here is
// the host's (host.ts: readTextOrNull answers null only for a verified
// absence), and MemoryVaultFileSystem keeps it for the package.
test('native absent-file reads propagate provider failures instead of allowing schema adoption', async () => {
  const permission = new Error('Permission denied')
  const fs = new MemoryVaultFileSystem()
  fs.failNext('readText', permission)
  await assert.rejects(fs.readTextOrNull('schema.json'), permission)
})
// ZenNotes #692: the desktop writes the vault's display name into vault.json.
// The phone's settings pass every key through, so a save from this device
// (toggling a favorite is enough) must keep the name, and a read must hand
// it to the core, which names the vault by it.
test('a vault display name written by desktop survives a phone settings save (ZenNotes #692)', async () => {
  const { fs, vault } = fixture()
  fs.put('.zennotes/vault.json', JSON.stringify({
    ...structuredClone(DEFAULT_VAULT_SETTINGS), displayName: 'Acme API docs'
  }))
  Object.assign(vault, { settingsCache: null })
  const settings = await vault.getVaultSettings()
  assert.equal(settings.displayName, 'Acme API docs')
  await vault.setVaultSettings({ ...settings, favorites: ['Notes/Work/One.md'] })
  const written = JSON.parse(fs.text('.zennotes/vault.json')!)
  assert.equal(written.displayName, 'Acme API docs')
  assert.deepEqual(written.favorites, ['Notes/Work/One.md'])
})

// Assistant edit records (.zennotes/agent-edits/<note>.json), kept until the
// desktop app reviews them, travel with their note and go when it goes.
const editRecord = (path: string) => `.zennotes/agent-edits/${path}.json`
const editRecords = (fs: MemoryVaultFileSystem) => [...fs.files.keys()].filter(key => key.startsWith('.zennotes/agent-edits/')).sort()

test('an assistant edit record follows its note through rename, move and Trash, and goes with Empty Trash', async () => {
  const s = fixture()
  s.fs.put(editRecord(s.note), '{"record":"One"}')
  // An orphaned record at the destination is nobody's review: the note's own replaces it.
  s.fs.put(editRecord('Notes/Work/Two.md'), '{"record":"orphan"}')
  const renamed = await s.vault.renameNote(s.note, 'Two')
  assert.equal(renamed.path, 'Notes/Work/Two.md')
  assert.deepEqual(editRecords(s.fs), [editRecord('Notes/Work/Two.md')])
  assert.equal(s.fs.text(editRecord('Notes/Work/Two.md')), '{"record":"One"}')
  const moved = await s.vault.moveNote(renamed.path, 'inbox', '')
  assert.deepEqual(editRecords(s.fs), [editRecord(moved.path)])
  const trashed = await s.vault.moveToTrash(moved.path)
  assert.deepEqual(editRecords(s.fs), [editRecord(trashed.path)])
  const restored = await s.vault.restoreFromTrash(trashed.path)
  assert.deepEqual(editRecords(s.fs), [editRecord(restored.path)])
  await s.vault.moveToTrash(restored.path)
  await s.vault.emptyTrash()
  assert.deepEqual(editRecords(s.fs), [])
})

test('folder rename carries nested edit records; deleting the note or the folder removes them', async () => {
  const s = fixture()
  s.fs.put(editRecord(s.note), '{"record":"One"}')
  await s.vault.renameFolder('inbox', 'Work', 'Moved')
  assert.deepEqual(editRecords(s.fs), [editRecord('Notes/Moved/One.md')])
  await s.vault.deleteNote('Notes/Moved/One.md')
  assert.deepEqual(editRecords(s.fs), [])
  s.fs.put('Notes/Moved/Three.md', '# Three\n')
  s.fs.put(editRecord('Notes/Moved/Three.md'), '{"record":"Three"}')
  await s.vault.deleteFolder('inbox', 'Moved')
  assert.deepEqual(editRecords(s.fs), [])
})

test('a new note does not inherit an orphaned edit record at its path', async () => {
  const s = fixture()
  s.fs.put(editRecord('Notes/Untitled.md'), '{"record":"orphan"}')
  s.fs.put(editRecord('Notes/Work/One copy.md'), '{"record":"orphan copy"}')
  const created = await s.vault.createNote('inbox')
  assert.equal(created.path, 'Notes/Untitled.md')
  const copy = await s.vault.duplicateNote(s.note)
  assert.equal(copy.path, 'Notes/Work/One copy.md')
  assert.deepEqual(editRecords(s.fs), [])
})
