import { afterEach, describe, expect, it } from 'vitest'
import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
  mkdir
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DesktopCloudSyncRepository, DesktopCloudSyncStateStore } from './cloud-sync-filesystem'
import {
  CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES,
  cloudSyncUploadSource
} from './cloud-sync-upload-source'
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
    await mkdir(path.join(root, 'node_modules', 'package'), {
      recursive: true
    })
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

  it('keeps oversized file contents out of memory and records their upload source', async () => {
    const root = await temporaryRoot()
    const absolutePath = path.join(root, 'archive.bin')
    const bytes = Buffer.alloc(CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES + 1, 17)
    await writeFile(absolutePath, bytes)

    const items = await new DesktopCloudSyncRepository(root).scan()

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      path: 'archive.bin',
      kind: 'binary',
      content: {
        encoding: 'base64',
        data: '',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        byte_length: bytes.byteLength,
        media_type: 'application/octet-stream'
      }
    })
    expect(cloudSyncUploadSource(items[0]!.content)).toBe(absolutePath)
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

  it('returns both versions without writing a conflict note into the vault', async () => {
    const root = await temporaryRoot()
    await writeFile(path.join(root, 'note.md'), 'local edit')
    const repository = new DesktopCloudSyncRepository(root)

    const conflict = await repository.apply(
      upsert('note.md', 'remote edit'),
      tracked('note.md', 'old contents')
    )

    expect(conflict).toMatchObject({
      code: 'LOCAL_EDIT_CONFLICT',
      path: 'note.md',
      conflict_copy_path: null,
      local: { path: 'note.md', content: { data: 'local edit' } }
    })
    expect(await readFile(path.join(root, 'note.md'), 'utf8')).toBe('local edit')
    expect(await readdir(root)).toEqual(['note.md'])
  })

  it('applies an explicit Cloud choice only while the local version is unchanged', async () => {
    const root = await temporaryRoot()
    await writeFile(path.join(root, 'note.md'), 'local edit')
    const repository = new DesktopCloudSyncRepository(root)
    const conflict = {
      code: 'BOOTSTRAP_CONTENT_CONFLICT' as const,
      item_id: 'item-remote',
      path: 'note.md',
      local_sha256: hash('local edit'),
      remote_sha256: hash('cloud edit')
    }

    await repository.resolveBootstrapConflict({
      path: 'note.md',
      expectedLocalSha256: conflict.local_sha256,
      cloudContent: upsert('note.md', 'cloud edit').content!,
      resolution: { conflict, choice: 'cloud' }
    })

    expect(await readFile(path.join(root, 'note.md'), 'utf8')).toBe('cloud edit')
    await expect(
      repository.resolveBootstrapConflict({
        path: 'note.md',
        expectedLocalSha256: conflict.local_sha256,
        cloudContent: upsert('note.md', 'cloud edit').content!,
        resolution: { conflict, choice: 'cloud' }
      })
    ).rejects.toThrow('changed on this device')
  })

  it('keeps both bootstrap versions under explicit paths', async () => {
    const root = await temporaryRoot()
    await writeFile(path.join(root, 'note.md'), 'local edit')
    const repository = new DesktopCloudSyncRepository(root)
    const conflict = {
      code: 'BOOTSTRAP_CONTENT_CONFLICT' as const,
      item_id: 'item-remote',
      path: 'note.md',
      local_sha256: hash('local edit'),
      remote_sha256: hash('cloud edit')
    }

    await repository.resolveBootstrapConflict({
      path: 'note.md',
      expectedLocalSha256: conflict.local_sha256,
      cloudContent: upsert('note.md', 'cloud edit').content!,
      resolution: {
        conflict,
        choice: 'both',
        keep_both_path: 'note (this device).md'
      }
    })

    expect(await readFile(path.join(root, 'note.md'), 'utf8')).toBe('cloud edit')
    expect(await readFile(path.join(root, 'note (this device).md'), 'utf8')).toBe('local edit')
  })

  it('writes an explicit merged bootstrap result', async () => {
    const root = await temporaryRoot()
    await writeFile(path.join(root, 'note.md'), 'local edit')
    const repository = new DesktopCloudSyncRepository(root)
    const conflict = {
      code: 'BOOTSTRAP_CONTENT_CONFLICT' as const,
      item_id: 'item-remote',
      path: 'note.md',
      local_sha256: hash('local edit'),
      remote_sha256: hash('cloud edit')
    }

    await repository.resolveBootstrapConflict({
      path: 'note.md',
      expectedLocalSha256: conflict.local_sha256,
      cloudContent: upsert('note.md', 'cloud edit').content!,
      resolution: { conflict, choice: 'merged', merged_text: 'merged result' }
    })

    expect(await readFile(path.join(root, 'note.md'), 'utf8')).toBe('merged result')
  })

  it('materializes moved and keep-both decisions without overwriting another file', async () => {
    const root = await temporaryRoot()
    await writeFile(path.join(root, 'note.md'), 'local edit')
    await writeFile(path.join(root, 'existing.md'), 'leave me alone')
    const repository = new DesktopCloudSyncRepository(root)

    await repository.applyConflictResolutionFiles({
      expected_path: 'note.md',
      expected_sha256: hash('local edit'),
      files: [
        {
          path: 'archive/note.md',
          content: upsert('archive/note.md', 'cloud edit').content!
        },
        {
          path: 'note from Mac.md',
          content: upsert('note from Mac.md', 'local edit').content!
        }
      ]
    })

    await expect(readFile(path.join(root, 'note.md'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(await readFile(path.join(root, 'archive', 'note.md'), 'utf8')).toBe('cloud edit')
    expect(await readFile(path.join(root, 'note from Mac.md'), 'utf8')).toBe('local edit')
    await expect(
      repository.applyConflictResolutionFiles({
        expected_path: 'archive/note.md',
        expected_sha256: hash('cloud edit'),
        files: [
          {
            path: 'existing.md',
            content: upsert('existing.md', 'cloud edit').content!
          }
        ]
      })
    ).rejects.toThrow('already exists')
    expect(await readFile(path.join(root, 'archive', 'note.md'), 'utf8')).toBe('cloud edit')
    expect(await readFile(path.join(root, 'existing.md'), 'utf8')).toBe('leave me alone')
  })

  it('removes newly created resolution files when a later write fails', async () => {
    const root = await temporaryRoot()
    await writeFile(path.join(root, 'note.md'), 'local edit')
    await writeFile(path.join(root, 'blocked'), 'not a directory')
    const repository = new DesktopCloudSyncRepository(root)

    await expect(
      repository.applyConflictResolutionFiles({
        expected_path: 'note.md',
        expected_sha256: hash('local edit'),
        files: [
          { path: 'copy.md', content: upsert('copy.md', 'safe copy').content! },
          {
            path: 'blocked/note.md',
            content: upsert('blocked/note.md', 'fails').content!
          }
        ]
      })
    ).rejects.toThrow()

    expect(await readFile(path.join(root, 'note.md'), 'utf8')).toBe('local edit')
    expect(await readFile(path.join(root, 'blocked'), 'utf8')).toBe('not a directory')
    await expect(readFile(path.join(root, 'copy.md'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
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

  it('leaves an existing legacy conflict copy untouched and creates no new one', async () => {
    const root = await temporaryRoot()
    await writeFile(path.join(root, 'note.md'), 'local edit')
    await writeFile(path.join(root, 'note (cloud conflict).md'), 'an earlier conflict')
    const repository = new DesktopCloudSyncRepository(root)

    const conflict = await repository.apply(upsert('note.md', 'remote edit'), undefined)

    expect(conflict?.conflict_copy_path).toBeNull()
    expect(await readFile(path.join(root, 'note (cloud conflict).md'), 'utf8')).toBe(
      'an earlier conflict'
    )
    expect((await readdir(root)).sort()).toEqual(['note (cloud conflict).md', 'note.md'])
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
    expect(first).toMatchObject({
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
    expect(await readFile(path.join(root, '.zennotes', 'vault.cloud-conflict.json'), 'utf8')).toBe(
      '{"favorites":["c"]}'
    )
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

    expect(conflict).toMatchObject({
      code: 'LOCAL_EDIT_CONFLICT',
      path: 'note.md',
      conflict_copy_path: null,
      local: { content: { data: 'local edit' } }
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
    const state = {
      version: 1 as const,
      vault_id: 'vault-1',
      cursor: 7,
      items: {}
    }

    await store.save(state)

    expect(await store.load('vault-1')).toEqual(state)
    expect(await store.load('another-vault')).toBeNull()
  })
})

describe('DesktopCloudSyncRepository: decisions and writes', () => {
  it('copies a file above the inline limit from disk when keeping both versions', async () => {
    const root = await temporaryRoot()
    const bytes = Buffer.alloc(CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES + 1, 7)
    await writeFile(path.join(root, 'Deck.pdf'), bytes)
    const repository = new DesktopCloudSyncRepository(root)
    const [local] = await repository.scan()
    expect(local.content.data).toBe('')

    await repository.applyConflictResolutionFiles({
      expected_path: 'Deck.pdf',
      expected_sha256: local.content.sha256,
      files: [
        { path: 'Deck.pdf', content: upsert('Deck.pdf', 'cloud bytes').content! },
        { path: 'Deck (this device).pdf', content: local.content }
      ]
    })

    expect((await readFile(path.join(root, 'Deck (this device).pdf'))).equals(bytes)).toBe(true)
    expect(await readFile(path.join(root, 'Deck.pdf'), 'utf8')).toBe('cloud bytes')
  }, 20_000)

  it('refuses to write a snapshot that carries no bytes and no source', async () => {
    const root = await temporaryRoot()
    await writeFile(path.join(root, 'Deck.pdf'), 'agreed')
    const repository = new DesktopCloudSyncRepository(root)

    await expect(
      repository.replaceConflictFile({
        path: 'Deck.pdf',
        expectedSha256: hash('agreed'),
        content: {
          encoding: 'base64',
          data: '',
          sha256: 'missing',
          byte_length: 10,
          media_type: 'application/pdf'
        }
      })
    ).rejects.toThrow('too large to copy')
    expect(await readFile(path.join(root, 'Deck.pdf'), 'utf8')).toBe('agreed')
  })

  it('writes through a symlinked note instead of replacing the link', async () => {
    const root = await temporaryRoot()
    const elsewhere = await temporaryRoot()
    const target = path.join(elsewhere, 'linked.md')
    await writeFile(target, 'agreed')
    try {
      await symlink(target, path.join(root, 'linked.md'))
    } catch {
      // Creating symlinks can require privileges (e.g. Windows); skip there.
      return
    }
    const repository = new DesktopCloudSyncRepository(root)

    await repository.replaceConflictFile({
      path: 'linked.md',
      expectedSha256: hash('agreed'),
      content: upsert('linked.md', 'from cloud').content!
    })

    expect((await lstat(path.join(root, 'linked.md'))).isSymbolicLink()).toBe(true)
    expect(await readFile(target, 'utf8')).toBe('from cloud')
  })

  it('leaves an existing note its own permissions', async () => {
    // Windows has no POSIX mode bits to keep.
    if (process.platform === 'win32') return
    const root = await temporaryRoot()
    await writeFile(path.join(root, 'private.md'), 'agreed')
    await chmod(path.join(root, 'private.md'), 0o600)
    const repository = new DesktopCloudSyncRepository(root)

    await repository.replaceConflictFile({
      path: 'private.md',
      expectedSha256: hash('agreed'),
      content: upsert('private.md', 'from cloud').content!
    })

    expect((await stat(path.join(root, 'private.md'))).mode & 0o777).toBe(0o600)
  })
})
