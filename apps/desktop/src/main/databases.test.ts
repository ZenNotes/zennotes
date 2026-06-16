import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createDatabase,
  createRecordPage,
  readDatabase,
  renameDatabase,
  writeDatabaseRows
} from './databases'

const tmpDirs: string[] = []
async function makeVault(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zennotes-db-'))
  tmpDirs.push(dir)
  await mkdir(path.join(dir, 'inbox'), { recursive: true })
  return dir
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('createDatabase + readDatabase', () => {
  it('creates a .base folder (data.csv + schema.json) and reads it back', async () => {
    const root = await makeVault()
    const doc = await createDatabase(root, 'inbox', '', 'Projects')
    expect(doc.path).toBe('inbox/Projects.base/data.csv')
    expect(doc.title).toBe('Projects')
    expect(doc.fields.map((f) => f.name)).toEqual(['id', 'Name'])
    expect(doc.rows).toEqual([])
    expect(doc.views).toHaveLength(1)

    // both files exist inside the .base folder on disk
    await expect(readFile(path.join(root, doc.path), 'utf8')).resolves.toContain('id,Name')
    const sidecar = JSON.parse(
      await readFile(path.join(root, 'inbox/Projects.base/schema.json'), 'utf8')
    )
    expect(sidecar.version).toBe(1)
    expect(sidecar.fields).toHaveLength(2)

    // re-open yields the same shape
    const reopened = await readDatabase(root, doc.path)
    expect(reopened.idFieldId).toBe(doc.idFieldId)
  })

  it('avoids filename collisions', async () => {
    const root = await makeVault()
    const a = await createDatabase(root, 'inbox', '', 'Notes')
    const b = await createDatabase(root, 'inbox', '', 'Notes')
    expect(a.path).not.toBe(b.path)
  })
})

describe('writeDatabaseRows round-trip', () => {
  it('persists rows (incl. embedded commas) and reads them back', async () => {
    const root = await makeVault()
    const doc = await createDatabase(root, 'inbox', '', 'Tasks')
    const idField = doc.fields.find((f) => f.id === doc.idFieldId)!
    const nameField = doc.fields.find((f) => f.name === 'Name')!

    const written = await writeDatabaseRows(root, doc.path, [
      { id: 'r1', cells: { [idField.id]: 'r1', [nameField.id]: 'Alpha, with comma' } },
      { id: 'r2', cells: { [idField.id]: 'r2', [nameField.id]: 'Beta' } }
    ])
    expect(written.rows).toHaveLength(2)

    const reread = await readDatabase(root, doc.path)
    expect(reread.rows.map((r) => r.cells[nameField.id])).toEqual(['Alpha, with comma', 'Beta'])
    expect(reread.rows.map((r) => r.id)).toEqual(['r1', 'r2'])
  })
})

describe('createRecordPage', () => {
  it('creates a record-page note inside the database .base folder', async () => {
    const root = await makeVault()
    const doc = await createDatabase(root, 'inbox', '', 'Projects')
    const noteRel = await createRecordPage(
      root,
      doc.path,
      'My Task',
      '---\nName: My Task\n---\n# My Task\n'
    )
    expect(noteRel).toBe('inbox/Projects.base/My Task.md') // record pages live in the .base folder
    await expect(readFile(path.join(root, noteRel), 'utf8')).resolves.toContain('# My Task')
  })
})

describe('renameDatabase', () => {
  it('renames the .base folder, preserving data, schema, and record pages', async () => {
    const root = await makeVault()
    const doc = await createDatabase(root, 'inbox', '', 'Old')
    await createRecordPage(root, doc.path, 'Rec', '# Rec')

    const newPath = await renameDatabase(root, doc.path, 'New Name')
    expect(newPath).toBe('inbox/New Name.base/data.csv')

    const reopened = await readDatabase(root, newPath)
    expect(reopened.title).toBe('New Name')
    // The record page moved with the folder.
    await expect(
      readFile(path.join(root, 'inbox/New Name.base/Rec.md'), 'utf8')
    ).resolves.toContain('# Rec')
    // The old folder is gone.
    await expect(readFile(path.join(root, 'inbox/Old.base/data.csv'), 'utf8')).rejects.toThrow()
  })
})

describe('adopting a plain CSV (no sidecar)', () => {
  it('infers schema, materializes the sidecar + stable ids, and is stable on re-read', async () => {
    const root = await makeVault()
    await writeFile(
      path.join(root, 'inbox/people.csv'),
      'Name,Age,Active\nAda,36,true\nGrace,40,false\n',
      'utf8'
    )

    const doc = await readDatabase(root, 'inbox/people.csv')
    const byName = new Map(doc.fields.map((f) => [f.name, f]))
    expect(byName.get('Age')!.type).toBe('number')
    expect(byName.get('Active')!.type).toBe('checkbox')
    expect(doc.rows).toHaveLength(2)

    // sidecar was materialized
    await expect(
      readFile(path.join(root, 'inbox/people.csv.base.json'), 'utf8')
    ).resolves.toContain('"version": 1')

    // ids are stable across re-read (the CSV gained an id column)
    const firstIds = doc.rows.map((r) => r.id)
    const reread = await readDatabase(root, 'inbox/people.csv')
    expect(reread.rows.map((r) => r.id)).toEqual(firstIds)
    expect(firstIds.every((id) => id.length > 0)).toBe(true)
  })
})
