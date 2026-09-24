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

import * as desktop from './vault'
import * as mcp from '../mcp/vault-ops'

const roots: string[] = []

async function makeVault(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zn-note-sidecars-'))
  roots.push(root)
  environment.userData = path.join(root, '.test-app')
  await mkdir(environment.userData, { recursive: true })
  vi.stubEnv('ZENNOTES_USER_DATA_PATH', environment.userData)
  vi.stubEnv('ZENNOTES_CONFIG_DIR', environment.userData)
  return root
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    desktop.invalidateNoteMetaCache(root)
    desktop.invalidateVaultSettingsCache(root)
    await rm(root, { recursive: true, force: true })
  }
  environment.userData = ''
  vi.unstubAllEnvs()
})

function comment(notePath: string, body: string) {
  return { notePath, anchorStart: 0, anchorEnd: 0, anchorText: '', id: body, body, createdAt: 1, updatedAt: 1 }
}

function commentsFile(root: string, notePath: string): string {
  return path.join(root, '.zennotes', 'comments', `${notePath}.comments.json`)
}

async function missing(abs: string): Promise<boolean> {
  return stat(abs).then(
    () => false,
    (error: NodeJS.ErrnoException) => error.code === 'ENOENT'
  )
}

// The desktop and the MCP server move notes through the same shared core
// (note-sidecars.ts), so they must agree on where a note's discussion goes.
// Before, the MCP server moved the Markdown alone and left the comments at
// the old name, where the next note given that name took them over.
const clients = [
  ['desktop', desktop],
  ['MCP', mcp]
] as const

describe.each(clients)('%s: a note keeps its comments', (_name, client) => {
  async function seed(root: string, notePath: string): Promise<void> {
    await mkdir(path.dirname(path.join(root, notePath)), { recursive: true })
    await client.writeNote(root, notePath, '# Note\n\nBody.\n')
    await client.writeNoteComments(root, notePath, [comment(notePath, 'Keep this discussion')])
  }

  it('through a rename', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/One.md')

    await client.renameNote(root, 'inbox/One.md', 'Two')

    expect((await client.readNoteComments(root, 'inbox/Two.md')).map((c) => c.body)).toEqual(['Keep this discussion'])
    expect(await missing(commentsFile(root, 'inbox/One.md'))).toBe(true)
  })

  it('through a move to another folder', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/One.md')

    const moved = await client.moveNote(root, 'inbox/One.md', 'inbox', 'Work')

    expect(moved.path).toBe('inbox/Work/One.md')
    expect((await client.readNoteComments(root, moved.path)).map((c) => c.body)).toEqual(['Keep this discussion'])
    expect(await missing(commentsFile(root, 'inbox/One.md'))).toBe(true)
  })

  it('through Trash and back', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/One.md')

    const trashed = await client.moveToTrash(root, 'inbox/One.md')
    expect((await client.readNoteComments(root, trashed.path)).map((c) => c.body)).toEqual(['Keep this discussion'])
    const restored = await client.restoreFromTrash(root, trashed.path)

    expect(restored.path).toBe('inbox/One.md')
    expect((await client.readNoteComments(root, restored.path)).map((c) => c.body)).toEqual(['Keep this discussion'])
    expect(await missing(commentsFile(root, trashed.path))).toBe(true)
  })

  it('through a folder rename', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/Work/One.md')

    await client.renameFolder(root, 'inbox', 'Work', 'Projects')

    expect((await client.readNoteComments(root, 'inbox/Projects/One.md')).map((c) => c.body)).toEqual(['Keep this discussion'])
    expect(await missing(commentsFile(root, 'inbox/Work/One.md'))).toBe(true)
  })

  it('refuses a rename onto an earlier note’s comments, and names the file', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/One.md')
    await client.writeNoteComments(root, 'inbox/Two.md', [comment('inbox/Two.md', 'An earlier discussion')])

    await expect(client.renameNote(root, 'inbox/One.md', 'Two')).rejects.toThrow(
      'Comments from an earlier note named “Two” are still in .zennotes/comments/inbox/Two.md.comments.json'
    )

    expect(await readFile(path.join(root, 'inbox/One.md'), 'utf8')).toContain('Body.')
    expect((await client.readNoteComments(root, 'inbox/One.md')).map((c) => c.body)).toEqual(['Keep this discussion'])
    expect((await client.readNoteComments(root, 'inbox/Two.md')).map((c) => c.body)).toEqual(['An earlier discussion'])
  })

  it('and a deleted note takes them with it, so a new note of that name starts clean', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/One.md')

    await client.deleteNote(root, 'inbox/One.md')
    await client.writeNote(root, 'inbox/One.md', '# One again\n')

    expect(await client.readNoteComments(root, 'inbox/One.md')).toEqual([])
  })

  it('Empty Trash takes the trashed notes’ comments', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/One.md')
    const trashed = await client.moveToTrash(root, 'inbox/One.md')
    expect(await missing(commentsFile(root, trashed.path))).toBe(false)

    await client.emptyTrash(root)

    expect(await missing(commentsFile(root, trashed.path))).toBe(true)
  })

  it('a note that is a relative link keeps pointing at its file when moved deeper', async () => {
    const root = await makeVault()
    // Inside inbox, so the vault stays in its default layout.
    await mkdir(path.join(root, 'inbox', 'sources'), { recursive: true })
    await writeFile(path.join(root, 'inbox', 'sources', 'Real.md'), '# Real\n\nElsewhere.\n')
    await symlink('sources/Real.md', path.join(root, 'inbox', 'Rel.md'))

    const moved = await client.moveNote(root, 'inbox/Rel.md', 'inbox', 'Topics')

    // Moved verbatim, `sources/Real.md` from inbox/Topics would name nothing.
    expect(moved.path).toBe('inbox/Topics/Rel.md')
    expect(await readlink(path.join(root, 'inbox', 'Topics', 'Rel.md'))).toBe(path.join('..', 'sources', 'Real.md'))
    expect(await readFile(path.join(root, 'inbox', 'Topics', 'Rel.md'), 'utf8')).toBe('# Real\n\nElsewhere.\n')
  })

  it('deleting a folder takes its notes’ comments', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/Work/One.md')
    await writeFile(path.join(root, 'inbox/Keep.md'), '# Keep\n')

    await client.deleteFolder(root, 'inbox', 'Work')

    expect(await missing(commentsFile(root, 'inbox/Work/One.md'))).toBe(true)
    expect(await readFile(path.join(root, 'inbox/Keep.md'), 'utf8')).toBe('# Keep\n')
  })
})
