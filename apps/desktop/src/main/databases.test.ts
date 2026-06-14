import { access, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createDatabase,
  createRecordPage,
  deleteDatabase,
  readDatabase,
  renameDatabase,
  softDeleteDatabase,
  listDatabases,
  writeDatabaseRows
} from './databases'
import { listSoftDeleted, moveFolderTo, purgeSoftDeleted, restoreSoftDeleted } from './vault'

const exists = async (abs: string): Promise<boolean> =>
  access(abs).then(
    () => true,
    () => false
  )

// A form lives in a `<Name>.base/` folder; these resolve its fixed members.
const schemaAbs = (root: string, formDirRel: string): string =>
  path.join(root, formDirRel, 'schema.json')

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

    // the folder contents exist on disk
    await expect(readFile(path.join(root, doc.path), 'utf8')).resolves.toContain('id,Name')
    const sidecar = JSON.parse(await readFile(schemaAbs(root, 'inbox/Projects.base'), 'utf8'))
    expect(sidecar.version).toBe(1)
    expect(sidecar.fields).toHaveLength(2)
    // the (empty) pages folder is created up front
    expect(await exists(path.join(root, 'inbox/Projects.base/pages'))).toBe(true)

    // re-open yields the same shape
    const reopened = await readDatabase(root, doc.path)
    expect(reopened.idFieldId).toBe(doc.idFieldId)
  })

  it('avoids folder collisions', async () => {
    const root = await makeVault()
    const a = await createDatabase(root, 'inbox', '', 'Notes')
    const b = await createDatabase(root, 'inbox', '', 'Notes')
    expect(a.path).toBe('inbox/Notes.base/data.csv')
    expect(b.path).toBe('inbox/Notes 2.base/data.csv')
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
  it('creates a page note inside the form pages/ folder', async () => {
    const root = await makeVault()
    const doc = await createDatabase(root, 'inbox', '', 'Projects')
    const noteRel = await createRecordPage(
      root,
      doc.path,
      'My Task',
      '---\nName: My Task\n---\n# My Task\n'
    )
    expect(noteRel).toBe('inbox/Projects.base/pages/My Task.md')
    await expect(readFile(path.join(root, noteRel), 'utf8')).resolves.toContain('# My Task')
  })
})

describe('deleteDatabase', () => {
  it('removes the entire .base folder (data, schema, and record pages)', async () => {
    const root = await makeVault()
    const doc = await createDatabase(root, 'inbox', '', 'Projects')
    await createRecordPage(root, doc.path, 'My Task', '# My Task\n')

    expect(await exists(path.join(root, 'inbox/Projects.base'))).toBe(true)

    await deleteDatabase(root, doc.path)

    expect(await exists(path.join(root, 'inbox/Projects.base'))).toBe(false)
  })
})

describe('renameDatabase', () => {
  it('renames just the .base folder; relative page paths need no rewrite', async () => {
    const root = await makeVault()
    const doc = await createDatabase(root, 'inbox', '', 'Projects')
    await createRecordPage(root, doc.path, 'My Task', '# My Task\n')
    // Link the page in the sidecar (stored RELATIVE to the form folder).
    const sidecarPath = schemaAbs(root, 'inbox/Projects.base')
    const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8'))
    sidecar.pages = { r1: 'pages/My Task.md' }
    await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2), 'utf8')

    const newCsv = await renameDatabase(root, doc.path, 'Roadmap')
    expect(newCsv).toBe('inbox/Roadmap.base/data.csv')

    // Old folder gone, new folder present with everything inside.
    expect(await exists(path.join(root, 'inbox/Projects.base'))).toBe(false)
    expect(await exists(path.join(root, newCsv))).toBe(true)
    expect(await exists(schemaAbs(root, 'inbox/Roadmap.base'))).toBe(true)
    expect(await exists(path.join(root, 'inbox/Roadmap.base/pages/My Task.md'))).toBe(true)

    // On disk the page path stays relative (no rewriting); readDatabase resolves
    // it to a full vault-relative path.
    const moved = JSON.parse(await readFile(schemaAbs(root, 'inbox/Roadmap.base'), 'utf8'))
    expect(moved.pages.r1).toBe('pages/My Task.md')
    const reopened = await readDatabase(root, newCsv)
    expect(reopened.pages?.r1).toBe('inbox/Roadmap.base/pages/My Task.md')
  })

  it('refuses to clobber an existing form at the target name', async () => {
    const root = await makeVault()
    const a = await createDatabase(root, 'inbox', '', 'Alpha')
    await createDatabase(root, 'inbox', '', 'Beta')
    await expect(renameDatabase(root, a.path, 'Beta')).rejects.toThrow(/already exists/)
    // The original is untouched.
    expect(await exists(path.join(root, a.path))).toBe(true)
  })
})

describe('soft-delete + restore (forms)', () => {
  it('moves a form into a UUID wrapper in trash, records meta, and hides it from listDatabases', async () => {
    const root = await makeVault()
    const doc = await createDatabase(root, 'inbox', '', 'Projects')
    await createRecordPage(root, doc.path, 'My Task', '# My Task\n')

    await softDeleteDatabase(root, doc.path, 'trash')

    // Original gone; the whole folder now lives inside a UUID wrapper.
    expect(await exists(path.join(root, 'inbox/Projects.base'))).toBe(false)
    const entries = await listSoftDeleted(root)
    expect(entries).toHaveLength(1)
    const entry = entries[0]
    expect(entry).toMatchObject({
      kind: 'database',
      top: 'trash',
      name: 'Projects.base',
      originalRel: 'inbox/Projects.base',
      title: 'Projects'
    })
    const wrapper = path.join(root, entry.top, entry.id, entry.name)
    expect(await exists(path.join(wrapper, 'data.csv'))).toBe(true)
    expect(await exists(path.join(wrapper, 'schema.json'))).toBe(true)
    expect(await exists(path.join(wrapper, 'pages/My Task.md'))).toBe(true)
    expect((await listDatabases(root)).some((d) => d.title === 'Projects')).toBe(false)
  })

  it('restores a trashed form to its original location with record pages intact', async () => {
    const root = await makeVault()
    const doc = await createDatabase(root, 'inbox', '', 'Projects')
    await createRecordPage(root, doc.path, 'My Task', '# My Task\n')
    await softDeleteDatabase(root, doc.path, 'trash')
    const [entry] = await listSoftDeleted(root)

    await restoreSoftDeleted(root, `${entry.top}/${entry.id}`)

    expect(await exists(path.join(root, 'inbox/Projects.base/data.csv'))).toBe(true)
    expect(await exists(path.join(root, 'inbox/Projects.base/pages/My Task.md'))).toBe(true)
    expect(await listSoftDeleted(root)).toHaveLength(0)
    expect((await listDatabases(root)).some((d) => d.title === 'Projects')).toBe(true)
  })

  it('archived forms are skipped by listDatabases but restorable', async () => {
    const root = await makeVault()
    const doc = await createDatabase(root, 'inbox', '', 'Archived')
    await softDeleteDatabase(root, doc.path, 'archive')
    expect((await listDatabases(root)).some((d) => d.title === 'Archived')).toBe(false)
    const [entry] = await listSoftDeleted(root)
    expect(entry.top).toBe('archive')

    await restoreSoftDeleted(root, `${entry.top}/${entry.id}`)
    expect(await exists(path.join(root, 'inbox/Archived.base/data.csv'))).toBe(true)
    expect((await listDatabases(root)).some((d) => d.title === 'Archived')).toBe(true)
  })

  it('permanently purges a trashed form and drops its meta entry', async () => {
    const root = await makeVault()
    const doc = await createDatabase(root, 'inbox', '', 'Doomed')
    await softDeleteDatabase(root, doc.path, 'trash')
    const [entry] = await listSoftDeleted(root)
    await purgeSoftDeleted(root, `${entry.top}/${entry.id}`)
    expect(await exists(path.join(root, 'trash', entry.id))).toBe(false)
    expect(await listSoftDeleted(root)).toHaveLength(0)
  })

  it('two same-named trashed forms never collide (UUID wrappers)', async () => {
    const root = await makeVault()
    const a = await createDatabase(root, 'inbox', '', 'Dup')
    await softDeleteDatabase(root, a.path, 'trash')
    const b = await createDatabase(root, 'inbox', '', 'Dup')
    await softDeleteDatabase(root, b.path, 'trash')
    const entries = await listSoftDeleted(root)
    expect(entries).toHaveLength(2)
    expect(entries.every((e) => e.title === 'Dup' && e.name === 'Dup.base')).toBe(true)
    expect(new Set(entries.map((e) => e.id)).size).toBe(2)
    for (const e of entries) {
      expect(await exists(path.join(root, e.top, e.id, e.name, 'data.csv'))).toBe(true)
    }
  })
})

describe('soft-delete + restore (folders)', () => {
  it('moves a folder into a UUID wrapper in trash and restores it to its origin', async () => {
    const root = await makeVault()
    await mkdir(path.join(root, 'inbox/Work'), { recursive: true })
    await writeFile(path.join(root, 'inbox/Work/note.md'), '# hi\n', 'utf8')

    await moveFolderTo(root, 'inbox', 'Work', 'trash')
    expect(await exists(path.join(root, 'inbox/Work'))).toBe(false)

    const entries = await listSoftDeleted(root)
    expect(entries).toHaveLength(1)
    const entry = entries[0]
    expect(entry).toMatchObject({
      kind: 'folder',
      top: 'trash',
      name: 'Work',
      originalRel: 'inbox/Work',
      title: 'Work'
    })
    expect(await exists(path.join(root, entry.top, entry.id, 'Work/note.md'))).toBe(true)

    await restoreSoftDeleted(root, `${entry.top}/${entry.id}`)
    expect(await exists(path.join(root, 'inbox/Work/note.md'))).toBe(true)
    expect(await listSoftDeleted(root)).toHaveLength(0)
  })
})

describe('adopting a .base/data.csv with no schema (infers + materializes)', () => {
  it('infers schema, writes schema.json + stable ids, and is stable on re-read', async () => {
    const root = await makeVault()
    await mkdir(path.join(root, 'inbox/People.base'), { recursive: true })
    await writeFile(
      path.join(root, 'inbox/People.base/data.csv'),
      'Name,Age,Active\nAda,36,true\nGrace,40,false\n',
      'utf8'
    )

    const doc = await readDatabase(root, 'inbox/People.base/data.csv')
    const byName = new Map(doc.fields.map((f) => [f.name, f]))
    expect(byName.get('Age')!.type).toBe('number')
    expect(byName.get('Active')!.type).toBe('checkbox')
    expect(doc.rows).toHaveLength(2)

    // schema.json was materialized inside the form folder
    await expect(readFile(schemaAbs(root, 'inbox/People.base'), 'utf8')).resolves.toContain(
      '"version": 1'
    )

    // ids are stable across re-read (the CSV gained an id column)
    const firstIds = doc.rows.map((r) => r.id)
    const reread = await readDatabase(root, 'inbox/People.base/data.csv')
    expect(reread.rows.map((r) => r.id)).toEqual(firstIds)
    expect(firstIds.every((id) => id.length > 0)).toBe(true)
  })
})
