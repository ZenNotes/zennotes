import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  absolutePath,
  appendToNote,
  archiveNote,
  deleteAsset,
  duplicateAsset,
  emptyDeletedAssets,
  ensureVaultLayout,
  forgetLocalVault,
  getVaultSettings,
  importFiles,
  importPastedImage,
  invalidateNoteMetaCache,
  listDeletedAssets,
  listNotes,
  listFolders,
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

  it('stores in assets/ for an inbox-mode note too, linked relative to the note', async () => {
    const root = await makeTempDir('zennotes-import-files-inbox-')
    await ensureVaultLayout(root)
    const srcDir = await makeTempDir('zennotes-import-src-inbox-')
    const src = path.join(srcDir, 'Photo.png')
    await writeFile(src, Buffer.from([1, 2, 3]))

    const imported = await importFiles(root, 'inbox/Note.md', [src])

    expect(imported[0]?.path).toBe('assets/Photo.png')
    // Note in inbox/, asset in assets/, so the link steps up a level.
    expect(imported[0]?.markdown).toContain('../assets/Photo.png')
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
        version: 2,
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
