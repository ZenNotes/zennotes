import { describe, expect, it } from 'vitest'
import type { CloudSyncChange } from '@zennotes/bridge-contract/cloud-sync'
import { CloudSyncCoordinator, type CloudSyncRemote } from './cloud-sync-coordinator'
import type { CloudSyncState } from './cloud-sync-engine'
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

/**
 * A case-insensitive, case-preserving volume (an external drive, the iOS
 * simulator on a Mac): every spelling of a name reaches the one stored file.
 * Its rename overwrites the way Capacitor's does, removing an existing
 * destination before the move, so a direct case-only rename destroys its own
 * source.
 */
class CaseInsensitiveMemoryFileSystem extends MemoryFileSystem {
  private stored(path: string): string {
    const key = path.toLowerCase()
    return [...this.files.keys()].find((candidate) => candidate.toLowerCase() === key) ?? path
  }

  override async stat(path: string): Promise<'file' | 'directory' | null> {
    return super.stat(this.stored(path))
  }

  override async readBase64(path: string): Promise<string> {
    return super.readBase64(this.stored(path))
  }

  override async writeText(path: string, value: string): Promise<void> {
    await super.writeText(this.stored(path), value)
  }

  override async writeBase64(path: string, value: string): Promise<void> {
    await super.writeBase64(this.stored(path), value)
  }

  override async deleteFile(path: string): Promise<void> {
    await super.deleteFile(this.stored(path))
  }

  override async rename(from: string, to: string): Promise<void> {
    const source = this.stored(from)
    this.files.delete(this.stored(to))
    await super.rename(source, to)
  }
}

class FailingMemoryFileSystem extends MemoryFileSystem {
  constructor(
    initial: Record<string, string | Uint8Array>,
    private readonly failedPath: string
  ) {
    super(initial)
  }

  override async writeText(path: string, value: string): Promise<void> {
    if (path === this.failedPath) throw new Error(`Cannot write ${path}`)
    await super.writeText(path, value)
  }

  override async writeBase64(path: string, value: string): Promise<void> {
    if (path === this.failedPath) throw new Error(`Cannot write ${path}`)
    await super.writeBase64(path, value)
  }
}

describe('PortableCloudSyncRepository', () => {
  it('does not upload its own state or scan cache when the vault contains app storage', async () => {
    const statePath = 'zennotes-cloud-sync/states/vault/account/state.json'
    const cachePath = 'zennotes-cloud-sync/scan-cache/vault.json'
    const fs = new MemoryFileSystem({
      'note.md': 'User-authored note',
      'zennotes-cloud-sync/links/vault.json': '{"vault_id":"vault-1"}',
      [cachePath]: '{}'
    })
    let scans = 0
    class Repository extends PortableCloudSyncRepository {
      override async scan() {
        const items = await super.scan()
        await fs.writeText(cachePath, JSON.stringify({ scans: ++scans }))
        return items
      }
    }
    const changes: CloudSyncChange[] = []
    const remote: CloudSyncRemote = {
      manifest: async () => ({ data: [], cursor: 0, next_page: null }),
      changes: async (_vault, after) => ({ data: changes.filter(change => change.sequence > after), cursor: changes.length, has_more: false }),
      mutate: async (_vault, { mutations }) => ({
        acknowledged: mutations.map(mutation => {
          if (mutation.type !== 'upsert') throw new Error('Unexpected mutation in unchanged vault')
          const sequence = changes.length + 1
          const revision = (mutation.base_revision ?? 0) + 1
          changes.push({ sequence, revision, type: 'upsert', item_id: mutation.item_id,
            path: mutation.path, previous_path: null, content: mutation.content })
          return { sequence, revision, item_id: mutation.item_id, operation_id: mutation.operation_id }
        }),
        cursor: changes.length,
        conflicts: []
      })
    }
    let id = 0
    const summaries = []
    for (let run = 0; run < 3; run++) {
      summaries.push(await new CloudSyncCoordinator('vault-1', remote, new Repository(fs), {
        load: async () => fs.text(statePath) ? JSON.parse(fs.text(statePath)!) as CloudSyncState : null,
        save: async state => { await fs.writeText(statePath, JSON.stringify(state)) }
      }, { itemId: () => `item-${++id}`, operationId: () => `operation-${++id}` }).sync())
    }
    expect(summaries.map(summary => summary.pushed)).toEqual([1, 0, 0])
    expect(changes.map(change => change.path)).toEqual(['note.md'])
    expect(fs.text('note.md')).toBe('User-authored note')
    expect(fs.text(statePath)).not.toBeNull()
    expect(fs.text(cachePath)).not.toBeNull()
  })

  it.each(['upsert', 'move', 'delete'] as const)('never applies remote %s to device-local runtime storage', async type => {
    const path = 'zennotes-cloud-sync/states/vault.json'
    const current = await textContent('Local state')
    const fs = new MemoryFileSystem({ [path]: current.data })
    await new PortableCloudSyncRepository(fs).apply({
      item_id: 'runtime', sequence: 2, revision: 2, type,
      path: type === 'move' ? 'moved.json' : path, previous_path: path,
      ...(type === 'upsert' ? { content: await textContent('Remote state') } : {})
    }, { item_id: 'runtime', revision: 1, path, kind: 'text', sha256: current.sha256,
      byte_length: current.byte_length, media_type: current.media_type })
    expect(fs.text(path)).toBe('Local state')
    expect(fs.text('moved.json')).toBeNull()
  })

  it('rejects unrecognized metadata before creating any conflict files', async () => {
    const fs = new MemoryFileSystem({ 'note.md': 'original' })
    const repository = new PortableCloudSyncRepository(fs)
    const original = await textContent('original')
    const missing = { ...await textContent('missing'), data: '' }
    await expect(repository.applyConflictResolutionFiles({
      expected_path: 'note.md', expected_sha256: original.sha256,
      files: [{ path: 'copy.md', content: original }, { path: 'note.md', content: missing }]
    })).rejects.toThrow('source bytes')
    expect([...fs.files.keys()]).toEqual(['note.md'])
    expect(fs.text('note.md')).toBe('original')
  })

  it('uses native content hooks for inherited reads, validation and writes', async () => {
    const fs = new MemoryFileSystem({ 'note.md': 'original' })
    const original = await textContent('original')
    const incoming = await textContent('incoming')
    const validated: string[] = []
    const sourceAware: PortableCloudSyncFileSystem = fs
    sourceAware.readItem = async (path) => ({ path, kind: 'text', content: { ...original, data: '' } })
    sourceAware.validateContent = async (content) => { validated.push(content.sha256) }
    sourceAware.writeContent = async (path, content) => { await fs.writeText(path, content.data) }
    fs.readBase64 = async () => { throw new Error('A native fingerprint must not read inline bytes') }
    await new PortableCloudSyncRepository(sourceAware).replaceConflictFile({
      path: 'note.md', expectedSha256: original.sha256, content: incoming
    })
    expect(fs.text('note.md')).toBe('incoming')
    expect(validated).toContain(incoming.sha256)
  })

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

    const updated = {
      ...tracked,
      revision: 2,
      sha256: (await textContent('two')).sha256
    }
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
  it('returns both versions without writing a conflict copy into the vault', async () => {
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

    expect(conflict).toMatchObject({
      code: 'LOCAL_EDIT_CONFLICT',
      path: 'inbox/Plan.md',
      conflict_copy_path: null,
      local: { path: 'inbox/Plan.md', content: { data: 'local edit' } }
    })
    expect(fs.text('inbox/Plan.md')).toBe('local edit')
    expect(fs.files.has('inbox/Plan (cloud conflict).md')).toBe(false)
  })

  it('applies explicit Cloud, keep-both, and merged bootstrap decisions', async () => {
    const local = await textContent('local edit')
    const cloud = await textContent('cloud edit')
    const conflict = {
      code: 'BOOTSTRAP_CONTENT_CONFLICT' as const,
      item_id: 'item-1',
      path: 'inbox/Plan.md',
      local_sha256: local.sha256,
      remote_sha256: cloud.sha256
    }

    const cloudFs = new MemoryFileSystem({ 'inbox/Plan.md': 'local edit' })
    await new PortableCloudSyncRepository(cloudFs).resolveBootstrapConflict({
      path: conflict.path,
      expectedLocalSha256: local.sha256,
      cloudContent: cloud,
      resolution: { conflict, choice: 'cloud' }
    })
    expect(cloudFs.text('inbox/Plan.md')).toBe('cloud edit')

    const bothFs = new MemoryFileSystem({ 'inbox/Plan.md': 'local edit' })
    await new PortableCloudSyncRepository(bothFs).resolveBootstrapConflict({
      path: conflict.path,
      expectedLocalSha256: local.sha256,
      cloudContent: cloud,
      resolution: {
        conflict,
        choice: 'both',
        keep_both_path: 'inbox/Plan (this device).md'
      }
    })
    expect(bothFs.text('inbox/Plan.md')).toBe('cloud edit')
    expect(bothFs.text('inbox/Plan (this device).md')).toBe('local edit')

    const mergedFs = new MemoryFileSystem({ 'inbox/Plan.md': 'local edit' })
    await new PortableCloudSyncRepository(mergedFs).resolveBootstrapConflict({
      path: conflict.path,
      expectedLocalSha256: local.sha256,
      cloudContent: cloud,
      resolution: { conflict, choice: 'merged', merged_text: 'merged result' }
    })
    expect(mergedFs.text('inbox/Plan.md')).toBe('merged result')
  })

  it('materializes a complete conflict decision without overwriting another file', async () => {
    const local = await textContent('local edit')
    const cloud = await textContent('cloud edit')
    const fs = new MemoryFileSystem({
      'inbox/Plan.md': 'local edit',
      'inbox/Existing.md': 'leave me alone'
    })
    const repository = new PortableCloudSyncRepository(fs)

    await repository.applyConflictResolutionFiles({
      expected_path: 'inbox/Plan.md',
      expected_sha256: local.sha256,
      files: [
        { path: 'archive/Plan.md', content: cloud },
        { path: 'inbox/Plan from phone.md', content: local }
      ]
    })

    expect(fs.text('inbox/Plan.md')).toBeNull()
    expect(fs.text('archive/Plan.md')).toBe('cloud edit')
    expect(fs.text('inbox/Plan from phone.md')).toBe('local edit')
    await expect(
      repository.applyConflictResolutionFiles({
        expected_path: 'archive/Plan.md',
        expected_sha256: cloud.sha256,
        files: [{ path: 'inbox/Existing.md', content: cloud }]
      })
    ).rejects.toThrow('already exists')
    expect(fs.text('archive/Plan.md')).toBe('cloud edit')
    expect(fs.text('inbox/Existing.md')).toBe('leave me alone')
  })

  it('removes newly created resolution files when a later write fails', async () => {
    const local = await textContent('local edit')
    const fs = new FailingMemoryFileSystem({ 'inbox/Plan.md': 'local edit' }, 'blocked/Plan.md')
    const repository = new PortableCloudSyncRepository(fs)

    await expect(
      repository.applyConflictResolutionFiles({
        expected_path: 'inbox/Plan.md',
        expected_sha256: local.sha256,
        files: [
          { path: 'copy/Plan.md', content: await textContent('safe copy') },
          { path: 'blocked/Plan.md', content: await textContent('fails') }
        ]
      })
    ).rejects.toThrow('Cannot write blocked/Plan.md')

    expect(fs.text('inbox/Plan.md')).toBe('local edit')
    expect(fs.text('copy/Plan.md')).toBeNull()
    expect(fs.text('blocked/Plan.md')).toBeNull()
  })

  it('moves a different file of this device aside for the other device\'s version', async () => {
    // Dave's phone: the computer trashed the note the phone edited, and the
    // phone had trashed an Untitled.md of its own into the same slot.
    const edited = await textContent('edited on the phone')
    const cloud = await textContent('written on the computer')
    const fs = new MemoryFileSystem({
      'inbox/Daily Notes/Untitled.md': 'edited on the phone',
      'trash/Daily Notes/Untitled.md': 'the phone\'s own scratch',
      'trash/Daily Notes/Untitled 2.md': 'already the second one'
    })
    await new PortableCloudSyncRepository(fs).applyConflictResolutionFiles({
      expected_path: 'inbox/Daily Notes/Untitled.md',
      expected_sha256: edited.sha256,
      files: [{ path: 'trash/Daily Notes/Untitled.md', content: cloud, displace_existing: true }]
    })
    expect(fs.text('trash/Daily Notes/Untitled.md')).toBe('written on the computer')
    expect(fs.text('trash/Daily Notes/Untitled 3.md')).toBe('the phone\'s own scratch')
    expect(fs.text('trash/Daily Notes/Untitled 2.md')).toBe('already the second one')
    expect(fs.text('inbox/Daily Notes/Untitled.md')).toBeNull()
  })

  it('moves this device\'s file back when the other device\'s version cannot be written', async () => {
    const edited = await textContent('edited')
    const fs = new FailingMemoryFileSystem({ 'inbox/a.md': 'edited', 'trash/a.md': 'scratch' }, 'trash/a.md')
    await expect(
      new PortableCloudSyncRepository(fs).applyConflictResolutionFiles({
        expected_path: 'inbox/a.md',
        expected_sha256: edited.sha256,
        files: [{ path: 'trash/a.md', content: await textContent('cloud'), displace_existing: true }]
      })
    ).rejects.toThrow('Cannot write trash/a.md')
    expect(fs.text('trash/a.md')).toBe('scratch')
    expect(fs.text('trash/a 2.md')).toBeNull()
    expect(fs.text('inbox/a.md')).toBe('edited')
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

    expect(conflict).toMatchObject({
      code: 'SETTINGS_CONFLICT',
      path: '.zennotes/vault.json',
      conflict_copy_path: '.zennotes/vault.cloud-conflict.json'
    })
    expect(await repository.pendingConflictPaths()).toEqual(['.zennotes/vault.json'])
    await fs.deleteFile('.zennotes/vault.cloud-conflict.json')
    expect(await repository.pendingConflictPaths()).toEqual([])
  })

  it('adopts a file that already matches the incoming change', async () => {
    const fs = new MemoryFileSystem({
      '.zennotes/vault.json': '{"favorites":[]}'
    })
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

// On a case-insensitive volume both spellings of a case-only rename reach one
// file. Treating them as two removed the note just written, or refused the
// write as a conflict with itself.
describe('PortableCloudSyncRepository: an upsert that only changes the case of its path', () => {
  it.each(['agreed', 'remote edit'])('keeps the one file, holding %j, under its new spelling', async (incoming) => {
    const fs = new CaseInsensitiveMemoryFileSystem({ 'note.md': 'agreed' })

    const conflict = await new PortableCloudSyncRepository(fs).apply(
      await upsertFrom('note.md', 'Note.md', incoming),
      await tracked('note.md', 'agreed')
    )

    expect(conflict).toBeUndefined()
    expect([...fs.files.keys()]).toEqual(['Note.md'])
    expect(fs.text('Note.md')).toBe(incoming)
  })

  // How a replay finds the volume when the new bytes landed but the new
  // spelling did not.
  it('finishes the rename on replay once the new bytes are already in place', async () => {
    const fs = new CaseInsensitiveMemoryFileSystem({ 'note.md': 'remote edit' })

    const conflict = await new PortableCloudSyncRepository(fs).apply(
      await upsertFrom('note.md', 'Note.md', 'remote edit'),
      await tracked('note.md', 'agreed')
    )

    expect(conflict).toBeUndefined()
    expect([...fs.files.keys()]).toEqual(['Note.md'])
    expect(fs.text('Note.md')).toBe('remote edit')
  })

  it('keeps a local edit made under the old spelling', async () => {
    const fs = new CaseInsensitiveMemoryFileSystem({ 'note.md': 'local edit' })

    const conflict = await new PortableCloudSyncRepository(fs).apply(
      await upsertFrom('note.md', 'Note.md', 'remote edit'),
      await tracked('note.md', 'agreed')
    )

    expect(conflict).toMatchObject({ code: 'LOCAL_EDIT_CONFLICT', path: 'note.md' })
    expect([...fs.files.keys()]).toEqual(['note.md'])
    expect(fs.text('note.md')).toBe('local edit')
  })

  // A case-sensitive volume (the iOS app container, Android app storage) holds
  // two files, and leaving the old one behind would stop every later scan on
  // a portable path collision.
  it('removes the old spelling on a case-sensitive volume, where it is a separate file', async () => {
    const fs = new MemoryFileSystem({ 'note.md': 'agreed' })

    const conflict = await new PortableCloudSyncRepository(fs).apply(
      await upsertFrom('note.md', 'Note.md', 'agreed'),
      await tracked('note.md', 'agreed')
    )

    expect(conflict).toBeUndefined()
    expect([...fs.files.keys()]).toEqual(['Note.md'])
    expect(fs.text('Note.md')).toBe('agreed')
  })

  it('never writes over a separate file whose name differs only in case', async () => {
    const fs = new MemoryFileSystem({ 'note.md': 'agreed', 'Note.md': 'another note' })

    const conflict = await new PortableCloudSyncRepository(fs).apply(
      await upsertFrom('note.md', 'Note.md', 'remote edit'),
      await tracked('note.md', 'agreed')
    )

    expect(conflict).toMatchObject({ code: 'LOCAL_EDIT_CONFLICT', path: 'Note.md' })
    expect(fs.text('note.md')).toBe('agreed')
    expect(fs.text('Note.md')).toBe('another note')
  })

  it('still removes the old file when an upsert moves the item to a different path', async () => {
    const fs = new CaseInsensitiveMemoryFileSystem({ 'trash/Note.md': 'agreed' })

    const conflict = await new PortableCloudSyncRepository(fs).apply(
      await upsertFrom('trash/Note.md', 'Note.md', 'agreed'),
      await tracked('trash/Note.md', 'agreed')
    )

    expect(conflict).toBeUndefined()
    expect([...fs.files.keys()]).toEqual(['Note.md'])
    expect(fs.text('Note.md')).toBe('agreed')
  })
})

// The case-only rename above takes two steps on a case-insensitive volume. The
// app can stop between them, leaving the note under a name sync ignores, and a
// save can land between them, which the second step used to rename over.
describe('PortableCloudSyncRepository: an interrupted case-only rename', () => {
  const RECORDS = '.zennotes/zennotes-cloud-sync/respellings'

  class InterruptibleFileSystem extends CaseInsensitiveMemoryFileSystem {
    stopAtSecondStep = false
    afterFirstStep?: () => Promise<void>

    override async rename(from: string, to: string): Promise<void> {
      if (from.endsWith('.tmp') && this.stopAtSecondStep) throw new Error('the app stopped')
      await super.rename(from, to)
      if (to.endsWith('.tmp')) await this.afterFirstStep?.()
    }

    names(): string[] {
      return [...this.files.keys()].sort()
    }

    detour(): string {
      const detour = this.names().find((name) => name.endsWith('.tmp'))
      if (!detour) throw new Error('no detour on the volume')
      return detour
    }
  }

  async function stopBetweenSteps(fs: InterruptibleFileSystem, incoming: string): Promise<string> {
    fs.stopAtSecondStep = true
    await expect(
      new PortableCloudSyncRepository(fs).apply(
        await upsertFrom('note.md', 'Note.md', incoming),
        await tracked('note.md', 'agreed')
      )
    ).rejects.toThrow('the app stopped')
    fs.stopAtSecondStep = false
    return fs.detour()
  }

  it('finishes the rename on the next run, from the record written before the first step', async () => {
    const fs = new InterruptibleFileSystem({ 'note.md': 'agreed' })
    const detour = await stopBetweenSteps(fs, 'remote edit')
    expect(fs.names()).toEqual([`${RECORDS}/${detour.slice('Note.md.'.length, -'.tmp'.length)}.json`, detour].sort())

    await new PortableCloudSyncRepository(fs).recoverInterruptedWork()

    expect(fs.names()).toEqual(['Note.md'])
    expect(fs.text('Note.md')).toBe('remote edit')
  })

  it('keeps both files when the name was taken before the next run', async () => {
    const fs = new InterruptibleFileSystem({ 'note.md': 'agreed' })
    const detour = await stopBetweenSteps(fs, 'remote edit')
    await fs.writeText('note.md', 'typed after relaunch')

    await new PortableCloudSyncRepository(fs).recoverInterruptedWork()

    expect(fs.names()).toEqual([detour, 'note.md'])
    expect(fs.text('note.md')).toBe('typed after relaunch')
    expect(fs.text(detour)).toBe('remote edit')
  })

  it('drops the parked copy once the same bytes are back under the name', async () => {
    const fs = new InterruptibleFileSystem({ 'note.md': 'agreed' })
    await stopBetweenSteps(fs, 'remote edit')
    // A replay that ran before recovery wrote the Cloud bytes there again.
    await fs.writeText('Note.md', 'remote edit')

    await new PortableCloudSyncRepository(fs).recoverInterruptedWork()

    expect(fs.names()).toEqual(['Note.md'])
    expect(fs.text('Note.md')).toBe('remote edit')
  })

  it('never renames over a save that landed between the two steps', async () => {
    const fs = new InterruptibleFileSystem({ 'note.md': 'agreed' })
    // The editor still holds the note under its old spelling and saves.
    fs.afterFirstStep = () => fs.writeText('note.md', 'typed between the steps')

    const conflict = await new PortableCloudSyncRepository(fs).apply(
      await upsertFrom('note.md', 'Note.md', 'remote edit'),
      await tracked('note.md', 'agreed')
    )

    expect(conflict).toBeUndefined()
    expect(fs.text('note.md')).toBe('typed between the steps')
    expect(fs.text(fs.detour())).toBe('remote edit')

    await new PortableCloudSyncRepository(fs).recoverInterruptedWork()
    expect(fs.names()).toEqual([fs.detour(), 'note.md'])
    expect(fs.text('note.md')).toBe('typed between the steps')
  })

  it('clears a record it cannot trust without touching any file', async () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e'
    const fs = new InterruptibleFileSystem({
      'note.md': 'agreed',
      [`other.md.${id}.tmp`]: 'parked elsewhere',
      [`${RECORDS}/torn.json`]: '{"path":',
      [`${RECORDS}/${id}.json`]: JSON.stringify({ path: 'note.md', detour: `other.md.${id}.tmp` })
    })

    await new PortableCloudSyncRepository(fs).recoverInterruptedWork()

    expect(fs.names()).toEqual(['note.md', `other.md.${id}.tmp`])
    expect(fs.text('note.md')).toBe('agreed')
  })

  it('never fails a run over a record it cannot settle yet, and keeps it for the next run', async () => {
    class UnreadyFileSystem extends InterruptibleFileSystem {
      ready = false
      override async readBase64(path: string): Promise<string> {
        if (!this.ready && path.endsWith('.tmp')) throw new Error('native storage is not ready')
        return super.readBase64(path)
      }
    }
    const fs = new UnreadyFileSystem({ 'note.md': 'agreed' })
    fs.stopAtSecondStep = true
    await expect(
      new PortableCloudSyncRepository(fs).apply(
        await upsertFrom('note.md', 'Note.md', 'remote edit'),
        await tracked('note.md', 'agreed')
      )
    ).rejects.toThrow('the app stopped')
    fs.stopAtSecondStep = false
    await fs.writeText('Note.md', 'remote edit')
    const parked = [...fs.files.keys()]

    await expect(new PortableCloudSyncRepository(fs).recoverInterruptedWork()).resolves.toBeUndefined()
    expect([...fs.files.keys()]).toEqual(parked)

    fs.ready = true
    await new PortableCloudSyncRepository(fs).recoverInterruptedWork()
    expect([...fs.files.keys()]).toEqual(['Note.md'])
  })

  it('finishes an interrupted rename before the next sync run pulls or scans', async () => {
    const statePath = 'zennotes-cloud-sync/state.json'
    const fs = new InterruptibleFileSystem({ 'note.md': 'agreed' })
    const changes: CloudSyncChange[] = []
    const mutations: string[] = []
    const remote: CloudSyncRemote = {
      manifest: async () => ({ data: [], cursor: 0, next_page: null }),
      changes: async (_vault, after) => ({ data: changes.filter((change) => change.sequence > after), cursor: changes.length, has_more: false }),
      mutate: async (_vault, body) => ({
        acknowledged: body.mutations.map((mutation) => {
          mutations.push(`${mutation.type} ${'path' in mutation ? mutation.path : ''}`)
          const sequence = changes.length + 1
          const revision = (mutation.base_revision ?? 0) + 1
          if (mutation.type !== 'upsert') throw new Error(`Unexpected ${mutation.type}`)
          changes.push({ sequence, revision, type: 'upsert', item_id: mutation.item_id,
            path: mutation.path, previous_path: null, content: mutation.content })
          return { sequence, revision, item_id: mutation.item_id, operation_id: mutation.operation_id }
        }),
        cursor: changes.length,
        conflicts: []
      })
    }
    let id = 0
    const sync = () => new CloudSyncCoordinator('vault-1', remote, new PortableCloudSyncRepository(fs), {
      load: async () => (fs.text(statePath) ? JSON.parse(fs.text(statePath)!) as CloudSyncState : null),
      save: async (state) => {
        if (fs.stopAtSecondStep) throw new Error('the app stopped')
        await fs.writeText(statePath, JSON.stringify(state))
      }
    }, { itemId: () => `item-${++id}`, operationId: () => `operation-${++id}` }).sync()

    await sync()
    const [created] = changes
    const edit = await textContent('remote edit')
    changes.push({ sequence: 2, revision: 2, type: 'upsert', item_id: created.item_id,
      path: 'Note.md', previous_path: 'note.md', content: edit })

    fs.stopAtSecondStep = true
    await expect(sync()).rejects.toThrow('the app stopped')
    fs.stopAtSecondStep = false
    await sync()

    expect(fs.names().filter((name) => !name.startsWith('zennotes-cloud-sync/'))).toEqual(['Note.md'])
    expect(fs.text('Note.md')).toBe('remote edit')
    expect(mutations).toEqual(['upsert note.md'])
  })
})

/** Counts the files read, the way a phone pays for each one in native work. */
class CountingMemoryFileSystem extends MemoryFileSystem {
  readonly reads: string[] = []

  override async readBase64(path: string): Promise<string> {
    this.reads.push(path)
    return super.readBase64(path)
  }
}

// Discord, 2026-10-26: on a phone that had just pulled a computer's vault,
// opening one first-sync conflict read and hashed every note in the vault.
describe('PortableCloudSyncRepository: opening one waiting conflict', () => {
  async function firstSyncWithConflict() {
    const statePath = 'zennotes-cloud-sync/state.json'
    const notes: Record<string, string> = {}
    for (let index = 1; index <= 200; index++) notes[`inbox/Note ${index}.md`] = `note ${index}`
    const fs = new CountingMemoryFileSystem({ ...notes, 'inbox/Shopping.md': 'Eggs (from the phone)' })
    const cloudFiles = { ...notes, 'inbox/Shopping.md': 'Coffee (from the PC)' }
    const items = await Promise.all(Object.entries(cloudFiles).map(async ([path, text], index) => {
      const content = await textContent(text)
      return { item_id: `item-${index}`, path, kind: 'text' as const, revision: 1, sha256: content.sha256,
        byte_length: content.byte_length, media_type: content.media_type, content }
    }))
    const remote: CloudSyncRemote = {
      manifest: async () => ({ data: items, cursor: items.length, next_page: null }),
      changes: async () => ({ data: [], cursor: items.length, has_more: false }),
      mutate: async () => { throw new Error('nothing should be pushed') }
    }
    let id = 0
    const coordinator = new CloudSyncCoordinator('vault-1', remote, new PortableCloudSyncRepository(fs), {
      load: async () => (fs.text(statePath) ? JSON.parse(fs.text(statePath)!) as CloudSyncState : null),
      save: async (state) => fs.writeText(statePath, JSON.stringify(state))
    }, { itemId: () => `new-${++id}`, operationId: () => `operation-${++id}` })
    const run = await coordinator.sync()
    expect(run.pendingConflicts.map((conflict) => conflict.path)).toEqual(['inbox/Shopping.md'])
    fs.reads.length = 0
    return { fs, coordinator, conflictId: run.pendingConflicts[0]!.id }
  }

  it('reads only that file, not the whole vault', async () => {
    const { fs, coordinator, conflictId } = await firstSyncWithConflict()

    await expect(coordinator.getConflict(conflictId)).resolves.toMatchObject({
      local: { path: 'inbox/Shopping.md', text: 'Eggs (from the phone)' },
      cloud: { path: 'inbox/Shopping.md', text: 'Coffee (from the PC)' }
    })
    expect(fs.reads).toEqual(['inbox/Shopping.md'])
  })

  it('still finds this device\'s version after it moved', async () => {
    const { fs, coordinator, conflictId } = await firstSyncWithConflict()
    await fs.rename('inbox/Shopping.md', 'Errands/Shopping.md')

    await expect(coordinator.getConflict(conflictId)).resolves.toMatchObject({
      local: { path: 'Errands/Shopping.md', text: 'Eggs (from the phone)' }
    })
    expect(fs.reads.length).toBeGreaterThan(200)
  })
})

describe('PortableCloudSyncRepository.readLocalItem', () => {
  it('reads the file at exactly that path', async () => {
    const repository = new PortableCloudSyncRepository(new MemoryFileSystem({ 'inbox/Plan.md': 'plan' }))

    await expect(repository.readLocalItem('inbox/Plan.md')).resolves.toMatchObject({
      path: 'inbox/Plan.md', kind: 'text', content: { data: 'plan' }
    })
  })

  // The scan reports the spelling stored on disk, so any other spelling is
  // left to it rather than read under the asked-for name.
  it('leaves a name stored in other letter case to the scan', async () => {
    const repository = new PortableCloudSyncRepository(
      new CaseInsensitiveMemoryFileSystem({ 'inbox/plan.md': 'plan' })
    )

    await expect(repository.readLocalItem('inbox/Plan.md')).resolves.toBeNull()
    await expect(repository.readLocalItem('Inbox/plan.md')).resolves.toBeNull()
    await expect(repository.readLocalItem('inbox/plan.md')).resolves.toMatchObject({ path: 'inbox/plan.md' })
  })

  it('finds nothing where the scan would list nothing', async () => {
    const repository = new PortableCloudSyncRepository(new MemoryFileSystem({
      'inbox/Plan.md/inside.md': 'a folder named like a note',
      '.zennotes/sync/downloads/staged.md': 'sync work',
      'zennotes-cloud-sync/state.json': '{}'
    }))

    await expect(repository.readLocalItem('inbox/Plan.md')).resolves.toBeNull()
    await expect(repository.readLocalItem('inbox/Missing.md')).resolves.toBeNull()
    await expect(repository.readLocalItem('Missing/Plan.md')).resolves.toBeNull()
    await expect(repository.readLocalItem('.zennotes/sync/downloads/staged.md')).resolves.toBeNull()
    await expect(repository.readLocalItem('zennotes-cloud-sync/state.json')).resolves.toBeNull()
  })
})

async function tracked(path: string, data: string) {
  const content = await textContent(data)
  return {
    item_id: 'item-1',
    path,
    kind: 'text' as const,
    revision: 1,
    sha256: content.sha256,
    byte_length: content.byte_length,
    media_type: content.media_type
  }
}

async function upsertFrom(previousPath: string, path: string, data: string): Promise<CloudSyncChange> {
  return {
    sequence: 2,
    item_id: 'item-1',
    type: 'upsert',
    path,
    previous_path: previousPath,
    revision: 2,
    content: await textContent(data)
  }
}

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
