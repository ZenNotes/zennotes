import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  archiveNote,
  listAssets,
  listNotes,
  listSoftDeleted,
  moveToTrash,
  readPrimaryNotesLocation,
  restoreFromTrash,
  scanAllTasks,
  searchText,
  toggleTask,
  unarchiveNote
} from './vault-ops'

const roots: string[] = []

async function makeVault(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  roots.push(root)
  await fs.mkdir(path.join(root, 'inbox'), { recursive: true })
  await fs.mkdir(path.join(root, 'quick'), { recursive: true })
  await fs.mkdir(path.join(root, 'archive'), { recursive: true })
  await fs.mkdir(path.join(root, 'trash'), { recursive: true })
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('vault-ops layout and assets', () => {
  it('treats assets/ as a system folder, not root-mode note content', async () => {
    const root = await makeVault('zennotes-mcp-layout-')
    await fs.mkdir(path.join(root, 'assets'), { recursive: true })
    await fs.writeFile(path.join(root, 'assets', 'photo.png'), 'png', 'utf8')
    await fs.writeFile(path.join(root, 'loose.pdf'), 'pdf', 'utf8')
    await fs.mkdir(path.join(root, 'trash', '00000000-0000-0000-0000-000000000000'), {
      recursive: true
    })
    await fs.writeFile(
      path.join(root, 'trash', '00000000-0000-0000-0000-000000000000', 'hidden.png'),
      'png',
      'utf8'
    )
    await fs.writeFile(path.join(root, 'inbox', 'A.md'), '# A\n', 'utf8')

    expect(await readPrimaryNotesLocation(root)).toBe('inbox')
    expect((await listNotes(root)).map((note) => note.path)).toEqual(['inbox/A.md'])
    expect((await listAssets(root)).map((asset) => asset.path).sort()).toEqual([
      'assets/photo.png',
      'loose.pdf'
    ])
  })
})

describe('vault-ops soft-delete note wrappers', () => {
  it('soft-deletes to a handle and restores to the original path', async () => {
    const root = await makeVault('zennotes-mcp-trash-')
    await fs.mkdir(path.join(root, 'inbox', 'demo'), { recursive: true })
    await fs.writeFile(path.join(root, 'inbox', 'demo', 'Tables.md'), '# Tables\n', 'utf8')

    const handle = await moveToTrash(root, 'inbox/demo/Tables.md')
    const [, id] = handle.split('/')

    expect(handle).toMatch(/^trash\//)
    await expect(fs.readFile(path.join(root, 'trash', id, 'Tables.md'), 'utf8')).resolves.toBe(
      '# Tables\n'
    )
    expect((await listNotes(root)).map((note) => note.path)).not.toContain('trash/' + id + '/Tables.md')
    expect(await listSoftDeleted(root)).toEqual([
      expect.objectContaining({
        handle,
        top: 'trash',
        kind: 'note',
        name: 'Tables.md',
        originalRel: 'inbox/demo/Tables.md'
      })
    ])

    const restored = await restoreFromTrash(root, handle)
    expect(restored.path).toBe('inbox/demo/Tables.md')
    await expect(fs.readFile(path.join(root, 'inbox', 'demo', 'Tables.md'), 'utf8')).resolves.toBe(
      '# Tables\n'
    )
    expect(await listSoftDeleted(root)).toEqual([])
  })

  it('hides archived wrapper contents from live note search', async () => {
    const root = await makeVault('zennotes-mcp-archive-')
    await fs.writeFile(path.join(root, 'inbox', 'Needle.md'), '# Needle\n\nhidden needle\n', 'utf8')

    const handle = await archiveNote(root, 'inbox/Needle.md')

    expect(await searchText(root, 'hidden needle')).toEqual([])
    expect(await listSoftDeleted(root)).toEqual([
      expect.objectContaining({
        handle,
        top: 'archive',
        kind: 'note',
        name: 'Needle.md',
        originalRel: 'inbox/Needle.md'
      })
    ])
    expect((await listNotes(root)).map((note) => note.path)).not.toContain(
      `${handle}/Needle.md`
    )

    const restored = await unarchiveNote(root, handle)
    expect(restored.path).toBe('inbox/Needle.md')
  })
})

describe('vault-ops tasks', () => {
  it('parses and toggles the same task syntaxes as shared tasklists', async () => {
    const root = await makeVault('zennotes-mcp-tasks-')
    const rel = 'inbox/Tasks.md'
    await fs.writeFile(
      path.join(root, rel),
      ['# Tasks', '', '1. [ ] Ordered #work', '> - [ ] Quoted', '- [x] Done', ''].join('\n'),
      'utf8'
    )

    const tasks = await scanAllTasks(root)

    expect(tasks.map((task) => task.content)).toEqual(['Ordered #work', 'Quoted', 'Done'])
    expect(tasks.map((task) => task.id)).toEqual([`${rel}#0`, `${rel}#1`, `${rel}#2`])
    expect(tasks[0].tags).toEqual(['work'])

    const toggled = await toggleTask(root, `${rel}#0`)

    expect(toggled?.checked).toBe(true)
    await expect(fs.readFile(path.join(root, rel), 'utf8')).resolves.toContain(
      '1. [x] Ordered #work'
    )
  })
})
