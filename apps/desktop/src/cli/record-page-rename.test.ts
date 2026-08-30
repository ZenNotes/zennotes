import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBackend } from './backend'

/**
 * `zn rename` on a note inside a `<Name>.base/` folder moved the file and left
 * the row's `page` pointer dangling (#691). The local backend now follows the
 * rename into the database: the sidecar points at the new file and the title
 * column reads the new name, which is what the app's grid keeps in step from
 * the other direction.
 */
let tmpDir: string
let root: string
let dbDir: string

const schema = {
  version: 1,
  idFieldId: 'f_id',
  fields: [
    { id: 'f_id', name: 'id', type: 'text', hidden: true },
    { id: 'f_name', name: 'Name', type: 'text' },
    { id: 'f_date', name: 'date', type: 'text' }
  ],
  views: [{ id: 'v1', name: 'Table', type: 'table', filters: [], sorts: [] }],
  activeViewId: 'v1',
  pages: { 'row-1': 'old-name.md' }
}

beforeAll(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zen-record-rename-'))
  root = path.join(tmpDir, 'vault')
  dbDir = path.join(root, 'inbox', 'notes-db.base')
  for (const d of ['inbox', 'quick', 'archive', 'trash']) {
    await fsp.mkdir(path.join(root, d), { recursive: true })
  }
  await fsp.mkdir(dbDir, { recursive: true })
  await fsp.writeFile(path.join(dbDir, 'data.csv'), 'id,Name,date\nrow-1,old-name,2026-01-01\n')
  await fsp.writeFile(path.join(dbDir, 'schema.json'), JSON.stringify(schema))
  await fsp.writeFile(path.join(dbDir, 'old-name.md'), '---\ndate: 2026-01-01\n---\n# old-name\n\nbody\n')
  await fsp.writeFile(path.join(root, 'inbox', 'Plain.md'), '# Plain\n')
})

afterAll(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true })
})

describe('LocalBackend.renameNote on a record page (#691)', () => {
  it('moves the file and follows it in the row: page pointer and title cell', async () => {
    const backend = createBackend({ kind: 'local', root })
    const meta = await backend.renameNote('inbox/notes-db.base/old-name.md', 'new-name')
    expect(meta.path).toBe('inbox/notes-db.base/new-name.md')
    await expect(fsp.access(path.join(dbDir, 'old-name.md'))).rejects.toThrow()

    const doc = await backend.databaseOps().openDatabase('inbox/notes-db.base/data.csv')
    expect(doc.pages).toEqual({ 'row-1': 'inbox/notes-db.base/new-name.md' })
    expect(doc.rows[0]?.cells.f_name).toBe('new-name')
    expect(doc.rows[0]?.cells.f_date).toBe('2026-01-01')
    // The sidecar on disk keeps its relative form.
    const onDisk = JSON.parse(await fsp.readFile(path.join(dbDir, 'schema.json'), 'utf8')) as {
      pages?: Record<string, string>
    }
    expect(onDisk.pages).toEqual({ 'row-1': 'new-name.md' })
  })

  it('leaves a plain note rename alone', async () => {
    const backend = createBackend({ kind: 'local', root })
    const meta = await backend.renameNote('inbox/Plain.md', 'Plainer')
    expect(meta.path).toBe('inbox/Plainer.md')
    const doc = await backend.databaseOps().openDatabase('inbox/notes-db.base/data.csv')
    expect(doc.pages).toEqual({ 'row-1': 'inbox/notes-db.base/new-name.md' })
  })

  it('still renames a page whose database cannot be read', async () => {
    const strayDir = path.join(root, 'inbox', 'broken.base')
    await fsp.mkdir(strayDir, { recursive: true })
    await fsp.writeFile(path.join(strayDir, 'Loose.md'), '# Loose\n')
    const backend = createBackend({ kind: 'local', root })
    const meta = await backend.renameNote('inbox/broken.base/Loose.md', 'Looser')
    expect(meta.path).toBe('inbox/broken.base/Looser.md')
  })
})
