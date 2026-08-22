import { mkdtemp, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The OS trash is the only Electron surface this path touches; the mock moves
// the file aside so "gone from the folder" and "still recoverable" both hold.
const trashItem = vi.fn(async (abs: string) => {
  await rename(abs, `${abs}.in-system-trash`)
})
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), isPackaged: false },
  shell: { trashItem: (abs: string) => trashItem(abs) }
}))

const { ensureVaultLayout, listNotes, trashNoteToSystem } = await import('./vault')

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  trashItem.mockClear()
})

describe('trashNoteToSystem (temporary folder sessions, #650)', () => {
  it('hands the note to the OS trash without growing a trash folder in the session', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'zen-ephemeral-'))
    roots.push(root)
    await ensureVaultLayout(root)
    await mkdir(path.join(root, 'quick'), { recursive: true })
    await writeFile(path.join(root, 'quick', 'Scratch.md'), '# Scratch\n\n#todo later\n')

    const meta = await trashNoteToSystem(root, 'quick/Scratch.md')

    expect(trashItem).toHaveBeenCalledWith(path.join(root, 'quick', 'Scratch.md'))
    expect(meta.title).toBe('Scratch')
    expect(meta.folder).toBe('quick')
    expect(meta.tags).toContain('todo')
    const entries = await readdir(path.join(root, 'quick'))
    expect(entries).toEqual(['Scratch.md.in-system-trash'])
    const notes = await listNotes(root)
    expect(notes.map((n) => n.path)).not.toContain('quick/Scratch.md')
  })

  it('refuses paths that escape the session folder', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'zen-ephemeral-'))
    roots.push(root)
    await ensureVaultLayout(root)
    await expect(trashNoteToSystem(root, '../outside.md')).rejects.toThrow()
    expect(trashItem).not.toHaveBeenCalled()
  })
})
