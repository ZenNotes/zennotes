import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  DesktopCloudSyncRepository,
  DesktopCloudSyncStateStore
} from './cloud-sync-filesystem'
import type { CloudSyncChange } from '@zennotes/bridge-contract/cloud-sync'
import type { CloudSyncTrackedItem } from '@zennotes/shared-domain/cloud-sync-engine'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zennotes-cloud-sync-'))
  roots.push(root)
  return root
}

function hash(contents: string): string {
  return createHash('sha256').update(contents).digest('hex')
}

function upsert(path: string, contents: string): CloudSyncChange {
  return {
    sequence: 2,
    item_id: 'item-remote',
    type: 'upsert',
    path,
    previous_path: null,
    revision: 2,
    content: {
      encoding: 'utf8',
      data: contents,
      sha256: hash(contents),
      byte_length: Buffer.byteLength(contents),
      media_type: 'text/markdown'
    }
  }
}

function tracked(path: string, contents: string): CloudSyncTrackedItem {
  return {
    item_id: 'item-1',
    path,
    kind: 'text',
    revision: 1,
    sha256: hash(contents),
    byte_length: Buffer.byteLength(contents),
    media_type: 'text/markdown'
  }
}

describe('DesktopCloudSyncRepository', () => {
  it('scans text and binary vault files while excluding local sync state', async () => {
    const root = await temporaryRoot()
    await mkdir(path.join(root, '.zennotes', 'sync'), { recursive: true })
    await mkdir(path.join(root, '.git'), { recursive: true })
    await mkdir(path.join(root, 'node_modules', 'package'), { recursive: true })
    await writeFile(path.join(root, 'note.md'), '# Note')
    await writeFile(path.join(root, 'image.png'), Buffer.from([0, 1, 2, 3]))
    await writeFile(path.join(root, '.zennotes', 'sync', 'state.json'), '{}')
    await writeFile(path.join(root, '.git', 'config'), 'repository metadata')
    await writeFile(path.join(root, 'node_modules', 'package', 'index.js'), 'dependency')

    const items = await new DesktopCloudSyncRepository(root).scan()

    expect(items.map((item) => item.path)).toEqual(['image.png', 'note.md'])
    expect(items.find((item) => item.path === 'note.md')?.content.encoding).toBe('utf8')
    expect(items.find((item) => item.path === 'image.png')?.content.encoding).toBe('base64')
  })

  it('keeps device-local workspace state out of scans and ignores remote workspace mutations', async () => {
    const root = await temporaryRoot()
    await mkdir(path.join(root, '.zennotes'), { recursive: true })
    await writeFile(path.join(root, '.zennotes', 'workspace.json'), '{"device":"desktop"}')
    await writeFile(path.join(root, 'note.md'), '# Note')
    const repository = new DesktopCloudSyncRepository(root)

    expect((await repository.scan()).map((item) => item.path)).toEqual(['note.md'])

    await repository.apply(
      {
        sequence: 2,
        item_id: 'workspace-item',
        type: 'upsert',
        path: '.zennotes/workspace.json',
        previous_path: null,
        revision: 2,
        content: {
          encoding: 'utf8',
          data: '{"device":"mobile"}',
          sha256: hash('{"device":"mobile"}'),
          byte_length: 19,
          media_type: 'application/json'
        }
      },
      tracked('.zennotes/workspace.json', '{"device":"desktop"}')
    )

    expect(await readFile(path.join(root, '.zennotes', 'workspace.json'), 'utf8')).toBe(
      '{"device":"desktop"}'
    )
  })

  it('applies upsert, move, and delete changes inside the vault', async () => {
    const root = await temporaryRoot()
    const repository = new DesktopCloudSyncRepository(root)

    await repository.apply(
      {
        sequence: 1,
        item_id: 'item-1',
        type: 'upsert',
        path: 'notes/one.md',
        previous_path: null,
        revision: 1,
        content: {
          encoding: 'utf8',
          data: 'one',
          sha256: hash('one'),
          byte_length: 3,
          media_type: 'text/markdown'
        }
      },
      undefined
    )
    await repository.apply(
      {
        sequence: 2,
        item_id: 'item-1',
        type: 'move',
        path: 'archive/one.md',
        previous_path: 'notes/one.md',
        revision: 2
      },
      tracked('notes/one.md', 'one')
    )
    await repository.apply(
      {
        sequence: 3,
        item_id: 'item-1',
        type: 'delete',
        path: 'archive/one.md',
        previous_path: null,
        revision: 3
      },
      tracked('archive/one.md', 'one')
    )

    await expect(readFile(path.join(root, 'archive', 'one.md'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  // The local file is never overwritten, and the incoming version is never
  // thrown away: it lands beside it. Sync used to throw here instead, which
  // stopped the whole run and, because the cursor never advanced, stopped
  // every run after it too (#585 follow-up, reported on Discord).
  it('keeps both versions when a remote change meets a local edit', async () => {
    const root = await temporaryRoot()
    await writeFile(path.join(root, 'note.md'), 'local edit')
    const repository = new DesktopCloudSyncRepository(root)

    const conflict = await repository.apply(
      upsert('note.md', 'remote edit'),
      tracked('note.md', 'old contents')
    )

    expect(conflict).toEqual({
      code: 'LOCAL_EDIT_CONFLICT',
      path: 'note.md',
      conflict_copy_path: 'note (cloud conflict).md'
    })
    expect(await readFile(path.join(root, 'note.md'), 'utf8')).toBe('local edit')
    expect(await readFile(path.join(root, 'note (cloud conflict).md'), 'utf8')).toBe('remote edit')
  })

  // What wedged the reporter: the change feed carried a file this device had
  // never tracked, so sync refused it without ever noticing that the bytes on
  // disk were already exactly what was being delivered.
  it('adopts a file that already matches the incoming change', async () => {
    const root = await temporaryRoot()
    await mkdir(path.join(root, '.zennotes'), { recursive: true })
    await writeFile(path.join(root, '.zennotes', 'vault.json'), '{"favorites":[]}')
    const repository = new DesktopCloudSyncRepository(root)

    const conflict = await repository.apply(
      upsert('.zennotes/vault.json', '{"favorites":[]}'),
      undefined
    )

    expect(conflict).toBeUndefined()
    expect(await readFile(path.join(root, '.zennotes', 'vault.json'), 'utf8')).toBe(
      '{"favorites":[]}'
    )
    expect(await readdir(path.join(root, '.zennotes'))).toEqual(['vault.json'])
  })

  it('numbers conflict copies instead of overwriting an earlier one', async () => {
    const root = await temporaryRoot()
    await writeFile(path.join(root, 'note.md'), 'local edit')
    await writeFile(path.join(root, 'note (cloud conflict).md'), 'an earlier conflict')
    const repository = new DesktopCloudSyncRepository(root)

    const conflict = await repository.apply(upsert('note.md', 'remote edit'), undefined)

    expect(conflict?.conflict_copy_path).toBe('note (cloud conflict 2).md')
    expect(await readFile(path.join(root, 'note (cloud conflict).md'), 'utf8')).toBe(
      'an earlier conflict'
    )
    expect(await readFile(path.join(root, 'note (cloud conflict 2).md'), 'utf8')).toBe('remote edit')
  })

  // Settings are a question, not a merge: a numbered copy inside a hidden
  // folder is not something anyone can act on, so the cloud version waits at
  // one fixed path and the app asks which side to keep.
  it('parks conflicting vault settings at one fixed path for the user to answer', async () => {
    const root = await temporaryRoot()
    await mkdir(path.join(root, '.zennotes'), { recursive: true })
    await writeFile(path.join(root, '.zennotes', 'vault.json'), '{"favorites":["a"]}')
    const repository = new DesktopCloudSyncRepository(root)

    const first = await repository.apply(
      upsert('.zennotes/vault.json', '{"favorites":["b"]}'),
      undefined
    )
    expect(first).toEqual({
      code: 'SETTINGS_CONFLICT',
      path: '.zennotes/vault.json',
      conflict_copy_path: '.zennotes/vault.cloud-conflict.json'
    })
    expect(await repository.pendingConflictPaths()).toEqual(['.zennotes/vault.json'])
    // The settings in use are still this device's.
    expect(await readFile(path.join(root, '.zennotes', 'vault.json'), 'utf8')).toBe(
      '{"favorites":["a"]}'
    )

    // A newer cloud version replaces the pending one instead of piling up.
    await repository.apply(upsert('.zennotes/vault.json', '{"favorites":["c"]}'), undefined)
    expect(
      await readFile(path.join(root, '.zennotes', 'vault.cloud-conflict.json'), 'utf8')
    ).toBe('{"favorites":["c"]}')
    expect((await readdir(path.join(root, '.zennotes'))).sort()).toEqual([
      'vault.cloud-conflict.json',
      'vault.json'
    ])
  })

  it('keeps a locally edited file that the remote deleted', async () => {
    const root = await temporaryRoot()
    await writeFile(path.join(root, 'note.md'), 'local edit')
    const repository = new DesktopCloudSyncRepository(root)

    const conflict = await repository.apply(
      {
        sequence: 3,
        item_id: 'item-1',
        type: 'delete',
        path: 'note.md',
        previous_path: null,
        revision: 3
      },
      tracked('note.md', 'old contents')
    )

    expect(conflict).toEqual({
      code: 'LOCAL_EDIT_CONFLICT',
      path: 'note.md',
      conflict_copy_path: null
    })
    expect(await readFile(path.join(root, 'note.md'), 'utf8')).toBe('local edit')
  })

  it('accepts a delete for a file that is already gone locally', async () => {
    const root = await temporaryRoot()
    const repository = new DesktopCloudSyncRepository(root)

    const conflict = await repository.apply(
      {
        sequence: 4,
        item_id: 'item-1',
        type: 'delete',
        path: 'note.md',
        previous_path: null,
        revision: 4
      },
      tracked('note.md', 'old contents')
    )

    expect(conflict).toBeUndefined()
  })
})

describe('DesktopCloudSyncStateStore', () => {
  it('persists cursor state outside the vault', async () => {
    const root = await temporaryRoot()
    const stateDirectory = path.join(root, 'user-data', 'cloud-sync')
    const store = new DesktopCloudSyncStateStore(stateDirectory)
    const state = { version: 1 as const, vault_id: 'vault-1', cursor: 7, items: {} }

    await store.save(state)

    expect(await store.load('vault-1')).toEqual(state)
    expect(await store.load('another-vault')).toBeNull()
  })
})
