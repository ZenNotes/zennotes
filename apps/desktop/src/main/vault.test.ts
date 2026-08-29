import { promises as fsPromises } from 'node:fs'
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VaultSettings } from '@shared/ipc'
import {
  absolutePath,
  appendToNote,
  archiveNote,
  deleteAsset,
  duplicateAsset,
  emptyDeletedAssets,
  ensureVaultLayout,
  folderForRelativePath,
  forgetLocalVault,
  getVaultSettings,
  importFiles,
  importPastedImage,
  invalidateNoteMetaCache,
  invalidateVaultSettingsCache,
  listDeletedAssets,
  listAssets,
  listNotes,
  listFolders,
  migrateLooseAssets,
  moveAsset,
  moveToTrash,
  rememberLocalVault,
  purgeDeletedAsset,
  renameAsset,
  renameFolder,
  restoreDeletedAsset,
  restoreFromTrash,
  rootContentHiddenByInboxMode,
  searchVaultText,
  searchVaultTextCapabilities,
  setVaultSettings,
  unarchiveNote,
  vaultChangeAffectsSettings,
  isAtomicWriteTempPath,
  renameWithRetry,
  writeNote
} from './vault'

const tempDirs: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('rootContentHiddenByInboxMode (#195)', () => {
  it('flags an Obsidian-style vault (root notes + custom folders) stuck in inbox mode', async () => {
    const root = await makeTempDir('zennotes-vault-hidden-')
    await mkdir(root, { recursive: true })
    await writeFile(path.join(root, 'index.md'), '# Index\n')
    await mkdir(path.join(root, 'concepts'), { recursive: true })
    const base = await getVaultSettings(root)
    await setVaultSettings(root, { ...base, primaryNotesLocation: 'inbox' })
    expect(await rootContentHiddenByInboxMode(root)).toBe(true)
  })

  it('is false once the vault is switched to root mode', async () => {
    const root = await makeTempDir('zennotes-vault-rootmode-')
    await mkdir(root, { recursive: true })
    await writeFile(path.join(root, 'index.md'), '# Index\n')
    const base = await getVaultSettings(root)
    await setVaultSettings(root, { ...base, primaryNotesLocation: 'root' })
    expect(await rootContentHiddenByInboxMode(root)).toBe(false)
  })

  it('is false for an inbox-mode vault with no root content to hide', async () => {
    const root = await makeTempDir('zennotes-vault-emptyroot-')
    await mkdir(path.join(root, 'inbox'), { recursive: true })
    const base = await getVaultSettings(root)
    await setVaultSettings(root, { ...base, primaryNotesLocation: 'inbox' })
    expect(await rootContentHiddenByInboxMode(root)).toBe(false)
  })
})

describe('daily-notes task settings round-trip (#288)', () => {
  it('persists tasksDueOnNoteDate + rolloverUnfinishedTasks through set/get', async () => {
    const root = await makeTempDir('zennotes-vault-dailytasks-')
    await mkdir(root, { recursive: true })
    const base = await getVaultSettings(root)
    // Flip both away from their defaults (true / false). Before the fix the
    // main process dropped these fields on save, so they snapped back.
    await setVaultSettings(root, {
      ...base,
      dailyNotes: { ...base.dailyNotes, tasksDueOnNoteDate: false, rolloverUnfinishedTasks: true }
    })
    const saved = await getVaultSettings(root)
    expect(saved.dailyNotes.tasksDueOnNoteDate).toBe(false)
    expect(saved.dailyNotes.rolloverUnfinishedTasks).toBe(true)
  })

  it('defaults tasksDueOnNoteDate=true, rolloverUnfinishedTasks=false when unset', async () => {
    const root = await makeTempDir('zennotes-vault-dailydefaults-')
    await mkdir(root, { recursive: true })
    const settings = await getVaultSettings(root)
    expect(settings.dailyNotes.tasksDueOnNoteDate).toBe(true)
    expect(settings.dailyNotes.rolloverUnfinishedTasks).toBe(false)
  })
})

describe('file-location settings round-trip (#446)', () => {
  it('persists tasksLocation through set/get (drawings/databases already worked)', async () => {
    const root = await makeTempDir('zennotes-vault-tasksloc-')
    await mkdir(root, { recursive: true })
    const base = await getVaultSettings(root)
    // Before the fix the main process sanitizer dropped tasksLocation on save
    // (drawings and databases were kept), so the Tasks-location control snapped
    // back and every new task landed in the inbox regardless of the choice.
    await setVaultSettings(root, {
      ...base,
      tasksLocation: { mode: 'folder', folder: 'Tasks' },
      drawingsLocation: { mode: 'active-note' }
    })
    const saved = await getVaultSettings(root)
    expect(saved.tasksLocation).toEqual({ mode: 'folder', folder: 'Tasks' })
    expect(saved.drawingsLocation).toEqual({ mode: 'active-note' })
  })

  it('defaults tasksLocation to primary when unset', async () => {
    const root = await makeTempDir('zennotes-vault-tasksloc-default-')
    await mkdir(root, { recursive: true })
    const settings = await getVaultSettings(root)
    expect(settings.tasksLocation).toEqual({ mode: 'primary' })
  })
})

describe('remapped system folders (#398)', () => {
  it('creates the REMAPPED inbox on save, not a literal inbox/', async () => {
    const root = await makeTempDir('zennotes-vault-remap-mkdir-')
    await mkdir(root, { recursive: true })
    const base = await getVaultSettings(root)
    await setVaultSettings(root, {
      ...base,
      primaryNotesLocation: 'inbox',
      systemFolderPaths: { inbox: '01 - Entry' }
    })
    expect((await stat(path.join(root, '01 - Entry'))).isDirectory()).toBe(true)
    // The stray literal directory was the whole bug: it existed, classified as
    // the system inbox, and every listing walked the remapped one instead.
    await expect(stat(path.join(root, 'inbox'))).rejects.toThrow()
  })

  it('seeds the welcome note into the remapped inbox', async () => {
    const root = await makeTempDir('zennotes-vault-remap-welcome-')
    await mkdir(path.join(root, '.zennotes'), { recursive: true })
    await writeFile(
      path.join(root, '.zennotes', 'vault.json'),
      JSON.stringify({ primaryNotesLocation: 'inbox', systemFolderPaths: { inbox: '01 - Entry' } })
    )
    await ensureVaultLayout(root)
    expect((await stat(path.join(root, '01 - Entry', 'Welcome.md'))).isFile()).toBe(true)
  })

  it('classifies the remapped directory, and a leftover literal one as a user folder', async () => {
    const settings = {
      primaryNotesLocation: 'inbox',
      systemFolderPaths: { archive: '99 - Archive' }
    } as VaultSettings
    expect(folderForRelativePath('99 - Archive/Old.md', settings)).toBe('archive')
    // `archive/` is not the archive any more; it is an ordinary folder.
    expect(folderForRelativePath('archive/Kept.md', settings)).toBe('inbox')
    expect(folderForRelativePath('quick/Note.md', settings)).toBe('quick')
    expect(folderForRelativePath('assets/pic.png', settings)).toBeNull()
  })

  it('classifies a swap by the resolved names, not the default ones', async () => {
    // normalizeSystemFolderPaths rejects this now, but classification must not
    // depend on that: whatever a folder resolves to is what it is.
    const swapped = {
      primaryNotesLocation: 'inbox',
      systemFolderPaths: { inbox: 'archive', archive: 'inbox' }
    } as VaultSettings
    expect(folderForRelativePath('archive/A.md', swapped)).toBe('inbox')
    expect(folderForRelativePath('inbox/B.md', swapped)).toBe('archive')
  })
})

// getVaultSettings is awaited by folderOf() on every note read and write, and
// its fallback is a whole-root readdir. A vault.json that states its
// primaryNotesLocation answers the question by itself, so a cache hit (and
// even a cold read of such a file) must not list the root at all.
describe('vault settings readdir cost', () => {
  it('performs no readdir on a cache hit', async () => {
    const root = await makeTempDir('zennotes-vault-settings-readdir-')
    await mkdir(root, { recursive: true })
    const base = await getVaultSettings(root)
    await setVaultSettings(root, { ...base, primaryNotesLocation: 'inbox' })
    await getVaultSettings(root) // prime the cache

    const spy = vi.spyOn(fsPromises, 'readdir')
    try {
      await getVaultSettings(root)
      await getVaultSettings(root)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('performs no readdir on a cold read of a vault.json that states its mode', async () => {
    const root = await makeTempDir('zennotes-vault-settings-cold-')
    await mkdir(path.join(root, '.zennotes'), { recursive: true })
    await writeFile(
      path.join(root, '.zennotes', 'vault.json'),
      JSON.stringify({ primaryNotesLocation: 'root' })
    )
    invalidateVaultSettingsCache(root)

    const spy = vi.spyOn(fsPromises, 'readdir')
    try {
      expect((await getVaultSettings(root)).primaryNotesLocation).toBe('root')
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('still infers when vault.json leaves the mode unstated', async () => {
    const root = await makeTempDir('zennotes-vault-settings-infer-')
    await mkdir(path.join(root, '.zennotes'), { recursive: true })
    await mkdir(path.join(root, 'concepts'), { recursive: true })
    await writeFile(path.join(root, '.zennotes', 'vault.json'), JSON.stringify({}))
    invalidateVaultSettingsCache(root)
    expect((await getVaultSettings(root)).primaryNotesLocation).toBe('root')
  })
})

describe('vaultChangeAffectsSettings', () => {
  it('is true for vault.json and for root-level entries the inference reads', () => {
    expect(
      vaultChangeAffectsSettings({
        kind: 'change',
        path: '.zennotes/vault.json',
        folder: 'inbox',
        scope: 'vault-settings'
      })
    ).toBe(true)
    expect(vaultChangeAffectsSettings({ kind: 'add', path: 'Notes.md', folder: 'inbox' })).toBe(
      true
    )
    expect(
      vaultChangeAffectsSettings({ kind: 'add', path: 'concepts', folder: 'inbox', scope: 'folder' })
    ).toBe(true)
  })

  it('is false for the nested writes a save burst is made of', () => {
    expect(
      vaultChangeAffectsSettings({ kind: 'change', path: 'inbox/Deep/Note.md', folder: 'inbox' })
    ).toBe(false)
    expect(
      vaultChangeAffectsSettings({
        kind: 'change',
        path: 'inbox/Books.base/data.csv',
        folder: 'inbox',
        scope: 'database'
      })
    ).toBe(false)
    expect(
      vaultChangeAffectsSettings({
        kind: 'change',
        path: 'inbox/Note.md',
        folder: 'inbox',
        scope: 'comments'
      })
    ).toBe(false)
  })
})

describe('absolutePath', () => {
  it('rejects sibling-prefix escapes outside the vault root', async () => {
    const parent = await makeTempDir('zennotes-vault-parent-')
    const root = path.join(parent, 'vault')
    const sibling = path.join(parent, 'vault-evil')
    await mkdir(root, { recursive: true })
    await mkdir(sibling, { recursive: true })

    expect(() => absolutePath(root, '../vault-evil/secret.md')).toThrow(/Path escapes vault/)
  })

  it('allows paths that stay inside the vault root', async () => {
    const parent = await makeTempDir('zennotes-vault-allowed-')
    const root = path.join(parent, 'vault')
    await mkdir(path.join(root, 'inbox'), { recursive: true })

    expect(absolutePath(root, 'inbox/note.md')).toBe(path.join(root, 'inbox', 'note.md'))
  })
})

describe('rememberLocalVault', () => {
  it('moves an opened vault to the top and deduplicates by root', () => {
    const firstRoot = path.resolve('/tmp/zennotes-first')
    const secondRoot = path.resolve('/tmp/zennotes-second')

    const remembered = rememberLocalVault(
      [
        { root: firstRoot, name: 'First', lastOpenedAt: 10 },
        { root: secondRoot, name: 'Second', lastOpenedAt: 20 }
      ],
      { root: firstRoot, name: 'First renamed' },
      30
    )

    expect(remembered).toEqual([
      { root: firstRoot, name: 'First renamed', lastOpenedAt: 30 },
      { root: secondRoot, name: 'Second', lastOpenedAt: 20 }
    ])
  })

  it('forgets a closed vault by normalized root', () => {
    const firstRoot = path.resolve('/tmp/zennotes-first')
    const secondRoot = path.resolve('/tmp/zennotes-second')

    expect(
      forgetLocalVault(
        [
          { root: firstRoot, name: 'First', lastOpenedAt: 10 },
          { root: secondRoot, name: 'Second', lastOpenedAt: 20 }
        ],
        path.join(firstRoot, '.')
      )
    ).toEqual([{ root: secondRoot, name: 'Second', lastOpenedAt: 20 }])
  })
})

describe('appendToNote', () => {
  it('appends to the end with a separating blank line when target lacks trailing newline', async () => {
    const root = await makeTempDir('zennotes-append-end-')
    await ensureVaultLayout(root)
    const rel = 'inbox/quick.md'
    await writeFile(path.join(root, rel), '# Quick\n\nfirst line', 'utf8')

    await appendToNote(root, rel, 'second thought', 'end')

    const next = await readFile(path.join(root, rel), 'utf8')
    expect(next).toBe('# Quick\n\nfirst line\n\nsecond thought\n')
  })

  it('prepends to the start with a separating blank line', async () => {
    const root = await makeTempDir('zennotes-append-start-')
    await ensureVaultLayout(root)
    const rel = 'inbox/quick.md'
    await writeFile(path.join(root, rel), '# Quick\n\noriginal\n', 'utf8')

    await appendToNote(root, rel, 'breaking news', 'start')

    const next = await readFile(path.join(root, rel), 'utf8')
    expect(next).toBe('breaking news\n\n# Quick\n\noriginal\n')
  })

  it('is a no-op when the addition is whitespace-only', async () => {
    const root = await makeTempDir('zennotes-append-empty-')
    await ensureVaultLayout(root)
    const rel = 'inbox/quick.md'
    const original = '# Quick\n\nbody\n'
    await writeFile(path.join(root, rel), original, 'utf8')

    await appendToNote(root, rel, '   \n  ', 'end')

    const next = await readFile(path.join(root, rel), 'utf8')
    expect(next).toBe(original)
  })
})

describe('importPastedImage', () => {
  it('writes clipboard image bytes into assets/ and returns a wiki embed', async () => {
    const root = await makeTempDir('zennotes-paste-image-')
    await ensureVaultLayout(root)

    const imported = await importPastedImage(
      root,
      {
        data: Uint8Array.from([137, 80, 78, 71]).buffer,
        mimeType: 'image/png',
        suggestedName: 'Screenshot 2026-05-13.png'
      },
      new Date(2026, 4, 13, 15, 4, 5)
    )

    expect(imported).toEqual({
      name: 'Screenshot 2026-05-13.png',
      path: 'assets/Screenshot 2026-05-13.png',
      markdown: '![[assets/Screenshot 2026-05-13.png]]',
      kind: 'image'
    })
    await expect(readFile(path.join(root, 'assets/Screenshot 2026-05-13.png'))).resolves.toEqual(
      Buffer.from([137, 80, 78, 71])
    )
  })

  it('generates a unique filename in assets/ when the clipboard has no useful name', async () => {
    const root = await makeTempDir('zennotes-paste-image-name-')
    await ensureVaultLayout(root)
    await mkdir(path.join(root, 'assets'), { recursive: true })
    await writeFile(path.join(root, 'assets/Pasted Image 2026-05-13 150405.webp'), 'existing', 'utf8')

    const imported = await importPastedImage(
      root,
      {
        data: Uint8Array.from([1, 2, 3]).buffer,
        mimeType: 'image/webp'
      },
      new Date(2026, 4, 13, 15, 4, 5)
    )

    expect(imported.name).toBe('Pasted Image 2026-05-13 150405 2.webp')
    expect(imported.path).toBe('assets/Pasted Image 2026-05-13 150405 2.webp')
    expect(imported.markdown).toBe('![[assets/Pasted Image 2026-05-13 150405 2.webp]]')
    await expect(readFile(path.join(root, imported.path))).resolves.toEqual(Buffer.from([1, 2, 3]))
  })
})

describe('importFiles', () => {
  it('copies dropped files into assets/ (not the vault root) for a root-mode note', async () => {
    const root = await makeTempDir('zennotes-import-files-')
    await ensureVaultLayout(root)
    // Source file living outside the vault, as an OS drag would provide.
    const srcDir = await makeTempDir('zennotes-import-src-')
    const src = path.join(srcDir, 'Diagram.png')
    await writeFile(src, Buffer.from([137, 80, 78, 71]))

    const imported = await importFiles(root, 'Note.md', [src])

    expect(imported).toHaveLength(1)
    expect(imported[0]?.path).toBe('assets/Diagram.png')
    expect(imported[0]?.kind).toBe('image')
    expect(imported[0]?.markdown).toContain('assets/Diagram.png')
    await expect(readFile(path.join(root, 'assets/Diagram.png'))).resolves.toEqual(
      Buffer.from([137, 80, 78, 71])
    )
    // Must NOT be dumped in the vault root (the #377 regression).
    await expect(readFile(path.join(root, 'Diagram.png'))).rejects.toThrow()
  })

  it('stores in assets/ for an inbox-mode note too, linked by vault-relative wikilink', async () => {
    const root = await makeTempDir('zennotes-import-files-inbox-')
    await ensureVaultLayout(root)
    const srcDir = await makeTempDir('zennotes-import-src-inbox-')
    const src = path.join(srcDir, 'Photo.png')
    await writeFile(src, Buffer.from([1, 2, 3]))

    const imported = await importFiles(root, 'inbox/Note.md', [src])

    expect(imported[0]?.path).toBe('assets/Photo.png')
    // A dropped image embeds by vault-relative wikilink, the same form paste
    // and the mobile apps write, so the link survives the note being moved.
    expect(imported[0]?.markdown).toBe('![[assets/Photo.png]]')
    await expect(readFile(path.join(root, 'assets/Photo.png'))).resolves.toEqual(
      Buffer.from([1, 2, 3])
    )
  })

  it('uniquifies names against existing files already in assets/', async () => {
    const root = await makeTempDir('zennotes-import-files-unique-')
    await ensureVaultLayout(root)
    await mkdir(path.join(root, 'assets'), { recursive: true })
    await writeFile(path.join(root, 'assets/Photo.png'), 'existing', 'utf8')
    const srcDir = await makeTempDir('zennotes-import-src-unique-')
    const src = path.join(srcDir, 'Photo.png')
    await writeFile(src, Buffer.from([9, 9, 9]))

    const imported = await importFiles(root, 'Note.md', [src])

    expect(imported[0]?.path).toBe('assets/Photo 2.png')
    await expect(readFile(path.join(root, 'assets/Photo.png'), 'utf8')).resolves.toBe('existing')
  })
})

describe('atomic save scratch files', () => {
  it('never presents an in-flight note save as an asset', async () => {
    const root = await makeTempDir('zennotes-atomic-assets-')
    await ensureVaultLayout(root)
    const scratchName = 'Daily.md.3252272.1787800172047252.tmp'
    await writeFile(path.join(root, 'inbox', scratchName), 'in-flight save', 'utf8')
    await writeFile(path.join(root, 'inbox', 'report.2024.01.tmp'), 'user file', 'utf8')

    const assets = await listAssets(root)

    expect(assets.map((asset) => asset.name)).not.toContain(scratchName)
    expect(assets.map((asset) => asset.name)).toContain('report.2024.01.tmp')
  })

  it('does not migrate an in-flight root note save into assets', async () => {
    const root = await makeTempDir('zennotes-atomic-migration-')
    const scratchName = 'Daily.md.3252272.1787800172047252.tmp'
    await writeFile(path.join(root, 'Existing.md'), '# Existing\n', 'utf8')
    await writeFile(path.join(root, scratchName), 'in-flight save', 'utf8')
    await writeFile(path.join(root, 'diagram.png'), 'real asset', 'utf8')

    const result = await migrateLooseAssets(root)

    expect(result.moved).toEqual(['assets/diagram.png'])
    await expect(readFile(path.join(root, scratchName), 'utf8')).resolves.toBe('in-flight save')
    await expect(readFile(path.join(root, 'assets', scratchName), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
})

describe('deleteAsset', () => {
  it('renames, moves, and duplicates non-markdown assets', async () => {
    const root = await makeTempDir('zennotes-asset-actions-')
    await ensureVaultLayout(root)
    await writeFile(path.join(root, 'Image.png'), 'image-bytes', 'utf8')

    const renamed = await renameAsset(root, 'Image.png', 'Renamed.png')
    expect(renamed.path).toBe('Renamed.png')
    await expect(readFile(path.join(root, 'Renamed.png'), 'utf8')).resolves.toBe('image-bytes')

    const moved = await moveAsset(root, renamed.path, 'media/screenshots')
    expect(moved.path).toBe('media/screenshots/Renamed.png')
    await expect(readFile(path.join(root, moved.path), 'utf8')).resolves.toBe('image-bytes')

    const duplicated = await duplicateAsset(root, moved.path)
    expect(duplicated.path).toBe('media/screenshots/Renamed copy.png')
    await expect(readFile(path.join(root, duplicated.path), 'utf8')).resolves.toBe('image-bytes')
  })

  it('removes a non-markdown asset inside the vault and can restore it', async () => {
    const root = await makeTempDir('zennotes-delete-asset-')
    await ensureVaultLayout(root)
    const rel = 'Screenshot.png'
    await writeFile(path.join(root, rel), 'image-bytes', 'utf8')

    const deleted = await deleteAsset(root, rel)

    expect(deleted).toMatchObject({ path: rel, name: 'Screenshot.png' })
    await expect(readFile(path.join(root, rel), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })

    const restored = await restoreDeletedAsset(root, deleted)

    expect(restored.path).toBe(rel)
    await expect(readFile(path.join(root, rel), 'utf8')).resolves.toBe('image-bytes')
  })

  it('lists deleted assets so they are restorable without the in-session undo (#330)', async () => {
    const root = await makeTempDir('zennotes-list-deleted-assets-')
    await ensureVaultLayout(root)
    await writeFile(path.join(root, 'One.png'), 'one-bytes', 'utf8')
    await writeFile(path.join(root, 'Two.pdf'), 'two-bytes', 'utf8')

    await deleteAsset(root, 'One.png')
    await deleteAsset(root, 'Two.pdf')

    const listed = await listDeletedAssets(root)
    expect(listed).toHaveLength(2)
    expect(listed.map((d) => d.name).sort()).toEqual(['One.png', 'Two.pdf'])
    for (const d of listed) {
      expect(typeof d.undoToken).toBe('string')
      expect(typeof d.deletedAt).toBe('string')
    }

    // Restore straight from the listed record — no in-memory undo entry needed.
    const entry = listed.find((d) => d.name === 'One.png')
    expect(entry).toBeTruthy()
    const restored = await restoreDeletedAsset(root, entry!)
    expect(restored.path).toBe('One.png')
    await expect(readFile(path.join(root, 'One.png'), 'utf8')).resolves.toBe('one-bytes')
    expect(await listDeletedAssets(root)).toHaveLength(1)
  })

  it('purges a single deleted asset and empties them all (#330)', async () => {
    const root = await makeTempDir('zennotes-purge-deleted-assets-')
    await ensureVaultLayout(root)
    await writeFile(path.join(root, 'A.png'), 'a', 'utf8')
    await writeFile(path.join(root, 'B.png'), 'b', 'utf8')
    const a = await deleteAsset(root, 'A.png')
    await deleteAsset(root, 'B.png')

    await purgeDeletedAsset(root, a.undoToken)
    expect((await listDeletedAssets(root)).map((d) => d.name)).toEqual(['B.png'])

    await emptyDeletedAssets(root)
    expect(await listDeletedAssets(root)).toHaveLength(0)
  })

  it('does not delete markdown notes through the asset path', async () => {
    const root = await makeTempDir('zennotes-delete-note-as-asset-')
    await ensureVaultLayout(root)
    const rel = 'inbox/Keep.md'
    await writeFile(path.join(root, rel), '# Keep\n', 'utf8')

    await expect(deleteAsset(root, rel)).rejects.toThrow(/note actions/i)
    await expect(readFile(path.join(root, rel), 'utf8')).resolves.toBe('# Keep\n')
  })
})

describe('renameFolder', () => {
  it('can promote a nested inbox folder to the vault root in root mode', async () => {
    const root = await makeTempDir('zennotes-rename-root-mode-')
    await ensureVaultLayout(root)
    const settings = await getVaultSettings(root)
    await setVaultSettings(root, { ...settings, primaryNotesLocation: 'root' })
    await mkdir(path.join(root, 'inbox', 'demo'), { recursive: true })
    await writeFile(path.join(root, 'inbox', 'demo', 'Start.md'), '# Start\n', 'utf8')

    const next = await renameFolder(root, 'inbox', 'inbox/demo', 'demo')

    expect(next).toBe('demo')
    await expect(readFile(path.join(root, 'demo', 'Start.md'), 'utf8')).resolves.toBe(
      '# Start\n'
    )
    const folders = await listFolders(root)
    expect(folders.some((folder) => folder.folder === 'inbox' && folder.subpath === 'demo')).toBe(
      true
    )
  })
})

describe('searchVaultTextCapabilities', () => {
  it('treats invalid custom executable paths as unavailable', async () => {
    const root = await makeTempDir('zennotes-search-tools-')
    const fake = path.join(root, 'evil-tool')
    await writeFile(fake, 'not a real search binary', 'utf8')

    const capabilities = await searchVaultTextCapabilities(
      { ripgrepPath: fake, fzfPath: fake },
      true
    )

    expect(capabilities.ripgrep).toBe(false)
    expect(capabilities.fzf).toBe(false)
  })
})

describe('searchVaultText', () => {
  it('invalidates cached candidates when a note is written', async () => {
    const root = await makeTempDir('zennotes-search-cache-')
    await ensureVaultLayout(root)
    const rel = 'inbox/cache.md'
    await writeFile(path.join(root, rel), 'alpha only\n', 'utf8')

    expect((await searchVaultText(root, 'alpha', 'builtin')).map((m) => m.path)).toContain(rel)

    await writeNote(root, rel, 'beta only\n')

    expect((await searchVaultText(root, 'alpha', 'builtin')).map((m) => m.path)).not.toContain(
      rel
    )
    expect((await searchVaultText(root, 'beta', 'builtin')).map((m) => m.path)).toContain(rel)
  })

  it('matches note body text when auto resolves to fzf', async () => {
    const root = await makeTempDir('zennotes-search-fzf-')
    await ensureVaultLayout(root)
    const rel = 'inbox/fzf.md'
    await writeFile(path.join(root, rel), 'first line\nneedle unique body\n', 'utf8')

    const fzfPath = path.join(root, 'fzf')
    await writeFile(
      fzfPath,
      [
        '#!/usr/bin/env node',
        "const args = process.argv.slice(2);",
        "if (args.includes('--version')) { console.log('fake fzf'); process.exit(0); }",
        "const filter = args[args.indexOf('--filter') + 1] ?? '';",
        "const delimiterArg = args.find((arg) => arg.startsWith('--delimiter='));",
        "const delimiter = delimiterArg ? delimiterArg.slice('--delimiter='.length) : null;",
        "const nthArg = args.find((arg) => arg.startsWith('--nth='));",
        "const fields = (nthArg ? nthArg.slice('--nth='.length) : '').split(',').map((part) => Number(part)).filter(Boolean);",
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => {",
        "  const rows = input.split(/\\r?\\n/).filter(Boolean);",
        "  const matches = rows.filter((row) => {",
        "    const parts = delimiter === '\\t' ? row.split('\\t') : row.trim().split(/\\s+/);",
        "    const haystack = (fields.length > 0 ? fields.map((field) => parts[field - 1] ?? '').join(' ') : row).toLowerCase();",
        "    return haystack.includes(filter.toLowerCase());",
        "  });",
        "  process.stdout.write(matches.join('\\n'));",
        "  if (matches.length > 0) process.stdout.write('\\n');",
        "});",
        ''
      ].join('\n'),
      'utf8'
    )
    await chmod(fzfPath, 0o755)

    const matches = await searchVaultText(root, 'needle', 'auto', {
      fzfPath,
      ripgrepPath: path.join(root, 'rg')
    })

    expect(matches[0]).toMatchObject({
      path: rel,
      lineNumber: 2,
      offset: 'first line\n'.length
    })
  })

  it('normalizes root-mode ripgrep candidates before fzf search', async () => {
    const root = await makeTempDir('zennotes-search-rg-root-')
    await ensureVaultLayout(root)
    const settings = await getVaultSettings(root)
    await setVaultSettings(root, { ...settings, primaryNotesLocation: 'root' })

    await mkdir(path.join(root, 'demo'), { recursive: true })
    await mkdir(path.join(root, 'quick'), { recursive: true })
    await mkdir(path.join(root, 'trash'), { recursive: true })
    await writeFile(path.join(root, 'demo/root.md'), '# Root\n\nneedle in root mode\n', 'utf8')
    await writeFile(path.join(root, 'quick/quick.md'), '# Quick\n\nneedle in quick\n', 'utf8')
    await writeFile(path.join(root, 'trash/trash.md'), '# Trash\n\nneedle should stay hidden\n', 'utf8')

    const ripgrepPath = path.join(root, 'rg')
    await writeFile(
      ripgrepPath,
      [
        '#!/usr/bin/env node',
        "const args = process.argv.slice(2);",
        "if (args.includes('--version')) { console.log('fake rg'); process.exit(0); }",
        'const events = [',
        "  { type: 'match', data: { path: { text: './demo/root.md' }, lines: { text: 'needle in root mode\\n' }, line_number: 3 } },",
        "  { type: 'match', data: { path: { text: './quick/quick.md' }, lines: { text: 'needle in quick\\n' }, line_number: 3 } },",
        "  { type: 'match', data: { path: { text: './trash/trash.md' }, lines: { text: 'needle should stay hidden\\n' }, line_number: 3 } }",
        '];',
        "process.stdout.write(events.map((event) => JSON.stringify(event)).join('\\n') + '\\n');",
        ''
      ].join('\n'),
      'utf8'
    )
    await chmod(ripgrepPath, 0o755)

    const fzfPath = path.join(root, 'fzf')
    await writeFile(
      fzfPath,
      [
        '#!/usr/bin/env node',
        "const args = process.argv.slice(2);",
        "if (args.includes('--version')) { console.log('fake fzf'); process.exit(0); }",
        'process.stdin.pipe(process.stdout);',
        ''
      ].join('\n'),
      'utf8'
    )
    await chmod(fzfPath, 0o755)

    const matches = await searchVaultText(root, 'needle', 'auto', { ripgrepPath, fzfPath })

    expect(matches.map((match) => ({ path: match.path, folder: match.folder }))).toEqual(
      expect.arrayContaining([
        { path: 'demo/root.md', folder: 'inbox' },
        { path: 'quick/quick.md', folder: 'quick' }
      ])
    )
  })

  it('falls back to built-in ranking when fzf emits no rows', async () => {
    const root = await makeTempDir('zennotes-search-fzf-empty-')
    await ensureVaultLayout(root)
    const rel = 'inbox/fallback.md'
    await writeFile(path.join(root, rel), 'first line\nneedle still exists\n', 'utf8')

    const fzfPath = path.join(root, 'fzf')
    await writeFile(
      fzfPath,
      [
        '#!/usr/bin/env node',
        "const args = process.argv.slice(2);",
        "if (args.includes('--version')) { console.log('fake fzf'); process.exit(0); }",
        'process.stdin.resume();',
        ''
      ].join('\n'),
      'utf8'
    )
    await chmod(fzfPath, 0o755)

    const matches = await searchVaultText(root, 'needle', 'auto', {
      fzfPath,
      ripgrepPath: path.join(root, 'rg')
    })

    expect(matches[0]).toMatchObject({
      path: rel,
      lineNumber: 2,
      offset: 'first line\n'.length
    })
  })
})

describe('listNotes metadata parsing', () => {
  it('does not index #tags inside a fenced code block nested under a list item (#293)', async () => {
    const root = await makeTempDir('zennotes-meta-fence-')
    await ensureVaultLayout(root)
    const rel = 'inbox/code.md'
    await writeFile(
      path.join(root, rel),
      '# Notes\n\n- a list item with a code block:\n\n  ```c\n  #include <stdio.h>\n  ```\n\n#realtag\n',
      'utf8'
    )

    const notes = await listNotes(root)
    const note = notes.find((n) => n.path === rel)
    // `#include` lives inside the indented fence → not a tag; `#realtag` is.
    expect(note?.tags).toEqual(['realtag'])
  })

  it('indexes frontmatter tags as first-class note tags', async () => {
    const root = await makeTempDir('zennotes-meta-frontmatter-tags-')
    await ensureVaultLayout(root)
    const rel = 'inbox/frontmatter.md'
    await writeFile(
      path.join(root, rel),
      '---\ntags: [frontmatter, "#quoted", project/nested]\ntitle: #ignored\n---\n\n#inline\n',
      'utf8'
    )

    const notes = await listNotes(root)
    const note = notes.find((n) => n.path === rel)
    expect(note?.tags).toEqual(['frontmatter', 'quoted', 'project/nested', 'inline'])
  })

  it('indexes block-list frontmatter tags', async () => {
    const root = await makeTempDir('zennotes-meta-frontmatter-tag-list-')
    await ensureVaultLayout(root)
    const rel = 'inbox/frontmatter-list.md'
    await writeFile(path.join(root, rel), '---\ntags:\n  - daily\n  - "#log"\n---\n\nBody\n', 'utf8')

    const notes = await listNotes(root)
    const note = notes.find((n) => n.path === rel)
    expect(note?.tags).toEqual(['daily', 'log'])
  })

  it('detects only local asset references as attachments', async () => {
    const root = await makeTempDir('zennotes-meta-assets-')
    await ensureVaultLayout(root)
    const plainRel = 'inbox/plain.md'
    const imageRel = 'inbox/image.md'
    const embedRel = 'inbox/embed.md'
    await writeFile(path.join(root, plainRel), '# Plain\n\n[[Project Note]]\n', 'utf8')
    await writeFile(path.join(root, imageRel), '# Image\n\n![diagram](../attachements/diagram.png)\n', 'utf8')
    await writeFile(path.join(root, embedRel), '# Embed\n\n![[brief.pdf]]\n', 'utf8')

    const notes = await listNotes(root)
    const byPath = new Map(notes.map((note) => [note.path, note] as const))

    expect(byPath.get(plainRel)?.hasAttachments).toBe(false)
    expect(byPath.get(plainRel)?.wikilinks).toEqual(['Project Note'])
    expect(byPath.get(imageRel)?.hasAttachments).toBe(true)
    expect(byPath.get(embedRel)?.hasAttachments).toBe(true)
    expect(byPath.get(embedRel)?.wikilinks).toEqual([])
  })
})

describe('listNotes symlinks', () => {
  it('lists a note reached through a symlink into the vault', async () => {
    const root = await makeTempDir('zennotes-symlink-')
    await ensureVaultLayout(root)
    const srcDir = await makeTempDir('zennotes-symlink-src-')
    const external = path.join(srcDir, 'External.md')
    await writeFile(external, '# External\n\nlinked body\n', 'utf8')

    const link = path.join(root, 'inbox', 'Linked.md')
    try {
      await symlink(external, link)
    } catch {
      // Creating symlinks can require privileges (e.g. Windows); skip there.
      return
    }

    const notes = await listNotes(root)
    expect(notes.some((note) => note.path === 'inbox/Linked.md')).toBe(true)
  })

  it('lists notes inside a directory symlinked into the vault', async () => {
    const root = await makeTempDir('zennotes-symlink-dir-')
    await ensureVaultLayout(root)
    const srcDir = await makeTempDir('zennotes-symlink-dir-src-')
    await writeFile(path.join(srcDir, 'Inside.md'), '# Inside\n\nlinked dir body\n', 'utf8')

    const link = path.join(root, 'inbox', 'LinkedDir')
    try {
      await symlink(srcDir, link)
    } catch {
      // Creating symlinks can require privileges (e.g. Windows); skip there.
      return
    }

    const notes = await listNotes(root)
    expect(notes.some((note) => note.path === 'inbox/LinkedDir/Inside.md')).toBe(true)
  })

  it('lists a directory symlinked into the vault as a folder', async () => {
    const root = await makeTempDir('zennotes-symlink-folder-')
    await ensureVaultLayout(root)
    const srcDir = await makeTempDir('zennotes-symlink-folder-src-')
    await writeFile(path.join(srcDir, 'Inside.md'), '# Inside\n', 'utf8')

    const link = path.join(root, 'inbox', 'LinkedDir')
    try {
      await symlink(srcDir, link)
    } catch {
      return
    }

    const folders = await listFolders(root)
    expect(folders.some((f) => f.folder === 'inbox' && f.subpath === 'LinkedDir')).toBe(true)
  })

  it('does not infinitely recurse on a symlink cycle inside a linked directory', async () => {
    const root = await makeTempDir('zennotes-symlink-cycle-')
    await ensureVaultLayout(root)
    const srcDir = await makeTempDir('zennotes-symlink-cycle-src-')
    await writeFile(path.join(srcDir, 'Inside.md'), '# Inside\n', 'utf8')

    const link = path.join(root, 'inbox', 'LinkedDir')
    try {
      await symlink(srcDir, link)
      // A self-referential link inside the linked tree loops forever
      // unless the walk tracks resolved ancestors.
      await symlink(srcDir, path.join(srcDir, 'loop'))
    } catch {
      return
    }

    const notes = await listNotes(root)
    expect(notes.some((note) => note.path === 'inbox/LinkedDir/Inside.md')).toBe(true)
  })
})

describe('listNotes metadata cache', () => {
  it('uses matching persisted metadata without reparsing unchanged note bodies', async () => {
    const root = await makeTempDir('zennotes-meta-cache-hit-')
    await ensureVaultLayout(root)
    const rel = 'inbox/cached.md'
    const abs = path.join(root, rel)
    await writeFile(abs, '# Disk Title\n\n#disk\n', 'utf8')
    const info = await stat(abs)
    await mkdir(path.join(root, '.zennotes'), { recursive: true })
    await writeFile(
      path.join(root, '.zennotes', 'note-meta-cache-v1.json'),
      `${JSON.stringify({
        version: 3,
        // The folder the snapshot was built under (#562). A snapshot without
        // it predates the preamble exclusion, so its tags cannot be trusted.
        preambleFolder: 'typst',
        entries: [
          {
            path: rel,
            mtimeMs: info.mtimeMs,
            size: info.size,
            meta: {
              path: rel,
              title: 'Cached Title',
              folder: 'inbox',
              siblingOrder: 0,
              createdAt: info.birthtimeMs || info.ctimeMs,
              updatedAt: info.mtimeMs,
              size: info.size,
              tags: ['cached'],
              wikilinks: ['Cached Target'],
              assetEmbeds: [],
              hasAttachments: false,
              excerpt: 'cached excerpt'
            }
          }
        ]
      })}\n`,
      'utf8'
    )

    invalidateNoteMetaCache(root)

    const notes = await listNotes(root)
    const note = notes.find((item) => item.path === rel)

    expect(note?.title).toBe('Cached Title')
    expect(note?.tags).toEqual(['cached'])
    expect(note?.excerpt).toBe('cached excerpt')
  })

  // #562: a note's tags depend on which folder holds Typst preambles, so a
  // snapshot built under a different folder (or by a build that had no such
  // concept) describes tags this vault no longer believes in. Discarding it is
  // the upgrade path: without this, existing vaults would keep serving their
  // polluted `#let` tags out of disk cache until every file changed.
  it('discards persisted metadata built under a different preamble folder', async () => {
    const root = await makeTempDir('zennotes-meta-cache-preamble-')
    await ensureVaultLayout(root)
    const rel = 'inbox/typst/physics.md'
    const abs = path.join(root, rel)
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, '#let vec(x) = bold(x)\n', 'utf8')
    const info = await stat(abs)
    await mkdir(path.join(root, '.zennotes'), { recursive: true })
    await writeFile(
      path.join(root, '.zennotes', 'note-meta-cache-v1.json'),
      `${JSON.stringify({
        version: 3,
        preambleFolder: 'SomethingElse',
        entries: [
          {
            path: rel,
            mtimeMs: info.mtimeMs,
            size: info.size,
            meta: {
              path: rel,
              title: 'physics',
              folder: 'inbox',
              siblingOrder: 0,
              createdAt: info.birthtimeMs || info.ctimeMs,
              updatedAt: info.mtimeMs,
              size: info.size,
              tags: ['let'],
              wikilinks: [],
              assetEmbeds: [],
              hasAttachments: false,
              excerpt: 'stale'
            }
          }
        ]
      })}\n`,
      'utf8'
    )

    invalidateNoteMetaCache(root)

    const notes = await listNotes(root)
    const note = notes.find((item) => item.path === rel)
    // Re-derived against THIS vault's folder (`typst`), so the preamble
    // contributes nothing rather than the cached `let`.
    expect(note?.tags).toEqual([])
    expect(note?.excerpt).not.toBe('stale')
  })

  it('ignores stale persisted metadata when file stats no longer match', async () => {
    const root = await makeTempDir('zennotes-meta-cache-stale-')
    await ensureVaultLayout(root)
    const rel = 'inbox/stale.md'
    const abs = path.join(root, rel)
    await writeFile(abs, '# Fresh Title\n\n#fresh\n', 'utf8')
    await mkdir(path.join(root, '.zennotes'), { recursive: true })
    await writeFile(
      path.join(root, '.zennotes', 'note-meta-cache-v1.json'),
      `${JSON.stringify({
        version: 1,
        entries: [
          {
            path: rel,
            mtimeMs: 1,
            size: 1,
            meta: {
              path: rel,
              title: 'Stale Title',
              folder: 'inbox',
              siblingOrder: 0,
              createdAt: 1,
              updatedAt: 1,
              size: 1,
              tags: ['stale'],
              wikilinks: [],
              hasAttachments: false,
              excerpt: 'stale excerpt'
            }
          }
        ]
      })}\n`,
      'utf8'
    )

    invalidateNoteMetaCache(root)

    const notes = await listNotes(root)
    const note = notes.find((item) => item.path === rel)

    expect(note?.title).toBe('stale')
    expect(note?.tags).toEqual(['fresh'])
    expect(note?.excerpt).toContain('Fresh Title')
  })
})

describe('listNotes asset embeds (#185 usage)', () => {
  it('captures ![[asset]] and ![](asset) targets, not note wikilinks or URLs', async () => {
    const root = await makeTempDir('zennotes-asset-embeds-')
    await ensureVaultLayout(root)
    await writeFile(
      path.join(root, 'inbox', 'n.md'),
      // Includes the angle-bracket + alt-text form the editor writes: ![alt](<path>).
      '![[photo.png]]\n![](assets/doc.pdf)\n![GreenGrass](<GreenGrass.jpg>)\n[[Some Note]]\n![](https://x.com/a.png)\n',
      'utf8'
    )
    const notes = await listNotes(root)
    const note = notes.find((n) => n.path === 'inbox/n.md')
    expect(note?.assetEmbeds.sort()).toEqual(['GreenGrass.jpg', 'assets/doc.pdf', 'photo.png'])
    expect(note?.wikilinks).toEqual(['Some Note']) // note links stay separate
  })
})

describe('archive / trash round-trips', () => {
  async function makeVaultWithNestedNote(): Promise<{ root: string }> {
    const root = await makeTempDir('zennotes-folder-moves-')
    await ensureVaultLayout(root)
    await mkdir(path.join(root, 'inbox', 'demo'), { recursive: true })
    await writeFile(path.join(root, 'inbox', 'demo', 'Tables.md'), '# Tables\n', 'utf8')
    return { root }
  }

  it('archives a nested note into the matching archive subfolder', async () => {
    const { root } = await makeVaultWithNestedNote()

    const archived = await archiveNote(root, 'inbox/demo/Tables.md')

    expect(archived.path).toBe('archive/demo/Tables.md')
    await expect(readFile(path.join(root, 'archive', 'demo', 'Tables.md'), 'utf8')).resolves.toBe(
      '# Tables\n'
    )
  })

  it('unarchive returns the note to the subfolder it came from', async () => {
    const { root } = await makeVaultWithNestedNote()

    const archived = await archiveNote(root, 'inbox/demo/Tables.md')
    const restored = await unarchiveNote(root, archived.path)

    expect(restored.path).toBe('inbox/demo/Tables.md')
    await expect(readFile(path.join(root, 'inbox', 'demo', 'Tables.md'), 'utf8')).resolves.toBe(
      '# Tables\n'
    )
  })

  it('trash and restore preserve the subfolder too', async () => {
    const { root } = await makeVaultWithNestedNote()

    const trashed = await moveToTrash(root, 'inbox/demo/Tables.md')
    expect(trashed.path).toBe('trash/demo/Tables.md')

    const restored = await restoreFromTrash(root, trashed.path)
    expect(restored.path).toBe('inbox/demo/Tables.md')
  })

  it('top-level notes keep round-tripping at the top level', async () => {
    const root = await makeTempDir('zennotes-folder-moves-top-')
    await ensureVaultLayout(root)
    await writeFile(path.join(root, 'inbox', 'Solo.md'), '# Solo\n', 'utf8')

    const archived = await archiveNote(root, 'inbox/Solo.md')
    expect(archived.path).toBe('archive/Solo.md')

    const restored = await unarchiveNote(root, archived.path)
    expect(restored.path).toBe('inbox/Solo.md')
  })

  it('de-duplicates titles within the destination subfolder', async () => {
    const { root } = await makeVaultWithNestedNote()
    await mkdir(path.join(root, 'archive', 'demo'), { recursive: true })
    await writeFile(path.join(root, 'archive', 'demo', 'Tables.md'), '# Other\n', 'utf8')

    const archived = await archiveNote(root, 'inbox/demo/Tables.md')

    expect(archived.path).toMatch(/^archive\/demo\/Tables .+\.md$/)
    await expect(readFile(path.join(root, 'archive', 'demo', 'Tables.md'), 'utf8')).resolves.toBe(
      '# Other\n'
    )
  })

  it('preserves subfolders in root-primary mode', async () => {
    const root = await makeTempDir('zennotes-folder-moves-rootmode-')
    await ensureVaultLayout(root)
    const settings = await getVaultSettings(root)
    await setVaultSettings(root, { ...settings, primaryNotesLocation: 'root' })
    await mkdir(path.join(root, 'projects'), { recursive: true })
    await writeFile(path.join(root, 'projects', 'Plan.md'), '# Plan\n', 'utf8')

    const archived = await archiveNote(root, 'projects/Plan.md')
    expect(archived.path).toBe('archive/projects/Plan.md')

    const restored = await unarchiveNote(root, archived.path)
    expect(restored.path).toBe('projects/Plan.md')
    await expect(readFile(path.join(root, 'projects', 'Plan.md'), 'utf8')).resolves.toBe('# Plan\n')
  })
})

describe('per-vault view settings round-trip (#292)', () => {
  it('persists the view block and drops unknown keys through set/get', async () => {
    const root = await makeTempDir('zennotes-vault-view-')
    await ensureVaultLayout(root)
    const base = await getVaultSettings(root)
    await setVaultSettings(root, {
      ...base,
      view: { noteSortOrder: 'name-asc', groupByKind: false, tasksViewMode: 'kanban', bogus: 'x' }
    } as Awaited<ReturnType<typeof getVaultSettings>>)
    const saved = await getVaultSettings(root)
    expect(saved.view?.noteSortOrder).toBe('name-asc')
    expect(saved.view?.groupByKind).toBe(false)
    expect(saved.view?.tasksViewMode).toBe('kanban')
    expect((saved.view as Record<string, unknown> | undefined)?.bogus).toBeUndefined()
  })

  it('omits the view block when there are no overrides', async () => {
    const root = await makeTempDir('zennotes-vault-noview-')
    await ensureVaultLayout(root)
    expect((await getVaultSettings(root)).view).toBeUndefined()
  })
})

// #585 made note saves atomic (temp file + rename) so no reader can ever see a
// half-written note. A rename replaces the directory entry, so these are the
// properties the plain fs.writeFile gave for free and that the atomic write has
// to put back deliberately.
describe('writeNote atomic-save fidelity (#585)', () => {
  it('writes THROUGH a symlinked note instead of replacing the link', async () => {
    const root = await makeTempDir('zennotes-atomic-symlink-')
    await ensureVaultLayout(root)
    const srcDir = await makeTempDir('zennotes-atomic-symlink-src-')
    const external = path.join(srcDir, 'External.md')
    await writeFile(external, '# External\n\noriginal\n', 'utf8')

    const link = path.join(root, 'inbox', 'Linked.md')
    try {
      await symlink(external, link)
    } catch {
      // Creating symlinks can require privileges (e.g. Windows); skip there.
      return
    }

    await writeNote(root, 'inbox/Linked.md', '# External\n\nedited through the link\n')

    expect((await fsPromises.lstat(link)).isSymbolicLink()).toBe(true)
    expect(await readFile(external, 'utf8')).toBe('# External\n\nedited through the link\n')
  })

  it('leaves an existing note its own permissions', async () => {
    if (process.platform === 'win32') return
    const root = await makeTempDir('zennotes-atomic-mode-')
    await ensureVaultLayout(root)
    const abs = path.join(root, 'inbox', 'Private.md')
    await writeFile(abs, '# Private\n', 'utf8')
    await chmod(abs, 0o600)

    await writeNote(root, 'inbox/Private.md', '# Private\n\nsecond draft\n')

    expect((await stat(abs)).mode & 0o777).toBe(0o600)
  })

  it('leaves no scratch file behind', async () => {
    const root = await makeTempDir('zennotes-atomic-scratch-')
    await ensureVaultLayout(root)
    await writeNote(root, 'inbox/Note.md', 'one')
    await writeNote(root, 'inbox/Note.md', 'two')

    const entries = await fsPromises.readdir(path.join(root, 'inbox'))
    expect(entries.filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('retries a replace while another process temporarily denies it', async () => {
    let calls = 0
    const delays: number[] = []
    await renameWithRetry(
      'Note.md.tmp',
      'Note.md',
      async () => {
        calls++
        if (calls < 3) {
          throw Object.assign(new Error('sharing violation'), { code: 'EACCES' })
        }
      },
      async (delay) => {
        delays.push(delay)
      }
    )

    expect(calls).toBe(3)
    expect(delays).toEqual([1, 2])
  })

  it('recognizes its own scratch files without swallowing user files', () => {
    expect(isAtomicWriteTempPath('inbox/Note.md.4123.1786714355519000.tmp')).toBe(true)
    expect(isAtomicWriteTempPath('inbox/Note.md')).toBe(false)
    expect(isAtomicWriteTempPath('inbox/report.2024.01.tmp')).toBe(false)
  })
})
