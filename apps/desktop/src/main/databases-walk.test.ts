import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDatabase, createRecordPage } from './databases'
import { listFolders, listNotes, listAssets } from './vault'

const tempDirs: string[] = []

async function makeVault(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zen-dbwalk-'))
  tempDirs.push(dir)
  await mkdir(path.join(dir, 'inbox'), { recursive: true })
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('vault walk treats a .base database as one unit (#185)', () => {
  it('surfaces the database folder + record pages, hides data.csv/schema.json', async () => {
    const root = await makeVault()
    const doc = await createDatabase(root, 'inbox', '', 'Reading List')
    expect(doc.path).toBe('inbox/Reading List.base/data.csv')
    await createRecordPage(root, doc.path, 'Dune', '# Dune')

    // The database appears as a folder node (the sidebar renders it as a database).
    const folderEntries = await listFolders(root)
    expect(folderEntries.some((f) => f.subpath === 'Reading List.base')).toBe(true)

    // The record page is a note nested under the database folder.
    const notes = await listNotes(root)
    const page = notes.find((n) => n.path === 'inbox/Reading List.base/Dune.md')
    expect(page).toBeTruthy()
    expect(page?.folder).toBe('inbox')

    // data.csv and schema.json never appear as assets or notes.
    const assets = await listAssets(root)
    expect(assets.some((a) => a.path.includes('.base'))).toBe(false)
    expect(notes.some((n) => n.path.endsWith('data.csv') || n.path.endsWith('schema.json'))).toBe(
      false
    )
    // The database folder is NOT descended into as ordinary subfolders.
    expect(folderEntries.some((f) => f.subpath.startsWith('Reading List.base/'))).toBe(false)
  })
})
