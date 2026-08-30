import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type {
  CloudSyncChange,
  CloudSyncContent,
  CloudSyncManifestResponse,
  CloudSyncMutationRequest,
  CloudSyncMutationResponse
} from '@zennotes/bridge-contract/cloud-sync'
import {
  CloudSyncCoordinator,
  type CloudSyncRemote,
  type CloudSyncRepository,
  type CloudSyncStateStore
} from './cloud-sync-coordinator'
import type {
  CloudSyncIdSource,
  CloudSyncLocalItem,
  CloudSyncState,
  CloudSyncTrackedItem
} from './cloud-sync-engine'
import {
  PortableCloudSyncRepository,
  type PortableCloudSyncFileSystem
} from './cloud-sync-portable-filesystem'

function content(data: string): CloudSyncContent {
  return {
    encoding: 'utf8',
    data,
    sha256: `hash:${data}`,
    byte_length: data.length,
    media_type: 'text/markdown'
  }
}

function binaryContent(data: string): CloudSyncContent {
  return {
    encoding: 'base64',
    data,
    sha256: `hash:${data}`,
    byte_length: data.length,
    media_type: 'image/jpeg'
  }
}

function ids(): CloudSyncIdSource {
  let item = 0
  let operation = 0
  return {
    itemId: () => `item-local-${++item}`,
    operationId: () => `operation-${++operation}`
  }
}

function memoryState(initial: CloudSyncState | null = null): CloudSyncStateStore & {
  current: CloudSyncState | null
} {
  return {
    current: initial,
    async load() {
      return this.current
    },
    async save(state) {
      this.current = structuredClone(state)
    }
  }
}

function memoryRepository(initial: CloudSyncLocalItem[]): CloudSyncRepository & {
  items: CloudSyncLocalItem[]
} {
  return {
    items: initial,
    async scan() {
      return this.items
    },
    async apply(change: CloudSyncChange, previous: CloudSyncTrackedItem | undefined) {
      if (change.type === 'delete') {
        this.items = this.items.filter((item) => item.path !== (previous?.path ?? change.path))
      } else if (change.type === 'move') {
        const item = this.items.find((candidate) => candidate.path === previous?.path)
        if (item) item.path = change.path
      } else if (change.content) {
        this.items = this.items.filter((item) => item.path !== change.path)
        this.items.push({ path: change.path, kind: 'text', content: change.content })
      }
    }
  }
}

function remote(options: {
  manifest?: CloudSyncManifestResponse
  changes?: CloudSyncChange[]
  mutate?: (body: CloudSyncMutationRequest) => CloudSyncMutationResponse
}): CloudSyncRemote & { mutations: CloudSyncMutationRequest[] } {
  const mutations: CloudSyncMutationRequest[] = []
  return {
    mutations,
    async manifest() {
      return (
        options.manifest ?? { data: [], cursor: 0, next_page: null }
      ) as CloudSyncManifestResponse
    },
    async changes(_vaultId, after) {
      const data = (options.changes ?? []).filter((change) => change.sequence > after)
      return { data, cursor: data.at(-1)?.sequence ?? after, has_more: false }
    },
    async mutate(_vaultId, body) {
      mutations.push(body)
      return options.mutate?.(body) ?? {
        acknowledged: body.mutations.map((mutation, index) => ({
          operation_id: mutation.operation_id,
          item_id: mutation.item_id,
          revision: 1,
          sequence: index + 1
        })),
        conflicts: [],
        cursor: body.mutations.length
      }
    }
  }
}

describe('CloudSyncCoordinator', () => {
  it('applies only the newest remote revision of a file when catching up (#661)', async () => {
    const finalBody = '## Tasks\n\n- [ ] Rolled over once\n'
    const localItem: CloudSyncLocalItem = {
      path: 'inbox/Daily Notes/2026-08-21.md',
      kind: 'text',
      content: content(finalBody)
    }
    const applied: CloudSyncChange[] = []
    const repository: CloudSyncRepository = {
      async scan() {
        return [localItem]
      },
      async apply(change) {
        applied.push(change)
        if (change.content?.sha256 === localItem.content.sha256) return
        return {
          code: 'LOCAL_EDIT_CONFLICT',
          path: change.path,
          conflict_copy_path: `inbox/Daily Notes/2026-08-21 (cloud conflict ${applied.length}).md`
        }
      }
    }
    const states = memoryState({
      version: 1,
      vault_id: 'vault-1',
      cursor: 1,
      items: {
        'daily-note': {
          item_id: 'daily-note',
          path: localItem.path,
          kind: 'text',
          revision: 1,
          sha256: 'hash:yesterday',
          byte_length: 9,
          media_type: 'text/markdown'
        }
      }
    })
    const server = remote({
      changes: [
        {
          sequence: 2,
          item_id: 'daily-note',
          type: 'upsert',
          path: localItem.path,
          previous_path: null,
          revision: 2,
          content: content('')
        },
        {
          sequence: 3,
          item_id: 'daily-note',
          type: 'upsert',
          path: localItem.path,
          previous_path: null,
          revision: 3,
          content: content('## Tasks\n')
        },
        {
          sequence: 4,
          item_id: 'daily-note',
          type: 'upsert',
          path: localItem.path,
          previous_path: null,
          revision: 4,
          content: content(finalBody)
        }
      ]
    })

    const result = await new CloudSyncCoordinator(
      'vault-1',
      server,
      repository,
      states,
      ids()
    ).sync()

    expect(applied.map((change) => change.sequence)).toEqual([4])
    expect(result.localConflicts).toEqual([])
    expect(result.pulled).toBe(3)
    expect(result.pushed).toBe(0)
    expect(states.current?.cursor).toBe(4)
  })

  it('keeps structural changes while coalescing later content revisions (#661)', async () => {
    const repository = memoryRepository([
      { path: 'inbox/Old daily.md', kind: 'text', content: content('old') }
    ])
    const states = memoryState({
      version: 1,
      vault_id: 'vault-1',
      cursor: 1,
      items: {
        'daily-note': {
          item_id: 'daily-note',
          path: 'inbox/Old daily.md',
          kind: 'text',
          revision: 1,
          sha256: 'hash:old',
          byte_length: 3,
          media_type: 'text/markdown'
        }
      }
    })
    const server = remote({
      changes: [
        {
          sequence: 2,
          item_id: 'daily-note',
          type: 'move',
          path: 'inbox/Daily Notes/2026-08-21.md',
          previous_path: 'inbox/Old daily.md',
          revision: 2
        },
        {
          sequence: 3,
          item_id: 'daily-note',
          type: 'upsert',
          path: 'inbox/Daily Notes/2026-08-21.md',
          previous_path: null,
          revision: 3,
          content: content('')
        },
        {
          sequence: 4,
          item_id: 'daily-note',
          type: 'upsert',
          path: 'inbox/Daily Notes/2026-08-21.md',
          previous_path: null,
          revision: 4,
          content: content('## Tasks\n\n- [ ] Rolled over once\n')
        }
      ]
    })

    await new CloudSyncCoordinator('vault-1', server, repository, states, ids()).sync()

    expect(repository.items).toEqual([
      {
        path: 'inbox/Daily Notes/2026-08-21.md',
        kind: 'text',
        content: content('## Tasks\n\n- [ ] Rolled over once\n')
      }
    ])
  })

  // The Discord report behind this: a change for a file the device had never
  // tracked threw, the run stopped before saving the cursor, and every later
  // run replayed the same change and stopped at the same place. A repository
  // that reports a conflict instead of throwing has to leave the run able to
  // finish, or sync is wedged for good.
  it('finishes the run and advances the cursor when a file reports a conflict', async () => {
    const repository: CloudSyncRepository = {
      async scan() {
        return []
      },
      async apply(change) {
        return {
          code: 'LOCAL_EDIT_CONFLICT',
          path: change.path,
          conflict_copy_path: `${change.path} (cloud conflict)`
        }
      }
    }
    const states = memoryState({
      version: 1,
      vault_id: 'vault-1',
      cursor: 7,
      items: {}
    })
    const server = remote({
      changes: [
        {
          sequence: 8,
          item_id: 'item-untracked',
          type: 'upsert',
          path: '.zennotes/vault.json',
          previous_path: null,
          revision: 3,
          content: content('{}')
        }
      ],
      mutate: () => ({ acknowledged: [], conflicts: [], cursor: 8 })
    })

    const first = await new CloudSyncCoordinator(
      'vault-1',
      server,
      repository,
      states,
      ids()
    ).sync()

    expect(first.localConflicts).toEqual([
      {
        code: 'LOCAL_EDIT_CONFLICT',
        path: '.zennotes/vault.json',
        conflict_copy_path: '.zennotes/vault.json (cloud conflict)'
      }
    ])
    expect(states.current?.cursor).toBe(8)

    // The next run is past it rather than replaying the same change forever.
    const second = await new CloudSyncCoordinator(
      'vault-1',
      server,
      repository,
      states,
      ids()
    ).sync()
    expect(second.localConflicts).toEqual([])
    expect(states.current?.cursor).toBe(8)
  })

  it('merges remote and local files on first sync without deleting either side', async () => {
    const repository = memoryRepository([
      { path: 'local.md', kind: 'text', content: content('local') }
    ])
    const states = memoryState()
    const server = remote({
      manifest: {
        data: [
          {
            item_id: 'item-remote',
            path: 'remote.md',
            kind: 'text',
            revision: 2,
            sha256: 'hash:remote',
            byte_length: 6,
            media_type: 'text/markdown',
            content: content('remote')
          }
        ],
        cursor: 4,
        next_page: null
      }
    })

    const result = await new CloudSyncCoordinator(
      'vault-1',
      server,
      repository,
      states,
      ids()
    ).sync()

    expect(result.pulled).toBe(1)
    expect(result.pushed).toBe(1)
    expect(repository.items.map((item) => item.path).sort()).toEqual(['local.md', 'remote.md'])
    expect(server.mutations[0]?.mutations[0]).toEqual(
      expect.objectContaining({ type: 'upsert', path: 'local.md', base_revision: null })
    )
    expect(states.current?.cursor).toBe(4)
  })

  it('parks differing settings on first sync while continuing with other files', async () => {
    const localSettings = {
      path: '.zennotes/vault.json',
      kind: 'text' as const,
      content: content('{"favorites":["local.md"]}')
    }
    const localNote = { path: 'local.md', kind: 'text' as const, content: content('local') }
    const repository: CloudSyncRepository & {
      pendingConflictPaths(): Promise<string[]>
    } = {
      async scan() {
        return [localSettings, localNote]
      },
      async apply(change) {
        if (change.path !== '.zennotes/vault.json') return
        return {
          code: 'SETTINGS_CONFLICT',
          path: change.path,
          conflict_copy_path: '.zennotes/vault.cloud-conflict.json'
        }
      },
      async pendingConflictPaths() {
        return ['.zennotes/vault.json']
      }
    }
    const states = memoryState()
    const server = remote({
      manifest: {
        data: [
          {
            item_id: 'settings-remote',
            path: '.zennotes/vault.json',
            kind: 'text',
            revision: 2,
            sha256: 'hash:{"favorites":["cloud.md"]}',
            byte_length: 26,
            media_type: 'application/json',
            content: content('{"favorites":["cloud.md"]}')
          }
        ],
        cursor: 4,
        next_page: null
      }
    })

    const result = await new CloudSyncCoordinator(
      'vault-1',
      server,
      repository,
      states,
      ids()
    ).sync()

    expect(result.bootstrapConflicts).toEqual([])
    expect(result.localConflicts).toEqual([
      expect.objectContaining({ code: 'SETTINGS_CONFLICT', path: '.zennotes/vault.json' })
    ])
    expect(server.mutations).toHaveLength(1)
    expect(server.mutations[0]?.mutations).toEqual([
      expect.objectContaining({ type: 'upsert', path: 'local.md' })
    ])
    expect(states.current?.items['settings-remote']?.sha256).toBe(
      'hash:{"favorites":["cloud.md"]}'
    )
  })

  it('does not upload local settings while their cloud choice is still pending', async () => {
    const repository: CloudSyncRepository & {
      pendingConflictPaths(): Promise<string[]>
    } = {
      async scan() {
        return [
          {
            path: '.zennotes/vault.json',
            kind: 'text',
            content: content('{"favorites":["local.md"]}')
          }
        ]
      },
      async apply() {},
      async pendingConflictPaths() {
        return ['.zennotes/vault.json']
      }
    }
    const states = memoryState({
      version: 1,
      vault_id: 'vault-1',
      cursor: 9,
      items: {
        'settings-remote': {
          item_id: 'settings-remote',
          path: '.zennotes/vault.json',
          kind: 'text',
          revision: 3,
          sha256: 'hash:{"favorites":["cloud.md"]}',
          byte_length: 26,
          media_type: 'application/json'
        }
      }
    })
    const server = remote({})

    const result = await new CloudSyncCoordinator(
      'vault-1',
      server,
      repository,
      states,
      ids()
    ).sync()

    expect(result.pushed).toBe(0)
    expect(server.mutations).toEqual([])
    expect(states.current?.items['settings-remote']?.sha256).toBe(
      'hash:{"favorites":["cloud.md"]}'
    )
  })

  it('pulls contiguous remote changes before planning local mutations', async () => {
    const states = memoryState({
      version: 1,
      vault_id: 'vault-1',
      cursor: 1,
      items: {}
    })
    const repository = memoryRepository([])
    const server = remote({
      changes: [
        {
          sequence: 2,
          item_id: 'item-remote',
          type: 'upsert',
          path: 'remote.md',
          previous_path: null,
          revision: 1,
          content: content('remote')
        }
      ]
    })

    const result = await new CloudSyncCoordinator(
      'vault-1',
      server,
      repository,
      states,
      ids()
    ).sync()

    expect(result.pulled).toBe(1)
    expect(result.pushed).toBe(0)
    expect(result.state.cursor).toBe(2)
    expect(server.mutations).toEqual([])
  })

  it('advances past acknowledged mutations without applying their echoed changes', async () => {
    const states = memoryState({ version: 1, vault_id: 'vault-1', cursor: 0, items: {} })
    const repository = memoryRepository([
      { path: 'local.md', kind: 'text', content: content('local') }
    ])
    const apply = vi.spyOn(repository, 'apply')
    const mutations: CloudSyncMutationRequest[] = []
    const changes: CloudSyncChange[] = []
    const server: CloudSyncRemote = {
      async manifest() {
        return { data: [], cursor: 0, next_page: null }
      },
      async changes(_vaultId, after) {
        const data = changes.filter((change) => change.sequence > after)
        return { data, cursor: data.at(-1)?.sequence ?? after, has_more: false }
      },
      async mutate(_vaultId, body) {
        mutations.push(body)
        const mutation = body.mutations[0]
        if (!mutation || mutation.type !== 'upsert') throw new Error('Expected an upsert')
        changes.push({
          sequence: 1,
          item_id: mutation.item_id,
          type: 'upsert',
          path: mutation.path,
          previous_path: null,
          revision: 1,
          content: mutation.content
        })
        return {
          acknowledged: [
            {
              operation_id: mutation.operation_id,
              item_id: mutation.item_id,
              revision: 1,
              sequence: 1
            }
          ],
          conflicts: [],
          cursor: 1
        }
      }
    }
    const coordinator = new CloudSyncCoordinator('vault-1', server, repository, states, ids())

    const first = await coordinator.sync()
    const second = await coordinator.sync()

    expect(first).toEqual(expect.objectContaining({ pulled: 0, pushed: 1 }))
    expect(second).toEqual(expect.objectContaining({ pulled: 0, pushed: 0 }))
    expect(second.state.cursor).toBe(1)
    expect(mutations).toHaveLength(1)
    expect(apply).not.toHaveBeenCalled()
  })

  it('checkpoints binary uploads one per request while retaining text batches', async () => {
    const states = memoryState({ version: 1, vault_id: 'vault-1', cursor: 0, items: {} })
    const repository = memoryRepository([
      { path: 'a.md', kind: 'text', content: content('a') },
      { path: 'b.md', kind: 'text', content: content('b') },
      { path: 'c.jpg', kind: 'binary', content: binaryContent('c') },
      { path: 'd.jpg', kind: 'binary', content: binaryContent('d') },
      { path: 'e.jpg', kind: 'binary', content: binaryContent('e') },
      { path: 'f.jpg', kind: 'binary', content: binaryContent('f') },
      { path: 'g.md', kind: 'text', content: content('g') },
      { path: 'h.md', kind: 'text', content: content('h') }
    ])
    const requests: CloudSyncMutationRequest[] = []
    let sequence = 0
    const server: CloudSyncRemote = {
      async manifest() {
        return { data: [], cursor: 0, next_page: null }
      },
      async changes(_vaultId, after) {
        return { data: [], cursor: after, has_more: false }
      },
      async mutate(_vaultId, body) {
        requests.push(body)
        const acknowledged = body.mutations.map((mutation) => ({
          operation_id: mutation.operation_id,
          item_id: mutation.item_id,
          revision: 1,
          sequence: ++sequence
        }))
        return { acknowledged, conflicts: [], cursor: sequence }
      }
    }

    await new CloudSyncCoordinator('vault-1', server, repository, states, ids()).sync()

    expect(
      requests.map((request) =>
        request.mutations.map((mutation) =>
          mutation.type === 'upsert' ? mutation.path : mutation.type
        )
      )
    ).toEqual([
      ['a.md', 'b.md'],
      ['c.jpg'],
      ['d.jpg'],
      ['e.jpg'],
      ['f.jpg'],
      ['g.md', 'h.md']
    ])
  })

  it('stops initial sync on same-path content conflicts', async () => {
    const repository = memoryRepository([
      { path: 'plan.md', kind: 'text', content: content('local') }
    ])
    const states = memoryState()
    const server = remote({
      manifest: {
        data: [
          {
            item_id: 'item-remote',
            path: 'plan.md',
            kind: 'text',
            revision: 1,
            sha256: 'hash:remote',
            byte_length: 6,
            media_type: 'text/markdown',
            content: content('remote')
          }
        ],
        cursor: 1,
        next_page: null
      }
    })

    const result = await new CloudSyncCoordinator(
      'vault-1',
      server,
      repository,
      states,
      ids()
    ).sync()

    expect(result.bootstrapConflicts).toEqual([
      expect.objectContaining({ code: 'BOOTSTRAP_CONTENT_CONFLICT', path: 'plan.md' })
    ])
    expect(server.mutations).toEqual([])
    expect(states.current).toBeNull()
  })

  it('coalesces overlapping runs for one vault', async () => {
    const states = memoryState({ version: 1, vault_id: 'vault-1', cursor: 0, items: {} })
    const repository = memoryRepository([])
    const server = remote({})
    const changes = vi.spyOn(server, 'changes')
    const coordinator = new CloudSyncCoordinator('vault-1', server, repository, states, ids())

    await Promise.all([coordinator.sync(), coordinator.sync()])

    expect(changes).toHaveBeenCalledTimes(1)
  })
})

/* ---------- A device that missed several revisions of one file ------------ */

/** Content with a real digest, so the portable repository's own vouching runs. */
function realContent(data: string): CloudSyncContent {
  return {
    encoding: 'utf8',
    data,
    sha256: createHash('sha256').update(data, 'utf8').digest('hex'),
    byte_length: Buffer.byteLength(data),
    media_type: 'text/markdown'
  }
}

function tracked(itemId: string, path: string, revision: number, data: string): CloudSyncTrackedItem {
  const { sha256, byte_length, media_type } = realContent(data)
  return { item_id: itemId, path, kind: 'text', revision, sha256, byte_length, media_type }
}

function memoryFileSystem(
  initial: Record<string, string>
): PortableCloudSyncFileSystem & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial))
  return {
    files,
    async readdir(directory) {
      const prefix = directory ? `${directory}/` : ''
      const names = new Map<string, 'file' | 'directory'>()
      for (const path of files.keys()) {
        if (!path.startsWith(prefix)) continue
        const rest = path.slice(prefix.length)
        const slash = rest.indexOf('/')
        if (slash < 0) names.set(rest, 'file')
        else names.set(rest.slice(0, slash), 'directory')
      }
      return [...names].map(([name, type]) => ({ name, type }))
    },
    async stat(path) {
      if (files.has(path)) return 'file'
      const prefix = `${path}/`
      return [...files.keys()].some((candidate) => candidate.startsWith(prefix)) ? 'directory' : null
    },
    async readBase64(path) {
      const text = files.get(path)
      if (text == null) throw new Error(`ENOENT: ${path}`)
      return Buffer.from(text, 'utf8').toString('base64')
    },
    async writeText(path, value) {
      files.set(path, value)
    },
    async writeBase64(path, value) {
      files.set(path, Buffer.from(value, 'base64').toString('utf8'))
    },
    async deleteFile(path) {
      files.delete(path)
    },
    async rename(from, to) {
      const value = files.get(from)
      if (value == null) throw new Error(`ENOENT: ${from}`)
      files.delete(from)
      files.set(to, value)
    }
  }
}

function upsert(sequence: number, itemId: string, path: string, data: string): CloudSyncChange {
  return {
    sequence,
    item_id: itemId,
    type: 'upsert',
    path,
    previous_path: null,
    revision: sequence,
    content: realContent(data)
  }
}

describe('CloudSyncCoordinator: catching up on a file this device never touched', () => {
  const path = 'inbox/Plan.md'

  it('adopts the newest revision cleanly when earlier revisions were coalesced (Discord, unyanda)', async () => {
    // The desktop saved Plan.md three times while this device was offline.
    // Nothing here changed: the file is still the v1 that sync last agreed on.
    const fs = memoryFileSystem({ [path]: 'v1' })
    const states = memoryState({
      version: 1,
      vault_id: 'vault-1',
      cursor: 1,
      items: { plan: tracked('plan', path, 1, 'v1') }
    })
    const server = remote({
      changes: [upsert(2, 'plan', path, 'v2'), upsert(3, 'plan', path, 'v3'), upsert(4, 'plan', path, 'v4')]
    })

    const result = await new CloudSyncCoordinator(
      'vault-1',
      server,
      new PortableCloudSyncRepository(fs),
      states,
      ids()
    ).sync()

    expect(result.localConflicts).toEqual([])
    expect([...fs.files.keys()]).toEqual([path])
    expect(fs.files.get(path)).toBe('v4')
    // Nothing to push back: the device's file was never edited, so it must not
    // re-upload its stale bytes over the revision it just received.
    expect(server.mutations).toEqual([])
    expect(states.current?.items.plan?.sha256).toBe(realContent('v4').sha256)
    expect(states.current?.cursor).toBe(4)
  })

  it('applies a later delete or move against what is actually on disk', async () => {
    const fs = memoryFileSystem({ [path]: 'v1' })
    const states = memoryState({
      version: 1,
      vault_id: 'vault-1',
      cursor: 1,
      items: { plan: tracked('plan', path, 1, 'v1') }
    })
    const server = remote({
      changes: [
        upsert(2, 'plan', path, 'v2'),
        upsert(3, 'plan', path, 'v3'),
        {
          sequence: 4,
          item_id: 'plan',
          type: 'move',
          path: 'archive/Plan.md',
          previous_path: path,
          revision: 4
        },
        upsert(5, 'plan', 'archive/Plan.md', 'v5')
      ]
    })

    const result = await new CloudSyncCoordinator(
      'vault-1',
      server,
      new PortableCloudSyncRepository(fs),
      states,
      ids()
    ).sync()

    expect(result.localConflicts).toEqual([])
    expect([...fs.files.keys()]).toEqual(['archive/Plan.md'])
    expect(fs.files.get('archive/Plan.md')).toBe('v5')
    expect(server.mutations).toEqual([])
  })

  it('still parks a real local edit beside the incoming revision', async () => {
    const fs = memoryFileSystem({ [path]: 'edited here while offline' })
    const states = memoryState({
      version: 1,
      vault_id: 'vault-1',
      cursor: 1,
      items: { plan: tracked('plan', path, 1, 'v1') }
    })
    const server = remote({
      changes: [upsert(2, 'plan', path, 'v2'), upsert(3, 'plan', path, 'v3')]
    })

    const result = await new CloudSyncCoordinator(
      'vault-1',
      server,
      new PortableCloudSyncRepository(fs),
      states,
      ids()
    ).sync()

    expect(result.localConflicts).toEqual([
      { code: 'LOCAL_EDIT_CONFLICT', path, conflict_copy_path: 'inbox/Plan (cloud conflict).md' }
    ])
    expect(fs.files.get(path)).toBe('edited here while offline')
    expect(fs.files.get('inbox/Plan (cloud conflict).md')).toBe('v3')
  })
})

describe('CloudSyncCoordinator: rejected mutations name their file', () => {
  it('annotates server conflicts with the local path, a delete with the path the item had here', async () => {
    const states = memoryState({
      version: 1,
      vault_id: 'vault-1',
      cursor: 1,
      items: {
        kept: tracked('kept', 'inbox/Kept.md', 1, 'v1'),
        gone: tracked('gone', 'inbox/Gone.md', 1, 'v1')
      }
    })
    // Kept.md was edited here; Gone.md was deleted here.
    const repository = memoryRepository([
      { path: 'inbox/Kept.md', kind: 'text', content: realContent('v2') }
    ])
    const server = remote({
      mutate: (body) => ({
        acknowledged: [],
        conflicts: body.mutations.map((mutation) => ({
          operation_id: mutation.operation_id,
          item_id: mutation.item_id,
          code: mutation.type === 'delete' ? ('ITEM_DELETED' as const) : ('REVISION_CONFLICT' as const),
          current_revision: 3,
          current_path: null
        })),
        cursor: 1
      })
    })

    const result = await new CloudSyncCoordinator('vault-1', server, repository, states, ids()).sync()

    expect(result.conflicts.map((c) => [c.item_id, c.code, c.path])).toEqual([
      ['gone', 'ITEM_DELETED', 'inbox/Gone.md'],
      ['kept', 'REVISION_CONFLICT', 'inbox/Kept.md']
    ])
  })
})
