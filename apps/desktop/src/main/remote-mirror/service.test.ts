import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DesktopCloudSyncRepository } from '../cloud-sync-filesystem'
import { notesOnlyRepository, RemoteMirrorSyncService } from './service'

const roots: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zn-mirror-'))
  roots.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('notesOnlyRepository', () => {
  it('leaves binaries out of what sync sees', async () => {
    const root = await tempDir()
    await mkdir(path.join(root, 'inbox'), { recursive: true })
    await mkdir(path.join(root, 'attachements'), { recursive: true })
    await writeFile(path.join(root, 'inbox', 'Note.md'), '# Note\n')
    await writeFile(path.join(root, 'attachements', 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]))
    const scan = await notesOnlyRepository(new DesktopCloudSyncRepository(root)).scan()
    expect(scan.map((item) => item.path)).toEqual(['inbox/Note.md'])
  })
})

describe('RemoteMirrorSyncService', () => {
  function service(storageDirectory: string) {
    return new RemoteMirrorSyncService({
      storageDirectory,
      profileName: async () => 'Home server',
      connection: async () => null
    })
  }

  it('knows the folder every copy lives in', async () => {
    const storage = await tempDir()
    const mirrors = service(storage)
    expect(mirrors.isMirrorPath(mirrors.mirrorRoot('p', 'v'))).toBe(true)
    expect(mirrors.isMirrorPath(path.join(path.dirname(storage), 'elsewhere'))).toBe(false)
  })

  it('keeps one copy apart per remote and per server vault', async () => {
    const mirrors = service(await tempDir())
    expect(mirrors.mirrorRoot('p', 'v1')).not.toBe(mirrors.mirrorRoot('p', 'v2'))
    expect(mirrors.mirrorRoot('p1', 'v')).not.toBe(mirrors.mirrorRoot('p2', 'v'))
  })

  it('has no copy, no status and no link for a remote that never kept one', async () => {
    const mirrors = service(await tempDir())
    await expect(mirrors.origin('p')).resolves.toBeNull()
    await expect(mirrors.status('p')).resolves.toBeNull()
    await expect(mirrors.link('p')).resolves.toBeNull()
    await expect(mirrors.disable('p')).resolves.toBeUndefined()
  })

  it('refuses to turn on without a saved remote', async () => {
    const mirrors = service(await tempDir())
    await expect(mirrors.enable('p')).rejects.toThrow('no longer saved')
  })
})
