import { describe, expect, it } from 'vitest'
import type { NoteFolder } from '@zennotes/bridge-contract/ipc'
import {
  createDatabaseOps,
  type DatabaseFileOps,
  type DatabaseVaultLayout
} from './database-ops'
import { parseCsv } from './database-csv'
import { resolveFolderPath } from './system-folder-paths'

// The composition is transport-agnostic by design: these tests drive it over
// an in-memory vault, the exact seam the web bridge (HTTP) and the desktop
// remote client (#499) plug into. What is asserted here holds for both.

interface MemVault {
  io: DatabaseFileOps
  files: Map<string, string>
  folders: { folder: NoteFolder; subpath: string }[]
}

function memVault(layout: Partial<DatabaseVaultLayout> = {}): MemVault {
  const effective: DatabaseVaultLayout = {
    primaryNotesAtRoot: layout.primaryNotesAtRoot ?? false,
    systemFolderPaths: layout.systemFolderPaths ?? null
  }
  const files = new Map<string, string>()
  const folders: { folder: NoteFolder; subpath: string }[] = []
  const io: DatabaseFileOps = {
    readFileTextOrNull: async (rel) => files.get(rel) ?? null,
    writeFile: async (rel, text) => {
      files.set(rel, text)
    },
    createFolder: async (folder, subpath) => {
      folders.push({ folder, subpath })
    },
    renameFolder: async (folder, oldSubpath, newSubpath) => {
      // The server resolves a (folder, subpath) pair to a real directory, remap
      // and primary-notes mode included; the double has to do the same or it
      // would hide exactly the bug these tests are here for.
      const relOf = (sub: string): string =>
        folder === 'inbox' && effective.primaryNotesAtRoot
          ? sub
          : `${resolveFolderPath(folder, effective.systemFolderPaths)}/${sub}`
      const oldPrefix = `${relOf(oldSubpath)}/`
      const newPrefix = `${relOf(newSubpath)}/`
      for (const [key, value] of [...files]) {
        if (key.startsWith(oldPrefix)) {
          files.delete(key)
          files.set(newPrefix + key.slice(oldPrefix.length), value)
        }
      }
      for (const f of folders) {
        if (f.folder === folder && f.subpath === oldSubpath) f.subpath = newSubpath
      }
      return newSubpath
    },
    listFolders: async () => folders.map((f) => ({ ...f })),
    vaultLayout: async () => effective
  }
  return { io, files, folders }
}

describe('createDatabaseOps', () => {
  it('creates a database as a .base folder with csv + sidecar, then lists and reopens it', async () => {
    const vault = memVault()
    const ops = createDatabaseOps(vault.io)

    const doc = await ops.createDatabase('inbox', '', 'Reading Log')
    expect(doc.path).toBe('inbox/Reading Log.base/data.csv')
    expect(doc.title).toBe('Reading Log')
    expect(vault.files.has('inbox/Reading Log.base/data.csv')).toBe(true)
    expect(vault.files.has('inbox/Reading Log.base/schema.json')).toBe(true)
    expect(vault.folders).toEqual([{ folder: 'inbox', subpath: 'Reading Log.base' }])

    const listed = await ops.listDatabases()
    expect(listed).toEqual([{ path: 'inbox/Reading Log.base/data.csv', title: 'Reading Log' }])

    const reopened = await ops.openDatabase(doc.path)
    expect(reopened.fields.map((f) => f.name)).toEqual(['id', 'Name'])
    expect(reopened.rows).toEqual([])
  })

  it('suffixes instead of clobbering when the name is taken', async () => {
    const vault = memVault()
    const ops = createDatabaseOps(vault.io)
    await ops.createDatabase('inbox', '', 'Log')
    const second = await ops.createDatabase('inbox', '', 'Log')
    expect(second.path).toBe('inbox/Log 2.base/data.csv')
  })

  it('adopts a bare CSV: infers a schema, persists the sidecar, canonicalizes ids', async () => {
    const vault = memVault()
    vault.files.set('inbox/Books.base/data.csv', 'Title,Rating\nDune,5\nNeuromancer,4\n')
    const ops = createDatabaseOps(vault.io)

    const doc = await ops.openDatabase('inbox/Books.base/data.csv')
    expect(doc.rows).toHaveLength(2)
    expect(vault.files.has('inbox/Books.base/schema.json')).toBe(true)
    // Canonicalized CSV gained a persistent id column.
    const grid = parseCsv(vault.files.get('inbox/Books.base/data.csv')!)
    expect(grid[0].length).toBeGreaterThan(2)
    // Reopening uses the persisted sidecar and sees identical rows.
    const again = await ops.openDatabase('inbox/Books.base/data.csv')
    expect(again.rows).toEqual(doc.rows)
  })

  it('writes rows through the sidecar schema and reads them back', async () => {
    const vault = memVault()
    const ops = createDatabaseOps(vault.io)
    const doc = await ops.createDatabase('quick', '', 'Tasks')
    const nameField = doc.fields.find((f) => f.name === 'Name')!
    const idField = doc.fields.find((f) => f.name === 'id')!

    const written = await ops.writeDatabaseRows(doc.path, [
      { id: 'r1', cells: { [idField.id]: 'r1', [nameField.id]: 'first' } }
    ])
    expect(written.rows).toHaveLength(1)
    const reopened = await ops.openDatabase(doc.path)
    expect(reopened.rows).toHaveLength(1)
  })

  it('rejects an invalid schema write and a rows write without a sidecar', async () => {
    const vault = memVault()
    vault.files.set('inbox/Loose.base/data.csv', 'a,b\n1,2\n')
    const ops = createDatabaseOps(vault.io)
    await expect(ops.writeDatabaseRows('inbox/Loose.base/data.csv', [])).rejects.toThrow(
      /sidecar missing/
    )
    const doc = await ops.openDatabase('inbox/Loose.base/data.csv')
    await expect(
      ops.writeDatabaseSchema(doc.path, { ...doc, fields: [] } as never, [])
    ).rejects.toThrow(/Invalid database schema/)
  })

  it('creates record pages with collision suffixes and reports their content flags', async () => {
    const vault = memVault()
    const ops = createDatabaseOps(vault.io)
    const doc = await ops.createDatabase('inbox', '', 'CRM')

    const first = await ops.createRecordPage(doc.path, 'Acme', '# Acme\n')
    const second = await ops.createRecordPage(doc.path, 'Acme', '# Acme\n\nnotes here\n')
    expect(first).toBe('inbox/CRM.base/Acme.md')
    expect(second).toBe('inbox/CRM.base/Acme 2.md')

    const sidecarRaw = JSON.parse(vault.files.get('inbox/CRM.base/schema.json')!)
    sidecarRaw.pages = { row1: 'Acme.md', row2: 'Acme 2.md' }
    vault.files.set('inbox/CRM.base/schema.json', JSON.stringify(sidecarRaw))
    const reopened = await ops.openDatabase(doc.path)
    // Empty-bodied page is false, the one with prose is true.
    expect(reopened.pageHasContent).toEqual({ row1: false, row2: true })
  })

  it('renames the .base folder and returns the new csv path', async () => {
    const vault = memVault()
    const ops = createDatabaseOps(vault.io)
    const doc = await ops.createDatabase('inbox', 'Work', 'Old Name')
    expect(doc.path).toBe('inbox/Work/Old Name.base/data.csv')

    const renamed = await ops.renameDatabase(doc.path, 'New Name')
    expect(renamed).toBe('inbox/Work/New Name.base/data.csv')
    expect(vault.files.has('inbox/Work/New Name.base/data.csv')).toBe(true)
    expect(vault.files.has('inbox/Work/Old Name.base/data.csv')).toBe(false)
  })


  it('returns the canonical directory supplied by the host after a rename', async () => {
    const vault = memVault({ primaryNotesAtRoot: true })
    const rename = vault.io.renameFolder
    vault.io.renameFolder = (folder, from) => rename(folder, from, 'Canonical.base')
    const ops = createDatabaseOps(vault.io)
    const doc = await ops.createDatabase('inbox', '', 'Original')
    expect(await ops.renameDatabase(doc.path, 'Requested')).toBe('Canonical.base/data.csv')
    expect(vault.files.has('Canonical.base/data.csv')).toBe(true)
  })


  it.each(['People', 'people'])('does not overwrite a partial database folder when creating %s', async (title) => {
    const vault = memVault()
    vault.folders.push({ folder: 'inbox', subpath: 'People.base' })
    vault.files.set('inbox/People.base/schema.json', 'keep original schema')
    vault.files.set('inbox/People.base/Record.md', 'keep record')
    const created = await createDatabaseOps(vault.io).createDatabase('inbox', '', title)
    expect(created.path).toBe(`inbox/${title} 2.base/data.csv`)
    expect(vault.files.get('inbox/People.base/schema.json')).toBe('keep original schema')
    expect(vault.files.get('inbox/People.base/Record.md')).toBe('keep record')
    expect(vault.files.has('inbox/People.base/data.csv')).toBe(false)
  })

  it('respects primaryNotesLocation root for inbox paths', async () => {
    const vault = memVault({ primaryNotesAtRoot: true })
    const ops = createDatabaseOps(vault.io)
    const doc = await ops.createDatabase('inbox', '', 'Rooted')
    expect(doc.path).toBe('Rooted.base/data.csv')
    const listed = await ops.listDatabases()
    expect(listed[0].path).toBe('Rooted.base/data.csv')
  })
})

// The server resolves (folder, subpath) through the vault's `systemFolderPaths`
// remap (#398). Composing paths from the literal folder names instead wrote
// every sidecar under a directory the server never lists, so the database was
// created and then invisible.
describe('createDatabaseOps with remapped system folders', () => {
  const remapped = { archive: '99 - Archive', inbox: '01 - Entry' }

  it('creates a database under the remapped directory and lists it back', async () => {
    const vault = memVault({ systemFolderPaths: remapped })
    const ops = createDatabaseOps(vault.io)

    const doc = await ops.createDatabase('archive', 'Ledgers', 'Receipts')
    expect(doc.path).toBe('99 - Archive/Ledgers/Receipts.base/data.csv')
    expect(vault.files.has('99 - Archive/Ledgers/Receipts.base/schema.json')).toBe(true)

    const listed = await ops.listDatabases()
    expect(listed).toEqual([
      { path: '99 - Archive/Ledgers/Receipts.base/data.csv', title: 'Receipts' }
    ])
    const reopened = await ops.openDatabase(doc.path)
    expect(reopened.fields.map((f) => f.name)).toEqual(['id', 'Name'])
  })

  it('uses the remapped inbox directory too', async () => {
    const vault = memVault({ systemFolderPaths: remapped })
    const ops = createDatabaseOps(vault.io)
    const doc = await ops.createDatabase('inbox', '', 'Reading')
    expect(doc.path).toBe('01 - Entry/Reading.base/data.csv')
  })

  // renameDatabase splits the vault-relative path back into (folder, subpath)
  // for the folder endpoint, so the split has to honor the remap as well.
  it('renames inside a remapped folder without losing the folder', async () => {
    const vault = memVault({ systemFolderPaths: remapped })
    const ops = createDatabaseOps(vault.io)
    const doc = await ops.createDatabase('archive', 'Ledgers', 'Old Name')

    const renamed = await ops.renameDatabase(doc.path, 'New Name')
    expect(renamed).toBe('99 - Archive/Ledgers/New Name.base/data.csv')
    expect(vault.files.has('99 - Archive/Ledgers/New Name.base/data.csv')).toBe(true)
    expect(vault.folders).toEqual([{ folder: 'archive', subpath: 'Ledgers/New Name.base' }])
  })

  // With archive remapped away, a directory literally named `archive/` is an
  // ordinary user folder inside the primary area.
  it('treats a literal archive/ as inbox content once archive has moved', async () => {
    const vault = memVault({ primaryNotesAtRoot: true, systemFolderPaths: remapped })
    const ops = createDatabaseOps(vault.io)
    vault.files.set('archive/Notes.base/data.csv', 'Title\nOne\n')
    vault.folders.push({ folder: 'inbox', subpath: 'archive/Notes.base' })

    const renamed = await ops.renameDatabase('archive/Notes.base/data.csv', 'Renamed')
    expect(renamed).toBe('archive/Renamed.base/data.csv')
    expect(vault.files.has(renamed)).toBe(true)
  })
})

// `null` from readFileTextOrNull means the sidecar is ABSENT, which openDatabase
// answers by inferring a schema and writing it over schema.json. A transport
// that reports a failed read as absence therefore destroys the schema, so the
// composition must let read errors through.
describe('createDatabaseOps sidecar read errors', () => {
  it('propagates a sidecar read failure instead of adopting the CSV', async () => {
    const vault = memVault()
    const ops = createDatabaseOps(vault.io)
    const doc = await ops.createDatabase('inbox', '', 'Books')
    const schemaPath = 'inbox/Books.base/schema.json'
    const original = vault.files.get(schemaPath)

    const failing = {
      ...vault.io,
      readFileTextOrNull: async (rel: string): Promise<string | null> => {
        if (rel === schemaPath) throw new Error('HTTP 500 Internal Server Error')
        return vault.files.get(rel) ?? null
      }
    }
    await expect(createDatabaseOps(failing).openDatabase(doc.path)).rejects.toThrow(/500/)
    expect(vault.files.get(schemaPath)).toBe(original)
  })
})
