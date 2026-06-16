import { mkdtemp, mkdir, rm, writeFile, readFile, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateLegacyDatabases } from './vault'
import { readDatabase } from './databases'

const tempDirs: string[] = []

async function makeVault(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zen-dbmig-'))
  tempDirs.push(dir)
  await mkdir(path.join(dir, 'inbox'), { recursive: true })
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const exists = (p: string): Promise<boolean> =>
  access(p)
    .then(() => true)
    .catch(() => false)

// A minimal legacy database: loose `<Name>.csv` + co-located sidecar, with one
// record-page note under the per-database `<Name>/` folder.
async function seedLegacyDatabase(root: string): Promise<void> {
  await writeFile(path.join(root, 'inbox', 'Books.csv'), 'id,Title\nr1,Dune\n', 'utf8')
  await mkdir(path.join(root, 'inbox', 'Books'), { recursive: true })
  await writeFile(path.join(root, 'inbox', 'Books', 'Dune.md'), '# Dune\n\nGreat book.', 'utf8')
  const sidecar = {
    version: 1,
    idFieldId: 'f_id',
    fields: [
      { id: 'f_id', name: 'id', type: 'text', hidden: true },
      { id: 'f_title', name: 'Title', type: 'text' }
    ],
    views: [{ id: 'v1', name: 'Table', type: 'table', filters: [], sorts: [] }],
    activeViewId: 'v1',
    pages: { r1: 'inbox/Books/Dune.md' }
  }
  await writeFile(
    path.join(root, 'inbox', 'Books.csv.base.json'),
    JSON.stringify(sidecar, null, 2),
    'utf8'
  )
}

describe('migrateLegacyDatabases (#185 .base reorg)', () => {
  it('moves a legacy database into a self-contained .base folder', async () => {
    const root = await makeVault()
    await seedLegacyDatabase(root)

    const count = await migrateLegacyDatabases(root)
    expect(count).toBe(1)

    const baseDir = path.join(root, 'inbox', 'Books.base')
    expect(await exists(path.join(baseDir, 'data.csv'))).toBe(true)
    expect(await exists(path.join(baseDir, 'schema.json'))).toBe(true)
    expect(await exists(path.join(baseDir, 'Dune.md'))).toBe(true)

    // Old files + per-database folder are gone.
    expect(await exists(path.join(root, 'inbox', 'Books.csv'))).toBe(false)
    expect(await exists(path.join(root, 'inbox', 'Books.csv.base.json'))).toBe(false)
    expect(await exists(path.join(root, 'inbox', 'Books'))).toBe(false)

    // schema.json stores the page path RELATIVE to the folder.
    const schema = JSON.parse(await readFile(path.join(baseDir, 'schema.json'), 'utf8'))
    expect(schema.pages).toEqual({ r1: 'Dune.md' })

    // data.csv content is preserved.
    expect(await readFile(path.join(baseDir, 'data.csv'), 'utf8')).toContain('Dune')
  })

  it('readDatabase resolves the migrated db and its pages to full paths', async () => {
    const root = await makeVault()
    await seedLegacyDatabase(root)
    await migrateLegacyDatabases(root)

    const doc = await readDatabase(root, 'inbox/Books.base/data.csv')
    expect(doc.title).toBe('Books')
    expect(doc.rows).toHaveLength(1)
    // pages resolved back to full vault-relative paths on read.
    expect(doc.pages?.r1).toBe('inbox/Books.base/Dune.md')
  })

  it('is idempotent — a second run migrates nothing and leaves data intact', async () => {
    const root = await makeVault()
    await seedLegacyDatabase(root)
    expect(await migrateLegacyDatabases(root)).toBe(1)
    expect(await migrateLegacyDatabases(root)).toBe(0)
    expect(await exists(path.join(root, 'inbox', 'Books.base', 'data.csv'))).toBe(true)
  })

  it('leaves a plain CSV (no sidecar) untouched', async () => {
    const root = await makeVault()
    await writeFile(path.join(root, 'inbox', 'data-dump.csv'), 'a,b\n1,2\n', 'utf8')
    expect(await migrateLegacyDatabases(root)).toBe(0)
    expect(await exists(path.join(root, 'inbox', 'data-dump.csv'))).toBe(true)
    expect(await exists(path.join(root, 'inbox', 'data-dump.base'))).toBe(false)
  })
})
