/**
 * A case-only rename (`case-test` to `Case-Test`) on a store that folds case,
 * as Safari's OPFS on a Mac and a Mac's own disk do: the target "exists"
 * because it is the note itself. Desktop compares file identity
 * (apps/desktop/src/main/vault.ts renameNote); the package reads the folder.
 * A case-sensitive store, which the phones' devices are, behaves as before.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { DEFAULT_VAULT_SETTINGS } from '@zennotes/bridge-contract/ipc'
import { MemoryVaultFileSystem } from './memory-fs'
import { PortableVault } from './vault-fs'

const comments = (rel: string): string => `.zennotes/comments/${rel}.comments.json`

function fixture(foldNames: boolean) {
  const fs = new MemoryVaultFileSystem()
  fs.foldNames = foldNames
  const vault = new PortableVault('Fixture', fs)
  Object.assign(vault, {
    settingsCache: structuredClone(DEFAULT_VAULT_SETTINGS),
    listNotes: async () => [],
    invalidateMeta: () => {},
    metaForPath: async (path: string) => ({ path, title: path.split('/').pop() })
  })
  return { fs, vault }
}

test('a case-only rename works on a store that folds case, and carries its comments', async () => {
  const { fs, vault } = fixture(true)
  fs.put('inbox/case-test.md', '# body\n')
  fs.put(comments('inbox/case-test.md'), '{"version":1,"comments":[]}')
  const result = await vault.renameNote('inbox/case-test.md', 'Case-Test')
  assert.equal(result.path, 'inbox/Case-Test.md')
  assert.deepEqual([...fs.files.keys()].sort(), [comments('inbox/Case-Test.md'), 'inbox/Case-Test.md'])
  assert.equal(fs.text('inbox/Case-Test.md'), '# body\n')
})

test('so does one that only changes Unicode normalization', async () => {
  const { fs, vault } = fixture(true)
  const decomposed = 'Café'
  fs.put(`inbox/${decomposed}.md`, 'x\n')
  const result = await vault.renameNote(`inbox/${decomposed}.md`, 'CAFÉ')
  assert.equal(result.path, 'inbox/CAFÉ.md')
  assert.equal(fs.files.size, 1)
})

test('another note that folds to the new name still refuses it', async () => {
  const { fs, vault } = fixture(true)
  fs.put('inbox/note.md', 'one\n')
  fs.put('inbox/Other.md', 'two\n')
  await assert.rejects(vault.renameNote('inbox/note.md', 'other'), /already exists/)
  assert.equal(fs.text('inbox/note.md'), 'one\n')
  assert.equal(fs.text('inbox/Other.md'), 'two\n')
})

test('on a case-sensitive store a note with the exact new name still refuses it', async () => {
  const { fs, vault } = fixture(false)
  fs.put('inbox/a.md', 'lower\n')
  fs.put('inbox/A.md', 'upper\n')
  await assert.rejects(vault.renameNote('inbox/a.md', 'A'), /already exists/)
  assert.equal(fs.text('inbox/a.md'), 'lower\n')
})

test('on a case-sensitive store a case-only rename works as before', async () => {
  const { fs, vault } = fixture(false)
  fs.put('inbox/case-test.md', 'x\n')
  const result = await vault.renameNote('inbox/case-test.md', 'Case-Test')
  assert.equal(result.path, 'inbox/Case-Test.md')
  assert.deepEqual([...fs.files.keys()], ['inbox/Case-Test.md'])
})
