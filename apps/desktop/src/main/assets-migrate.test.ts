import { mkdtemp, mkdir, rm, writeFile, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateLooseAssets, listAssets } from './vault'

const tempDirs: string[] = []

async function makeVault(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zen-amig-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const exists = (root: string, rel: string): Promise<boolean> =>
  access(path.join(root, rel))
    .then(() => true)
    .catch(() => false)

describe('migrateLooseAssets (#185 assets/ unification)', () => {
  it('moves root-level attachments + legacy dirs into assets/, never notes or databases', async () => {
    const root = await makeVault()
    await writeFile(path.join(root, 'photo.png'), 'x', 'utf8')
    await writeFile(path.join(root, 'note.md'), '# hi', 'utf8') // a note — must stay
    await writeFile(path.join(root, 'books.csv'), 'id\n', 'utf8') // legacy db — must stay
    await mkdir(path.join(root, 'attachements'), { recursive: true })
    await writeFile(path.join(root, 'attachements', 'doc.pdf'), 'x', 'utf8')

    const { moved, skipped } = await migrateLooseAssets(root)
    expect(moved.sort()).toEqual(['assets/doc.pdf', 'assets/photo.png'])
    expect(skipped).toEqual([])

    expect(await exists(root, 'assets/photo.png')).toBe(true)
    expect(await exists(root, 'assets/doc.pdf')).toBe(true)
    expect(await exists(root, 'photo.png')).toBe(false)
    expect(await exists(root, 'attachements')).toBe(false) // emptied + removed
    // Notes and database files are untouched.
    expect(await exists(root, 'note.md')).toBe(true)
    expect(await exists(root, 'books.csv')).toBe(true)
  })

  it('skips a file whose basename already exists in assets/ (keeps refs unambiguous)', async () => {
    const root = await makeVault()
    await mkdir(path.join(root, 'assets'), { recursive: true })
    await writeFile(path.join(root, 'assets', 'logo.png'), 'existing', 'utf8')
    await writeFile(path.join(root, 'logo.png'), 'loose', 'utf8')

    const { moved, skipped } = await migrateLooseAssets(root)
    expect(moved).toEqual([])
    expect(skipped).toEqual(['logo.png'])
    expect(await exists(root, 'logo.png')).toBe(true) // left in place
  })

  it('is idempotent and surfaces migrated assets via listAssets', async () => {
    const root = await makeVault()
    await writeFile(path.join(root, 'pic.png'), 'x', 'utf8')
    expect((await migrateLooseAssets(root)).moved).toEqual(['assets/pic.png'])
    expect((await migrateLooseAssets(root)).moved).toEqual([])

    const assets = await listAssets(root)
    expect(assets.map((a) => a.path)).toContain('assets/pic.png')
  })
})
