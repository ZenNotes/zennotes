import { mkdtemp, mkdir, rm, readFile, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getVaultSettings,
  listNotes,
  migrateLegacyDatabases,
  migrateLooseAssets,
  readNote,
  setVaultSettings,
  writeNote
} from './vault'

// Reproduction harness for #202 ("Notes show the wrong content" → ZenNotes
// overwrote files on disk with another note's content). The reporter pointed
// ZenNotes at an existing Obsidian vault opened in ROOT mode, with nested
// folders and filenames containing SPACES (e.g. `Work/Documentation/Vault CLI
// Cheatsheet.md`), under `~/sync/obsidian` (a likely-symlinked sync dir).
//
// These tests wire the REAL main-process vault I/O end-to-end and assert that a
// note's identity (path) and content never cross-contaminate.

const tempDirs: string[] = []

async function makeTempVault(prefix = 'zennotes-202-'): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

// The reporter's vault shape: root mode, nested folders, spaces in names, and a
// neighbour in the same folder (the prime cross-contamination suspect).
const FILES: Record<string, string> = {
  'Work/Documentation/Vault CLI Cheatsheet.md':
    '---\ntags:\n  - "#cheatsheet"\ndate: 242024-11-14\n---\n> [!info] Vault CLI Cheatsheet\nCHEATSHEET BODY\n',
  'Work/Documentation/Another Note.md': '# Another Note\nNEIGHBOUR BODY\n',
  'Work/Projects/plan.md': '# Plan\nPLAN BODY\n',
  'index.md': '# Index\nINDEX BODY\n'
}

async function buildObsidianVault(root: string, files: Record<string, string> = FILES): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'))
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, body, 'utf8')
  }
  // The `.obsidian/` dir is what marks this as an existing Obsidian vault.
  await mkdir(path.join(root, '.obsidian'), { recursive: true })
  const base = await getVaultSettings(root)
  await setVaultSettings(root, { ...base, primaryNotesLocation: 'root' })
}

async function readDiskBody(root: string, rel: string): Promise<string> {
  return await readFile(path.join(root, ...rel.split('/')), 'utf8')
}

describe('#202 — note content/path integrity (root-mode Obsidian vault, spaces in names)', () => {
  it('listNotes emits one correct path per file, no dupes or collisions', async () => {
    const root = await makeTempVault()
    await buildObsidianVault(root)

    const notes = await listNotes(root)
    const paths = notes.map((n) => n.path).sort()

    expect(paths).toEqual([
      'Work/Documentation/Another Note.md',
      'Work/Documentation/Vault CLI Cheatsheet.md',
      'Work/Projects/plan.md',
      'index.md'
    ])
    // No two notes share a path (the collision that would cross-wire content).
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('readNote returns each note its OWN body — never a neighbour’s', async () => {
    const root = await makeTempVault()
    await buildObsidianVault(root)

    for (const [rel, expected] of Object.entries(FILES)) {
      const content = await readNote(root, rel)
      expect(content.body, `readNote(${rel}) returned the wrong body`).toBe(expected)
      expect(content.path).toBe(rel)
    }
  })

  it('writeNote to ONE note leaves every OTHER file byte-identical', async () => {
    const root = await makeTempVault()
    await buildObsidianVault(root)

    const target = 'Work/Documentation/Vault CLI Cheatsheet.md'
    const newBody = '---\ntags: []\n---\n> [!info] EDITED\nNEW CHEATSHEET BODY\n'
    const meta = await writeNote(root, target, newBody)

    // The path round-trips (so the renderer's `n.path === meta.path` match holds).
    expect(meta.path).toBe(target)
    expect(await readDiskBody(root, target)).toBe(newBody)

    // Every neighbour is untouched on disk.
    for (const [rel, original] of Object.entries(FILES)) {
      if (rel === target) continue
      expect(await readDiskBody(root, rel), `${rel} was clobbered`).toBe(original)
    }
  })

  it('a full list→read→write-back round-trip changes nothing on disk', async () => {
    const root = await makeTempVault()
    await buildObsidianVault(root)

    const notes = await listNotes(root)
    // Simulate the renderer loading each note then autosaving its own buffer.
    for (const note of notes) {
      const loaded = await readNote(root, note.path)
      await writeNote(root, note.path, loaded.body)
    }

    for (const [rel, original] of Object.entries(FILES)) {
      expect(await readDiskBody(root, rel), `${rel} drifted after round-trip`).toBe(original)
    }
  })

  it('survives a symlinked vault root (the ~/sync case) without cross-writing', async () => {
    const real = await makeTempVault('zennotes-202-real-')
    await buildObsidianVault(real)
    const linkParent = await makeTempVault('zennotes-202-link-')
    const link = path.join(linkParent, 'obsidian')
    await symlink(real, link, 'dir')

    // Open the vault THROUGH the symlink, as `~/sync/obsidian` would.
    const notes = await listNotes(link)
    expect(notes.map((n) => n.path).sort()).toContain('Work/Documentation/Vault CLI Cheatsheet.md')

    const target = 'Work/Documentation/Vault CLI Cheatsheet.md'
    const loaded = await readNote(link, target)
    expect(loaded.body).toBe(FILES[target])

    const newBody = '# rewritten through the symlink\n'
    await writeNote(link, target, newBody)
    // The write landed on the correct REAL file, and nothing else moved.
    expect(await readFile(path.join(real, 'Work', 'Documentation', 'Vault CLI Cheatsheet.md'), 'utf8')).toBe(newBody)
    expect(await readFile(path.join(real, 'Work', 'Documentation', 'Another Note.md'), 'utf8')).toBe(
      FILES['Work/Documentation/Another Note.md']
    )
  })

  it('on-open migrations never rewrite or clobber note (.md) content', async () => {
    const root = await makeTempVault()
    await buildObsidianVault(root)
    // An Obsidian vault often has loose non-md files at the root.
    await writeFile(path.join(root, 'canvas board.canvas'), 'CANVAS DATA', 'utf8')
    await writeFile(path.join(root, 'photo.png'), 'PNGDATA', 'utf8')

    await migrateLegacyDatabases(root)
    const assetResult = await migrateLooseAssets(root)

    // Every note's body is exactly as authored — migrations must not touch .md.
    for (const [rel, original] of Object.entries(FILES)) {
      expect(await readDiskBody(root, rel), `${rel} changed during migration`).toBe(original)
    }
    // The fix for #202: a vault managed by Obsidian (`.obsidian/`) keeps its
    // loose files exactly where the user put them — ZenNotes must not relocate
    // `board.canvas`/`photo.png` into assets/ behind their back.
    expect(assetResult.moved).toEqual([])
    expect(await readDiskBody(root, 'canvas board.canvas')).toBe('CANVAS DATA')
    expect(await readDiskBody(root, 'photo.png')).toBe('PNGDATA')
  })

  it('still migrates loose attachments for a non-Obsidian vault (upgrade path intact)', async () => {
    const root = await makeTempVault()
    // Same shape but NOT an Obsidian vault (no `.obsidian/`): a former ZenNotes
    // vault whose pasted image sits loose at the root.
    for (const [rel, body] of Object.entries(FILES)) {
      const abs = path.join(root, ...rel.split('/'))
      await mkdir(path.dirname(abs), { recursive: true })
      await writeFile(abs, body, 'utf8')
    }
    const base = await getVaultSettings(root)
    await setVaultSettings(root, { ...base, primaryNotesLocation: 'root' })
    await writeFile(path.join(root, 'pasted.png'), 'PNGDATA', 'utf8')

    const assetResult = await migrateLooseAssets(root)
    expect(assetResult.moved).toContain('assets/pasted.png')
    expect(await readDiskBody(root, 'assets/pasted.png')).toBe('PNGDATA')
  })
})
