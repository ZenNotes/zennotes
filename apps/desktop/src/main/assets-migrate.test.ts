import { mkdtemp, rm, writeFile, mkdir, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listAssets, migrateLooseAssets, importAssetsToVault } from './vault'

const tmpDirs: string[] = []
async function makeVault(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zennotes-assets-'))
  tmpDirs.push(dir)
  await mkdir(path.join(dir, 'inbox'), { recursive: true })
  return dir
}
const touch = (root: string, rel: string, body = 'x'): Promise<void> =>
  writeFile(path.join(root, rel), body)
const exists = (root: string, rel: string): Promise<boolean> =>
  access(path.join(root, rel)).then(
    () => true,
    () => false
  )

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('listAssets and databases', () => {
  it('lists the .csv but skips its sidecar/backup companions and notes', async () => {
    const root = await makeVault()
    await touch(root, 'photo.png')
    await touch(root, 'books.csv', 'id,Name\n')
    await touch(root, 'books.csv.base.json', '{}')
    await touch(root, 'note.md', '# hi')

    const assets = await listAssets(root)
    const names = assets.map((a) => a.name)
    expect(names).toContain('photo.png')
    // The `.csv` rides the asset pipeline (so it stays in the tree); the
    // renderer is what filters it out of the grid/count.
    expect(names).toContain('books.csv')
    expect(names).not.toContain('books.csv.base.json')
    expect(names).not.toContain('note.md')
  })
})

describe('migrateLooseAssets', () => {
  it('moves root-level attachments into assets/ and reports them', async () => {
    const root = await makeVault()
    await touch(root, 'photo.png')
    await touch(root, 'doc.pdf')

    const { moved, skipped } = await migrateLooseAssets(root)

    expect(moved.sort()).toEqual(['assets/doc.pdf', 'assets/photo.png'])
    expect(skipped).toEqual([])
    expect(await exists(root, 'assets/photo.png')).toBe(true)
    expect(await exists(root, 'photo.png')).toBe(false)
  })

  it('never touches notes or database files', async () => {
    const root = await makeVault()
    await touch(root, 'note.md', '# hi')
    await touch(root, 'books.csv', 'id,Name\n')
    await touch(root, 'pic.png')

    const { moved } = await migrateLooseAssets(root)

    expect(moved).toEqual(['assets/pic.png'])
    expect(await exists(root, 'note.md')).toBe(true)
    expect(await exists(root, 'books.csv')).toBe(true)
  })

  it('skips (does not rename) files whose basename would collide', async () => {
    const root = await makeVault()
    // two different root files sharing a basename can't both keep the name
    // inside assets/ — moving would force a rename and break ![[logo.png]].
    await touch(root, 'logo.png')
    await mkdir(path.join(root, 'sub'), { recursive: true })
    // a same-named file already living under assets/
    await mkdir(path.join(root, 'assets'), { recursive: true })
    await touch(root, 'assets/logo.png')

    const { moved, skipped } = await migrateLooseAssets(root)

    expect(moved).toEqual([])
    expect(skipped).toEqual([{ path: 'logo.png', reason: 'duplicate-basename' }])
    // original left in place, untouched
    expect(await exists(root, 'logo.png')).toBe(true)
  })

  it('is idempotent — a second run moves nothing', async () => {
    const root = await makeVault()
    await touch(root, 'a.png')
    await migrateLooseAssets(root)
    const again = await migrateLooseAssets(root)
    expect(again.moved).toEqual([])
    expect(again.skipped).toEqual([])
  })
})

describe('importAssetsToVault', () => {
  it('copies external files into assets/ and skips notes', async () => {
    const root = await makeVault()
    const srcDir = await mkdtemp(path.join(os.tmpdir(), 'zennotes-src-'))
    tmpDirs.push(srcDir)
    await writeFile(path.join(srcDir, 'clip.mp4'), 'video-bytes')
    await writeFile(path.join(srcDir, 'shot.png'), 'png-bytes')
    await writeFile(path.join(srcDir, 'notes.md'), '# skip me')

    const imported = await importAssetsToVault(root, [
      path.join(srcDir, 'clip.mp4'),
      path.join(srcDir, 'shot.png'),
      path.join(srcDir, 'notes.md')
    ])

    expect(imported.map((a) => a.path).sort()).toEqual(['assets/clip.mp4', 'assets/shot.png'])
    expect(imported.find((a) => a.name === 'clip.mp4')?.kind).toBe('video')
    expect(await exists(root, 'assets/clip.mp4')).toBe(true)
    // the .md was skipped
    expect(await exists(root, 'assets/notes.md')).toBe(false)
    // originals untouched (copy, not move)
    expect(await access(path.join(srcDir, 'clip.mp4')).then(() => true)).toBe(true)
  })
})
