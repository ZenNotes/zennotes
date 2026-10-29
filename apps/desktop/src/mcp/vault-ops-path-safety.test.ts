import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendToNote,
  archiveNote,
  createFolder,
  createNote,
  deleteFolder,
  deleteNote,
  duplicateNote,
  moveNote,
  moveToTrash,
  readNote,
  renameFolder,
  renameNote,
  restoreFromTrash,
  toggleTask,
  writeNote
} from './vault-ops'

// The probe cases behind ZenNotes/tui#21's Phase 0: every tool that creates,
// moves, renames or deletes a note or folder stays inside the note folders.
// Run on a root-mode vault, where the inbox is the vault root and the internal
// dir, the attachments dir and the other buckets are all one subpath away.
// Mirrors internal/vault/path_safety_test.go in ZenNotes/tui.

let base: string
let root: string
let configDir: string
const previousConfigDir = process.env.ZENNOTES_CONFIG_DIR

const seed = async (files: Record<string, string>): Promise<void> => {
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
    await writeFile(path.join(root, rel), body)
  }
}

const exists = (rel: string): Promise<boolean> =>
  lstat(path.join(root, rel)).then(
    () => true,
    () => false
  )

const vaultJson = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path.join(root, '.zennotes', 'vault.json'), 'utf8'))

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'zennotes-mcp-path-safety-'))
  root = path.join(base, 'vault')
  configDir = path.join(base, 'config')
  await mkdir(configDir, { recursive: true })
  process.env.ZENNOTES_CONFIG_DIR = configDir
  await seed({
    '.zennotes/vault.json': JSON.stringify({
      primaryNotesLocation: 'root',
      folderIcons: {
        'inbox:Projects': 'star',
        'inbox:Projects/Old': 'box',
        'inbox:ProjectsX': 'dot',
        'quick:Projects': 'bolt'
      },
      folderColors: { 'inbox:Projects': 'red' },
      tasks: { excludedFolders: ['Projects/Old'] },
      favorites: ['Projects/Plan.md']
    }),
    '.zennotes/templates/Daily.md': '- [ ] stand up\n',
    'Projects/Plan.md': '# Plan\n',
    'Projects/Old/Before.md': '# Before\n',
    'Projects/notes.txt': 'plain text\n',
    'Journal/Diary.md': '# Diary\n',
    'attachements/img.png': 'PNG',
    'archive/Old.md': '# Old\n',
    'quick/Q.md': '# Q\n'
  })
})

afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.ZENNOTES_CONFIG_DIR
  else process.env.ZENNOTES_CONFIG_DIR = previousConfigDir
  await rm(base, { recursive: true, force: true })
})

describe('MCP note tools stay inside the note folders (tui#21 Phase 0)', () => {
  // G1 and the rest: the source must be a note. Unchecked, move_note carried
  // vault.json into a note folder for read_note to read, and archive_note,
  // move_to_trash and delete_note took it away.
  it('refuses a file outside the note folders as the source of every note tool', async () => {
    const internal = '.zennotes/vault.json'
    const refused = `Note not in a known folder: ${internal}`
    await expect(moveNote(root, internal, 'inbox', 'Projects')).rejects.toThrow(refused)
    await expect(archiveNote(root, internal)).rejects.toThrow(refused)
    await expect(moveToTrash(root, internal)).rejects.toThrow(refused)
    await expect(restoreFromTrash(root, internal)).rejects.toThrow(refused)
    await expect(renameNote(root, internal, 'settings')).rejects.toThrow(refused)
    await expect(duplicateNote(root, internal)).rejects.toThrow(refused)
    await expect(appendToNote(root, internal, 'x')).rejects.toThrow(refused)
    await expect(readNote(root, internal)).rejects.toThrow(refused)
    await expect(deleteNote(root, internal)).rejects.toThrow(refused)
    expect(await exists(internal)).toBe(true)
    expect(await exists('Projects/vault.json')).toBe(false)
    expect(await exists('archive/vault.md')).toBe(false)
    expect(await exists('trash/vault.md')).toBe(false)

    // toggle_task used to write first and check after.
    const template = '.zennotes/templates/Daily.md'
    await expect(toggleTask(root, `${template}#0`)).rejects.toThrow(
      `Note not in a known folder: ${template}`
    )
    expect(await readFile(path.join(root, template), 'utf8')).toBe('- [ ] stand up\n')

    // A dot directory below the top is no note folder either: the listings
    // never descend into one.
    await expect(writeNote(root, 'Projects/.hidden/x.md', 'x')).rejects.toThrow(
      'Note not in a known folder: Projects/.hidden/x.md'
    )
    expect(await exists('Projects/.hidden')).toBe(false)
  })

  // G2 and friends: what a create or a move writes lands in a note folder of
  // the bucket it names.
  it('lands creates and moves only in note folders', async () => {
    for (const sub of [
      '.zennotes',
      'attachements',
      'archive/Projects',
      'trash',
      'Projects/.hidden',
      'Projects/../.zennotes'
    ]) {
      const refused = `Not a note folder: ${sub}`
      await expect(createNote(root, 'inbox', 'planted', sub)).rejects.toThrow(refused)
      await expect(createFolder(root, 'inbox', sub)).rejects.toThrow(refused)
      await expect(moveNote(root, 'Projects/Plan.md', 'inbox', sub)).rejects.toThrow(refused)
    }
    expect(await exists('.zennotes/planted.md')).toBe(false)
    expect(await exists('attachements/planted.md')).toBe(false)
    expect(await exists('trash/planted.md')).toBe(false)
    expect(await exists('Projects/Plan.md')).toBe(true)
    await expect(createFolder(root, 'inbox', 'x/..')).rejects.toThrow('Folder name is required')

    // Ordinary subfolders of either bucket still take notes.
    expect((await createNote(root, 'inbox', 'Fine', 'Projects/Sub')).path).toBe(
      'Projects/Sub/Fine.md'
    )
    expect((await createNote(root, 'quick', 'Fine', 'Work')).path).toBe('quick/Work/Fine.md')
  })

  // G3, G4 and the bucket root: `x/..` resolved to the root, and in root mode
  // delete_folder then removed the whole vault.
  it('refuses folder operations on system folders and the bucket root', async () => {
    await expect(deleteFolder(root, 'inbox', 'attachements')).rejects.toThrow(
      'Not a note folder: attachements'
    )
    await expect(deleteFolder(root, 'inbox', 'archive')).rejects.toThrow(
      'Not a note folder: archive'
    )
    await expect(deleteFolder(root, 'inbox', '.zennotes')).rejects.toThrow(
      'Not a note folder: .zennotes'
    )
    await expect(deleteFolder(root, 'inbox', 'x/..')).rejects.toThrow(
      'Cannot delete the top-level folder'
    )
    await expect(deleteFolder(root, 'archive', 'x/..')).rejects.toThrow(
      'Cannot delete the top-level folder'
    )
    await expect(renameFolder(root, 'inbox', '.zennotes', 'Projects/internals')).rejects.toThrow(
      'Not a note folder: .zennotes'
    )
    await expect(renameFolder(root, 'inbox', 'Projects', '.zennotes/x')).rejects.toThrow(
      'Not a note folder: .zennotes/x'
    )
    await expect(renameFolder(root, 'inbox', 'Projects', 'x/..')).rejects.toThrow(
      'Both old and new folder paths are required'
    )
    for (const rel of ['.zennotes/vault.json', 'attachements/img.png', 'archive/Old.md', 'Projects/Plan.md']) {
      expect(await exists(rel)).toBe(true)
    }
    expect(await exists('Projects/internals')).toBe(false)

    // A case variant of the attachments dir is that same directory on macOS
    // and Windows, and is refused there; elsewhere it is a different folder.
    if (await exists('Attachements')) {
      await expect(deleteFolder(root, 'inbox', 'Attachements')).rejects.toThrow(
        'Not a note folder: Attachements'
      )
      expect(await exists('attachements/img.png')).toBe(true)
    }

    await deleteFolder(root, 'inbox', 'Journal')
    expect(await exists('Journal')).toBe(false)
  })

  // Classification follows the vault's systemFolderPaths, not literal names.
  it('follows remapped system folders', async () => {
    await seed({
      '.zennotes/vault.json': JSON.stringify({
        primaryNotesLocation: 'root',
        systemFolderPaths: { archive: '99 - Old' }
      }),
      '99 - Old/Gone.md': '# Gone\n'
    })
    await expect(deleteFolder(root, 'inbox', '99 - Old')).rejects.toThrow(
      'Not a note folder: 99 - Old'
    )
    expect(await exists('99 - Old/Gone.md')).toBe(true)
    const created = await createNote(root, 'inbox', 'Note', 'archive')
    expect(created).toMatchObject({ path: 'archive/Note.md', folder: 'inbox' })
    await deleteFolder(root, 'inbox', 'archive')
    expect(await exists('archive')).toBe(false)
  })

  it('holds the same rules one level down in inbox mode', async () => {
    await seed({
      '.zennotes/vault.json': JSON.stringify({ primaryNotesLocation: 'inbox' }),
      'inbox/Work/Plan.md': '# Plan\n'
    })
    await expect(createNote(root, 'inbox', 'planted', '.zennotes')).rejects.toThrow(
      'Not a note folder: .zennotes'
    )
    // zn clamps a leading `..` at the bucket root and then refuses the dot
    // directory; this engine refuses the escape itself. Either way nothing lands.
    await expect(createNote(root, 'quick', 'planted', '../.zennotes')).rejects.toThrow(
      'Path escapes vault: ../.zennotes'
    )
    await expect(deleteFolder(root, 'inbox', '..')).rejects.toThrow('Path escapes vault: ..')
    expect(await exists('inbox/Work/Plan.md')).toBe(true)
    expect((await moveNote(root, 'inbox/Work/Plan.md', 'archive', 'Work')).path).toBe(
      'archive/Work/Plan.md'
    )
  })
})

describe('read_note reads only Markdown notes inside the vault', () => {
  it('refuses a file that is not a note', async () => {
    await expect(readNote(root, 'Projects/notes.txt')).rejects.toThrow(
      'Not a Markdown note: Projects/notes.txt'
    )
    expect((await readNote(root, 'Projects/Plan.md')).body).toBe('# Plan\n')
  })

  // G5: path resolution was lexical, so a link inside the vault pointing out
  // of it was followed. zn's SafeJoin resolves links and refuses.
  it('refuses to follow a symbolic link out of the vault', async () => {
    const outside = path.join(base, 'outside')
    await mkdir(outside, { recursive: true })
    await writeFile(path.join(outside, 'secret.md'), '# OUTSIDE SECRET\n')
    await symlink(outside, path.join(root, 'Projects', 'link'))
    await expect(readNote(root, 'Projects/link/secret.md')).rejects.toThrow(
      'Path escapes vault: Projects/link/secret.md'
    )
    await expect(createNote(root, 'inbox', 'planted', 'Projects/link')).rejects.toThrow(
      'Path escapes vault: Projects/link'
    )
    expect(await exists('../outside/planted.md')).toBe(false)
  })
})

describe('rename_folder carries the vault.json settings that name the folder', () => {
  it('rewrites the folder icons, colors and Tasks lists, keeping every other key', async () => {
    expect(await renameFolder(root, 'inbox', 'Projects', 'Work')).toBe('Work')
    const settings = await vaultJson()
    expect(settings.folderIcons).toEqual({
      'inbox:Work': 'star',
      'inbox:Work/Old': 'box',
      'inbox:ProjectsX': 'dot',
      'quick:Projects': 'bolt'
    })
    expect(settings.folderColors).toEqual({ 'inbox:Work': 'red' })
    expect(settings.tasks).toEqual({ excludedFolders: ['Work/Old'] })
    expect(settings.favorites).toEqual(['Projects/Plan.md'])
    expect(settings.primaryNotesLocation).toBe('root')
  })

  it('refuses a folder that is not there and leaves vault.json alone', async () => {
    const before = await readFile(path.join(root, '.zennotes', 'vault.json'), 'utf8')
    await expect(renameFolder(root, 'inbox', 'Nope', 'Work')).rejects.toThrow(/ENOENT/)
    expect(await readFile(path.join(root, '.zennotes', 'vault.json'), 'utf8')).toBe(before)
  })
})
