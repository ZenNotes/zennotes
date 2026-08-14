import { describe, expect, it } from 'vitest'
import type { CloudSyncChange } from '@zennotes/bridge-contract/cloud-sync'
import {
  CloudSyncLocalEditConflictError,
  PortableCloudSyncRepository,
  type CloudSyncFileEntry,
  type PortableCloudSyncFileSystem
} from './cloud-sync-portable-filesystem'

class MemoryFileSystem implements PortableCloudSyncFileSystem {
  readonly files = new Map<string, Uint8Array>()

  constructor(initial: Record<string, string | Uint8Array>) {
    for (const [path, value] of Object.entries(initial)) {
      this.files.set(path, typeof value === 'string' ? new TextEncoder().encode(value) : value)
    }
  }

  async readdir(directory: string): Promise<CloudSyncFileEntry[]> {
    const prefix = directory ? `${directory}/` : ''
    const entries = new Map<string, 'file' | 'directory'>()
    for (const path of this.files.keys()) {
      if (!path.startsWith(prefix)) continue
      const remainder = path.slice(prefix.length)
      const [name, ...rest] = remainder.split('/')
      if (!name) continue
      entries.set(name, rest.length > 0 ? 'directory' : 'file')
    }
    return [...entries].map(([name, type]) => ({ name, type }))
  }

  async stat(path: string): Promise<'file' | 'directory' | null> {
    if (this.files.has(path)) return 'file'
    const prefix = `${path}/`
    return [...this.files.keys()].some((candidate) => candidate.startsWith(prefix))
      ? 'directory'
      : null
  }

  async readBase64(path: string): Promise<string> {
    const bytes = this.files.get(path)
    if (!bytes) throw new Error(`Missing ${path}`)
    return bytesToBase64(bytes)
  }

  async writeText(path: string, value: string): Promise<void> {
    this.files.set(path, new TextEncoder().encode(value))
  }

  async writeBase64(path: string, value: string): Promise<void> {
    this.files.set(path, base64ToBytes(value))
  }

  async deleteFile(path: string): Promise<void> {
    this.files.delete(path)
  }

  async rename(from: string, to: string): Promise<void> {
    const value = this.files.get(from)
    if (!value) throw new Error(`Missing ${from}`)
    if (this.files.has(to)) throw new Error(`Destination exists: ${to}`)
    this.files.set(to, value)
    this.files.delete(from)
  }

  text(path: string): string | null {
    const value = this.files.get(path)
    return value ? new TextDecoder().decode(value) : null
  }
}

describe('PortableCloudSyncRepository', () => {
  it('scans portable user files with text/binary encoding and excludes local state', async () => {
    const fs = new MemoryFileSystem({
      'inbox/Plan.md': '# Plan',
      'assets/pixel.png': new Uint8Array([0, 255, 12]),
      '.zennotes/vault.json': '{"primaryNotesLocation":"inbox"}',
      '.zennotes/sync/device-state.json': '{"cursor":10}',
      '.git/config': 'secret'
    })

    const items = await new PortableCloudSyncRepository(fs).scan()

    expect(items.map((item) => item.path)).toEqual([
      '.zennotes/vault.json',
      'assets/pixel.png',
      'inbox/Plan.md'
    ])
    expect(items.find((item) => item.path === 'inbox/Plan.md')?.content).toMatchObject({
      encoding: 'utf8',
      data: '# Plan',
      media_type: 'text/markdown',
      byte_length: 6
    })
    expect(items.find((item) => item.path === 'assets/pixel.png')?.content).toMatchObject({
      encoding: 'base64',
      data: 'AP8M',
      media_type: 'image/png',
      byte_length: 3
    })
  })

  it('applies remote upserts, moves, and deletes', async () => {
    const fs = new MemoryFileSystem({ 'inbox/Old.md': 'one' })
    const repository = new PortableCloudSyncRepository(fs)
    await repository.apply(
      {
        sequence: 1,
        item_id: 'item-new',
        type: 'upsert',
        path: 'inbox/Remote.md',
        previous_path: null,
        revision: 1,
        content: await textContent('remote')
      },
      undefined
    )
    expect(fs.text('inbox/Remote.md')).toBe('remote')

    const previous = (await repository.scan())[0]!
    const tracked = {
      item_id: 'item-1',
      path: previous.path,
      kind: previous.kind,
      revision: 1,
      sha256: previous.content.sha256,
      byte_length: previous.content.byte_length,
      media_type: previous.content.media_type
    }

    await repository.apply(
      {
        sequence: 2,
        item_id: 'item-1',
        type: 'upsert',
        path: 'inbox/Old.md',
        previous_path: 'inbox/Old.md',
        revision: 2,
        content: await textContent('two')
      },
      tracked
    )
    expect(fs.text('inbox/Old.md')).toBe('two')

    const updated = { ...tracked, revision: 2, sha256: (await textContent('two')).sha256 }
    await repository.apply(
      {
        sequence: 3,
        item_id: 'item-1',
        type: 'move',
        path: 'archive/New.md',
        previous_path: 'inbox/Old.md',
        revision: 3
      },
      updated
    )
    expect(fs.text('inbox/Old.md')).toBeNull()
    expect(fs.text('archive/New.md')).toBe('two')

    await repository.apply(
      {
        sequence: 4,
        item_id: 'item-1',
        type: 'delete',
        path: 'archive/New.md',
        previous_path: 'archive/New.md',
        revision: 4
      },
      { ...updated, path: 'archive/New.md', revision: 3 }
    )
    expect(fs.text('archive/New.md')).toBeNull()
  })

  // Neither version is thrown away: the local file stays put and the incoming
  // one lands beside it. Throwing here used to stop the run before the cursor
  // was saved, so every later run replayed the same change and stopped too.
  it('keeps both versions instead of overwriting unsynced local edits', async () => {
    const fs = new MemoryFileSystem({ 'inbox/Plan.md': 'local edit' })
    const repository = new PortableCloudSyncRepository(fs)

    const conflict = await repository.apply(
      {
        sequence: 2,
        item_id: 'item-1',
        type: 'upsert',
        path: 'inbox/Plan.md',
        previous_path: 'inbox/Plan.md',
        revision: 2,
        content: await textContent('remote edit')
      },
      {
        item_id: 'item-1',
        path: 'inbox/Plan.md',
        kind: 'text',
        revision: 1,
        sha256: (await textContent('old synced value')).sha256,
        byte_length: 16,
        media_type: 'text/markdown'
      }
    )

    expect(conflict).toEqual({
      code: 'LOCAL_EDIT_CONFLICT',
      path: 'inbox/Plan.md',
      conflict_copy_path: 'inbox/Plan (cloud conflict).md'
    })
    expect(fs.text('inbox/Plan.md')).toBe('local edit')
    expect(fs.text('inbox/Plan (cloud conflict).md')).toBe('remote edit')
  })

  it('reports a parked settings choice until its cloud copy is removed', async () => {
    const fs = new MemoryFileSystem({
      '.zennotes/vault.json': '{"favorites":["local.md"]}'
    })
    const repository = new PortableCloudSyncRepository(fs)

    const conflict = await repository.apply(
      {
        sequence: 2,
        item_id: 'settings-1',
        type: 'upsert',
        path: '.zennotes/vault.json',
        previous_path: '.zennotes/vault.json',
        revision: 2,
        content: await textContent('{"favorites":["cloud.md"]}')
      },
      undefined
    )

    expect(conflict).toEqual({
      code: 'SETTINGS_CONFLICT',
      path: '.zennotes/vault.json',
      conflict_copy_path: '.zennotes/vault.cloud-conflict.json'
    })
    expect(await repository.pendingConflictPaths()).toEqual(['.zennotes/vault.json'])
    await fs.deleteFile('.zennotes/vault.cloud-conflict.json')
    expect(await repository.pendingConflictPaths()).toEqual([])
  })

  it('adopts a file that already matches the incoming change', async () => {
    const fs = new MemoryFileSystem({ '.zennotes/vault.json': '{"favorites":[]}' })
    const repository = new PortableCloudSyncRepository(fs)

    const conflict = await repository.apply(
      {
        sequence: 8,
        item_id: 'item-untracked',
        type: 'upsert',
        path: '.zennotes/vault.json',
        previous_path: null,
        revision: 3,
        content: await textContent('{"favorites":[]}')
      },
      undefined
    )

    expect(conflict).toBeUndefined()
    expect(fs.text('.zennotes/vault.json')).toBe('{"favorites":[]}')
  })

  it('keeps device-local workspace state out of scans and ignores remote workspace mutations', async () => {
    const fs = new MemoryFileSystem({
      '.zennotes/workspace.json': '{"device":"desktop"}',
      'inbox/Plan.md': '# Plan'
    })
    const repository = new PortableCloudSyncRepository(fs)

    expect((await repository.scan()).map((item) => item.path)).toEqual(['inbox/Plan.md'])

    await repository.apply(
      {
        sequence: 1,
        item_id: 'workspace-item',
        type: 'upsert',
        path: '.zennotes/workspace.json',
        previous_path: null,
        revision: 1,
        content: await textContent('{"device":"mobile"}')
      },
      undefined
    )

    expect(fs.text('.zennotes/workspace.json')).toBe('{"device":"desktop"}')
  })

  it('treats a replayed remote write as already applied after a client crash', async () => {
    const fs = new MemoryFileSystem({ 'inbox/Plan.md': 'remote edit' })
    const repository = new PortableCloudSyncRepository(fs)
    const change: CloudSyncChange = {
      sequence: 2,
      item_id: 'item-1',
      type: 'upsert',
      path: 'inbox/Plan.md',
      previous_path: 'inbox/Plan.md',
      revision: 2,
      content: await textContent('remote edit')
    }

    await expect(
      repository.apply(change, {
        item_id: 'item-1',
        path: 'inbox/Plan.md',
        kind: 'text',
        revision: 1,
        sha256: (await textContent('old synced value')).sha256,
        byte_length: 16,
        media_type: 'text/markdown'
      })
    ).resolves.toBeUndefined()
  })
})

async function textContent(data: string) {
  const bytes = new TextEncoder().encode(data)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return {
    encoding: 'utf8' as const,
    data,
    sha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
    byte_length: bytes.byteLength,
    media_type: 'text/markdown'
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}
