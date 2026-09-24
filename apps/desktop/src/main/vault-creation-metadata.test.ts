import { mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const environment = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => {
      if (!environment.userData) throw new Error('Vault test has not initialized app data')
      return environment.userData
    }
  }
}))

import {
  createNote,
  deleteNote,
  getVaultSettings,
  invalidateNoteMetaCache,
  invalidateVaultSettingsCache,
  listNotes,
  moveNote,
  moveToTrash,
  readNote,
  renameFolder,
  renameNote,
  restoreFromTrash,
  setVaultSettings,
  writeNote
} from './vault'
import * as mcpVault from '../mcp/vault-ops'

const roots: string[] = []
const ORIGINAL_CREATED_AT = Date.UTC(2001, 1, 3, 4, 5, 6, 123)
const ORIGINAL_BODY = '# Café 笔记\r\n\r\nKeep **Markdown** and trailing spaces.  \r\n- [ ] Exact bytes\r\n'

function metadataPath(root: string, notePath: string): string {
  return path.join(root, '.zennotes', 'note-metadata', `${notePath}.metadata.json`)
}

async function makeVault(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zn-creation-metadata-'))
  roots.push(root)
  environment.userData = path.join(root, '.test-app')
  await mkdir(environment.userData, { recursive: true })
  vi.stubEnv('ZENNOTES_USER_DATA_PATH', environment.userData)
  vi.stubEnv('ZENNOTES_CONFIG_DIR', environment.userData)
  return root
}

async function seedNote(
  root: string,
  notePath: string,
  createdAt = ORIGINAL_CREATED_AT,
  body = ORIGINAL_BODY
): Promise<void> {
  const note = path.join(root, notePath)
  const metadata = metadataPath(root, notePath)
  await mkdir(path.dirname(note), { recursive: true })
  await mkdir(path.dirname(metadata), { recursive: true })
  await writeFile(note, body)
  await writeFile(metadata, JSON.stringify({ version: 1, createdAt }))
}

async function readMetadata(root: string, notePath: string): Promise<unknown> {
  return JSON.parse(await readFile(metadataPath(root, notePath), 'utf8'))
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    invalidateNoteMetaCache(root)
    invalidateVaultSettingsCache(root)
    await rm(root, { recursive: true, force: true })
  }
  environment.userData = ''
  vi.unstubAllEnvs()
})

describe('portable note creation metadata across desktop vault operations', () => {
  it('reads the portable creation date in both the editor and note list', async () => {
    const root = await makeVault()
    const notePath = 'inbox/Original.md'
    await seedNote(root, notePath)

    const loaded = await readNote(root, notePath)
    const listed = (await listNotes(root)).find(note => note.path === notePath)

    expect(loaded.createdAt).toBe(ORIGINAL_CREATED_AT)
    expect(listed?.createdAt).toBe(ORIGINAL_CREATED_AT)
    expect(loaded.body).toBe(ORIGINAL_BODY)
    expect(await readFile(path.join(root, notePath))).toEqual(Buffer.from(ORIGINAL_BODY))
  })

  it('preserves the creation date and exact Markdown bytes through an atomic save', async () => {
    const root = await makeVault()
    const notePath = 'inbox/Original.md'
    await seedNote(root, notePath)
    const editedBody = '# Café 笔记\r\n\r\nRevised **Markdown**.  \r\n\tIndented 😀\r\n'

    const saved = await writeNote(root, notePath, editedBody)
    const loaded = await readNote(root, notePath)

    expect(saved.createdAt).toBe(ORIGINAL_CREATED_AT)
    expect(loaded.createdAt).toBe(ORIGINAL_CREATED_AT)
    expect(loaded.body).toBe(editedBody)
    expect(await readFile(path.join(root, notePath))).toEqual(Buffer.from(editedBody))
    expect(await readMetadata(root, notePath)).toEqual({ version: 1, createdAt: ORIGINAL_CREATED_AT })
  })

  it('moves the creation metadata with a renamed note', async () => {
    const root = await makeVault()
    const oldPath = 'inbox/Original.md'
    const newPath = 'inbox/Renamed café.md'
    await seedNote(root, oldPath)

    const renamed = await renameNote(root, oldPath, 'Renamed café')

    expect(renamed.path).toBe(newPath)
    expect(renamed.createdAt).toBe(ORIGINAL_CREATED_AT)
    expect((await readNote(root, newPath)).createdAt).toBe(ORIGINAL_CREATED_AT)
    expect(await readFile(path.join(root, newPath))).toEqual(Buffer.from(ORIGINAL_BODY))
    expect(await readMetadata(root, newPath)).toEqual({ version: 1, createdAt: ORIGINAL_CREATED_AT })
    await expect(readFile(metadataPath(root, oldPath))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('moves every nested creation date when its folder is renamed', async () => {
    const root = await makeVault()
    const first = 'inbox/Research/Original.md'
    const nested = 'inbox/Research/Subfolder/Second.md'
    const neighbour = 'inbox/Unrelated.md'
    await seedNote(root, first)
    await seedNote(root, nested, ORIGINAL_CREATED_AT + 1000)
    await seedNote(root, neighbour, ORIGINAL_CREATED_AT + 2000)

    await renameFolder(root, 'inbox', 'Research', 'Projects/Research')

    for (const [oldPath, createdAt] of [
      [first, ORIGINAL_CREATED_AT],
      [nested, ORIGINAL_CREATED_AT + 1000]
    ] as const) {
      const newPath = oldPath.replace('inbox/Research/', 'inbox/Projects/Research/')
      expect((await readNote(root, newPath)).createdAt).toBe(createdAt)
      expect(await readMetadata(root, newPath)).toEqual({ version: 1, createdAt })
      expect(await readFile(path.join(root, newPath))).toEqual(Buffer.from(ORIGINAL_BODY))
      await expect(readFile(metadataPath(root, oldPath))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect((await readNote(root, neighbour)).createdAt).toBe(ORIGINAL_CREATED_AT + 2000)
    expect(await readMetadata(root, neighbour)).toEqual({ version: 1, createdAt: ORIGINAL_CREATED_AT + 2000 })
  })

  it('preserves the creation date through remapped Trash and restore', async () => {
    const root = await makeVault()
    const originalPath = 'Notes/Projects/Original.md'
    const trashPath = 'Deleted notes/Projects/Original.md'
    await seedNote(root, originalPath)
    const settings = await getVaultSettings(root)
    await setVaultSettings(root, {
      ...settings,
      primaryNotesLocation: 'inbox',
      systemFolderPaths: { inbox: 'Notes', trash: 'Deleted notes' }
    })

    const trashed = await moveToTrash(root, originalPath)

    expect(trashed.path).toBe(trashPath)
    expect(trashed.createdAt).toBe(ORIGINAL_CREATED_AT)
    expect(await readMetadata(root, trashPath)).toEqual({ version: 1, createdAt: ORIGINAL_CREATED_AT })
    await expect(readFile(metadataPath(root, originalPath))).rejects.toMatchObject({ code: 'ENOENT' })

    const restored = await restoreFromTrash(root, trashed.path)

    expect(restored.path).toBe(originalPath)
    expect(restored.createdAt).toBe(ORIGINAL_CREATED_AT)
    expect((await readNote(root, originalPath)).body).toBe(ORIGINAL_BODY)
    expect(await readMetadata(root, originalPath)).toEqual({ version: 1, createdAt: ORIGINAL_CREATED_AT })
    await expect(readFile(metadataPath(root, trashPath))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('moves and trashes a note onto stale destination dates, keeping its own (#839)', async () => {
    const root = await makeVault()
    await seedNote(root, 'inbox/Original.md')
    const stale = JSON.stringify({ version: 1, createdAt: ORIGINAL_CREATED_AT + 1000 })
    for (const leftover of ['inbox/Work/Original.md', 'trash/Work/Original.md']) {
      await mkdir(path.dirname(metadataPath(root, leftover)), { recursive: true })
      await writeFile(metadataPath(root, leftover), stale)
    }

    const moved = await moveNote(root, 'inbox/Original.md', 'inbox', 'Work')
    const trashed = await moveToTrash(root, moved.path)

    expect(moved.path).toBe('inbox/Work/Original.md')
    expect(moved.createdAt).toBe(ORIGINAL_CREATED_AT)
    expect(trashed.path).toBe('trash/Work/Original.md')
    expect(trashed.createdAt).toBe(ORIGINAL_CREATED_AT)
    expect(await readMetadata(root, trashed.path)).toEqual({ version: 1, createdAt: ORIGINAL_CREATED_AT })
    await expect(readFile(metadataPath(root, moved.path))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes creation metadata on permanent deletion so a new note cannot inherit the old date', async () => {
    const root = await makeVault()
    const notePath = 'inbox/Original.md'
    await seedNote(root, notePath)

    await deleteNote(root, notePath)

    await expect(readFile(path.join(root, notePath))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(metadataPath(root, notePath))).rejects.toMatchObject({ code: 'ENOENT' })
    const beforeCreate = Date.now() - 1000
    const recreated = await createNote(root, 'inbox', 'Original')
    expect(recreated.path).toBe(notePath)
    expect(recreated.createdAt).not.toBe(ORIGINAL_CREATED_AT)
    expect(recreated.createdAt).toBeGreaterThanOrEqual(beforeCreate)
    expect(recreated.createdAt).toBeLessThanOrEqual(Date.now() + 1000)
    expect((await readNote(root, notePath)).createdAt).toBe(recreated.createdAt)
  })

  it.each([
    ['malformed JSON', '{"version":'],
    ['unsupported version', JSON.stringify({ version: 2, createdAt: ORIGINAL_CREATED_AT })],
    ['missing creation date', JSON.stringify({ version: 1 })],
    ['nonpositive creation date', JSON.stringify({ version: 1, createdAt: 0 })],
    ['fractional creation date', JSON.stringify({ version: 1, createdAt: 1234.5 })],
    ['string creation date', JSON.stringify({ version: 1, createdAt: String(ORIGINAL_CREATED_AT) })]
  ])('fails a save before changing Markdown when creation metadata contains %s', async (_label, corruptMetadata) => {
    const root = await makeVault()
    const notePath = 'inbox/Original.md'
    await seedNote(root, notePath)
    await writeFile(metadataPath(root, notePath), corruptMetadata)

    await expect(writeNote(root, notePath, '# This save must fail\n')).rejects.toThrow()

    expect(await readFile(path.join(root, notePath))).toEqual(Buffer.from(ORIGINAL_BODY))
    expect(await readFile(metadataPath(root, notePath), 'utf8')).toBe(corruptMetadata)
  })
})


const vaultClients = [
  ['desktop', { readNote, writeNote, renameNote, renameFolder }],
  ['MCP', mcpVault]
] as const

describe.each(vaultClients)('%s creation metadata safety', (_name, client) => {
  it.each(['sidecar', 'metadata directory'] as const)(
    'does not trust or write through an external %s symlink',
    async kind => {
      const root = await makeVault()
      const outside = await mkdtemp(path.join(os.tmpdir(), 'zn-external-metadata-'))
      roots.push(outside)
      const notePath = 'inbox/Original.md'
      await seedNote(root, notePath)
      const outsideMetadata = path.join(outside, 'inbox', 'Original.md.metadata.json')
      const outsideBytes = JSON.stringify({ version: 1, createdAt: ORIGINAL_CREATED_AT })
      await mkdir(path.dirname(outsideMetadata), { recursive: true })
      await writeFile(outsideMetadata, outsideBytes)
      const linkPath = kind === 'sidecar'
        ? metadataPath(root, notePath)
        : path.join(root, '.zennotes', 'note-metadata')
      const linkTarget = kind === 'sidecar' ? outsideMetadata : outside
      await rm(linkPath, { force: true, recursive: kind === 'metadata directory' })
      await symlink(linkTarget, linkPath, kind === 'sidecar' ? 'file' : 'dir')
      const native = await stat(path.join(root, notePath))
      const nativeCreatedAt = Math.trunc(native.birthtimeMs || native.ctimeMs)

      const loaded = await client.readNote(root, notePath)

      expect(Math.trunc(loaded.createdAt)).toBe(nativeCreatedAt)
      expect(loaded.createdAt).not.toBe(ORIGINAL_CREATED_AT)
      expect(loaded.body).toBe(ORIGINAL_BODY)
      await expect(client.writeNote(root, notePath, '# Must not escape\n')).rejects.toThrow(/metadata|symlink/i)
      expect(await readFile(path.join(root, notePath))).toEqual(Buffer.from(ORIGINAL_BODY))
      expect(await readFile(outsideMetadata, 'utf8')).toBe(outsideBytes)
      expect(await readlink(linkPath)).toBe(linkTarget)
    }
  )

  // A date left behind by a note that was moved or deleted outside ZenNotes
  // belongs to nobody. Refusing the rename over it blocked that name for good
  // (#839); creating a note there already discards it.
  it('renames a note onto a stale destination date, keeping its own date', async () => {
    const root = await makeVault()
    const sourcePath = 'inbox/Original.md'
    const targetPath = 'inbox/Destination.md'
    await seedNote(root, sourcePath)
    const orphanDate = ORIGINAL_CREATED_AT + 1000
    await writeFile(metadataPath(root, targetPath), JSON.stringify({ version: 1, createdAt: orphanDate }))

    await client.renameNote(root, sourcePath, 'Destination')

    expect(await readFile(path.join(root, targetPath), 'utf8')).toContain('Keep **Markdown** and trailing spaces.')
    expect(await readMetadata(root, targetPath)).toEqual({ version: 1, createdAt: ORIGINAL_CREATED_AT })
    expect((await client.readNote(root, targetPath)).createdAt).toBe(ORIGINAL_CREATED_AT)
    await expect(readFile(path.join(root, sourcePath))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(metadataPath(root, sourcePath))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never hands a stale destination date to a renamed note that has none', async () => {
    const root = await makeVault()
    const sourcePath = 'inbox/Original.md'
    const targetPath = 'inbox/Destination.md'
    await mkdir(path.join(root, 'inbox'), { recursive: true })
    await writeFile(path.join(root, sourcePath), ORIGINAL_BODY)
    await mkdir(path.dirname(metadataPath(root, targetPath)), { recursive: true })
    await writeFile(metadataPath(root, targetPath), JSON.stringify({ version: 1, createdAt: ORIGINAL_CREATED_AT }))

    await client.renameNote(root, sourcePath, 'Destination')

    expect(await readFile(path.join(root, targetPath), 'utf8')).toContain('Keep **Markdown** and trailing spaces.')
    expect((await client.readNote(root, targetPath)).createdAt).not.toBe(ORIGINAL_CREATED_AT)
  })

  it('refuses a folder move onto an orphan metadata tree without moving the source', async () => {
    const root = await makeVault()
    const sourcePath = 'inbox/Research/Subfolder/Original.md'
    const targetPath = 'inbox/Destination/Subfolder/Original.md'
    await seedNote(root, sourcePath)
    const orphanDate = ORIGINAL_CREATED_AT + 1000
    await mkdir(path.dirname(metadataPath(root, targetPath)), { recursive: true })
    await writeFile(metadataPath(root, targetPath), JSON.stringify({ version: 1, createdAt: orphanDate }))

    await expect(client.renameFolder(root, 'inbox', 'Research', 'Destination')).rejects.toThrow()

    expect(await readFile(path.join(root, sourcePath))).toEqual(Buffer.from(ORIGINAL_BODY))
    expect(await readMetadata(root, sourcePath)).toEqual({ version: 1, createdAt: ORIGINAL_CREATED_AT })
    expect(await readMetadata(root, targetPath)).toEqual({ version: 1, createdAt: orphanDate })
    await expect(stat(path.join(root, 'inbox', 'Destination'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await client.readNote(root, sourcePath)).createdAt).toBe(ORIGINAL_CREATED_AT)
  })
})

describe('creation metadata compatibility between desktop and MCP', () => {
  it('retains a sidecar-free note native creation date at millisecond precision across repeated saves', async () => {
    const root = await makeVault()
    const notePath = 'inbox/Original.md'
    await mkdir(path.join(root, 'inbox'), { recursive: true })
    await writeFile(path.join(root, notePath), ORIGINAL_BODY)
    const native = await stat(path.join(root, notePath))
    const nativeCreatedAt = Math.trunc(native.birthtimeMs || native.ctimeMs)
    expect(Math.trunc((await readNote(root, notePath)).createdAt)).toBe(nativeCreatedAt)
    await expect(readFile(metadataPath(root, notePath))).rejects.toMatchObject({ code: 'ENOENT' })

    for (const body of ['# First save.  \r\n', '# Second café 😀\r\n']) {
      expect((await writeNote(root, notePath, body)).createdAt).toBe(nativeCreatedAt)
      expect((await readNote(root, notePath)).createdAt).toBe(nativeCreatedAt)
      expect((await mcpVault.readNote(root, notePath)).createdAt).toBe(nativeCreatedAt)
      expect(await readFile(path.join(root, notePath))).toEqual(Buffer.from(body))
      expect(await readMetadata(root, notePath)).toEqual({ version: 1, createdAt: nativeCreatedAt })
    }
  })

  it('MCP reads, renames, trashes, and restores the same creation date after a desktop save', async () => {
    const root = await makeVault()
    await writeFile(path.join(environment.userData, 'config.toml'), '[editor]\nsync_title_heading_on_rename = false\n')
    const originalPath = 'inbox/Projects/Original.md'
    await seedNote(root, originalPath)
    const desktopBody = '# Saved by desktop café.  \r\n\r\nUnchanged during moves.\r\n'
    await writeNote(root, originalPath, desktopBody)

    expect((await mcpVault.readNote(root, originalPath)).createdAt).toBe(ORIGINAL_CREATED_AT)
    const renamed = await mcpVault.renameNote(root, originalPath, 'Renamed')
    expect(renamed.path).toBe('inbox/Projects/Renamed.md')
    expect(renamed.createdAt).toBe(ORIGINAL_CREATED_AT)
    expect((await readNote(root, renamed.path)).createdAt).toBe(ORIGINAL_CREATED_AT)
    await expect(readFile(metadataPath(root, originalPath))).rejects.toMatchObject({ code: 'ENOENT' })

    const trashed = await mcpVault.moveToTrash(root, renamed.path)
    expect(trashed.path).toBe('trash/Projects/Renamed.md')
    expect(trashed.createdAt).toBe(ORIGINAL_CREATED_AT)
    expect((await readNote(root, trashed.path)).createdAt).toBe(ORIGINAL_CREATED_AT)
    await expect(readFile(metadataPath(root, renamed.path))).rejects.toMatchObject({ code: 'ENOENT' })

    const restored = await mcpVault.restoreFromTrash(root, trashed.path)
    expect(restored.path).toBe(renamed.path)
    expect(restored.createdAt).toBe(ORIGINAL_CREATED_AT)
    expect((await readNote(root, restored.path)).body).toBe(desktopBody)
    expect(await readMetadata(root, restored.path)).toEqual({ version: 1, createdAt: ORIGINAL_CREATED_AT })
    await expect(readFile(metadataPath(root, trashed.path))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
