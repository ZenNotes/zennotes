import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const exists = async (abs: string): Promise<boolean> =>
  access(abs).then(
    () => true,
    () => false
  )
import {
  absolutePath,
  appendToNote,
  archiveNote,
  deleteAsset,
  duplicateAsset,
  ensureVaultLayout,
  forgetLocalVault,
  getVaultSettings,
  importPastedImage,
  invalidateNoteMetaCache,
  listNotes,
  listFolders,
  listSoftDeleted,
  moveAsset,
  moveToTrash,
  rememberLocalVault,
  renameAsset,
  renameFolder,
  restoreSoftDeleted,
  searchVaultText,
  searchVaultTextCapabilities,
  setVaultSettings,
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
  it('writes clipboard image bytes to assets/ and returns a wiki embed', async () => {
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
    await expect(
      readFile(path.join(root, 'assets', 'Screenshot 2026-05-13.png'))
    ).resolves.toEqual(Buffer.from([137, 80, 78, 71]))
  })

  it('generates a unique filename in assets/ when the clipboard has no useful name', async () => {
    const root = await makeTempDir('zennotes-paste-image-name-')
    await ensureVaultLayout(root)
    await mkdir(path.join(root, 'assets'), { recursive: true })
    await writeFile(
      path.join(root, 'assets', 'Pasted Image 2026-05-13 150405.webp'),
      'existing',
      'utf8'
    )

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
    await expect(readFile(path.join(root, 'assets', imported.name))).resolves.toEqual(
      Buffer.from([1, 2, 3])
    )
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

  it('soft-deletes a non-markdown asset to trash and can restore it', async () => {
    const root = await makeTempDir('zennotes-delete-asset-')
    await ensureVaultLayout(root)
    const rel = 'Screenshot.png'
    await writeFile(path.join(root, rel), 'image-bytes', 'utf8')

    const handle = await deleteAsset(root, rel)

    expect(handle.startsWith('trash/')).toBe(true)
    await expect(readFile(path.join(root, rel), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
    const entries = await listSoftDeleted(root)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      kind: 'asset',
      top: 'trash',
      name: 'Screenshot.png',
      originalRel: rel,
      title: 'Screenshot.png'
    })

    await restoreSoftDeleted(root, handle)

    await expect(readFile(path.join(root, rel), 'utf8')).resolves.toBe('image-bytes')
    expect(await listSoftDeleted(root)).toHaveLength(0)
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
        version: 1,
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

describe('archive / trash round-trips', () => {
  async function makeVaultWithNestedNote(): Promise<{ root: string }> {
    const root = await makeTempDir('zennotes-folder-moves-')
    await ensureVaultLayout(root)
    await mkdir(path.join(root, 'inbox', 'demo'), { recursive: true })
    await writeFile(path.join(root, 'inbox', 'demo', 'Tables.md'), '# Tables\n', 'utf8')
    return { root }
  }

  it('archives a nested note into a UUID wrapper, recording its origin', async () => {
    const { root } = await makeVaultWithNestedNote()

    const handle = await archiveNote(root, 'inbox/demo/Tables.md')

    expect(handle.startsWith('archive/')).toBe(true)
    expect(await exists(path.join(root, 'inbox/demo/Tables.md'))).toBe(false)
    const [entry] = await listSoftDeleted(root)
    expect(entry).toMatchObject({
      kind: 'note',
      top: 'archive',
      name: 'Tables.md',
      originalRel: 'inbox/demo/Tables.md',
      title: 'Tables'
    })
    await expect(
      readFile(path.join(root, entry.top, entry.id, 'Tables.md'), 'utf8')
    ).resolves.toBe('# Tables\n')
  })

  it('restoring an archived note returns it to the subfolder it came from', async () => {
    const { root } = await makeVaultWithNestedNote()

    await archiveNote(root, 'inbox/demo/Tables.md')
    const [entry] = await listSoftDeleted(root)
    await restoreSoftDeleted(root, `${entry.top}/${entry.id}`)

    await expect(readFile(path.join(root, 'inbox', 'demo', 'Tables.md'), 'utf8')).resolves.toBe(
      '# Tables\n'
    )
    expect(await listSoftDeleted(root)).toHaveLength(0)
  })

  it('trash and restore preserve the original subfolder too', async () => {
    const { root } = await makeVaultWithNestedNote()

    const handle = await moveToTrash(root, 'inbox/demo/Tables.md')
    expect(handle.startsWith('trash/')).toBe(true)
    expect((await listSoftDeleted(root))[0]).toMatchObject({
      kind: 'note',
      top: 'trash',
      originalRel: 'inbox/demo/Tables.md'
    })

    const [entry] = await listSoftDeleted(root)
    await restoreSoftDeleted(root, `${entry.top}/${entry.id}`)
    expect(await exists(path.join(root, 'inbox/demo/Tables.md'))).toBe(true)
  })

  it('two same-named trashed notes never collide (UUID wrappers)', async () => {
    const root = await makeTempDir('zennotes-folder-moves-dup-')
    await ensureVaultLayout(root)
    await writeFile(path.join(root, 'inbox', 'Solo.md'), '# A\n', 'utf8')
    await moveToTrash(root, 'inbox/Solo.md')
    await writeFile(path.join(root, 'inbox', 'Solo.md'), '# B\n', 'utf8')
    await moveToTrash(root, 'inbox/Solo.md')

    const entries = await listSoftDeleted(root)
    expect(entries).toHaveLength(2)
    expect(entries.every((e) => e.kind === 'note' && e.originalRel === 'inbox/Solo.md')).toBe(true)
    expect(new Set(entries.map((e) => e.id)).size).toBe(2)
  })

  it('de-duplicates the name on restore when the origin is occupied', async () => {
    const { root } = await makeVaultWithNestedNote()
    await archiveNote(root, 'inbox/demo/Tables.md')
    // Recreate a note at the origin so restore must pick a fresh name.
    await writeFile(path.join(root, 'inbox', 'demo', 'Tables.md'), '# Other\n', 'utf8')

    const [entry] = await listSoftDeleted(root)
    await restoreSoftDeleted(root, `${entry.top}/${entry.id}`)

    // Original kept; the restored copy lands beside it under a deduped name.
    await expect(readFile(path.join(root, 'inbox', 'demo', 'Tables.md'), 'utf8')).resolves.toBe(
      '# Other\n'
    )
    const restored = (await listNotes(root)).filter((n) =>
      n.path.startsWith('inbox/demo/Tables')
    )
    expect(restored.length).toBe(2)
  })
})
