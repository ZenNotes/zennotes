import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type {
  CloudSyncChange,
  CloudSyncBootstrapConflictResolution,
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
  CloudSyncStoredConflict,
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
        this.items.push({
          path: change.path,
          kind: 'text',
          content: change.content
        })
      }
    },
    async replaceConflictFile(input) {
      const local = this.items.find((item) => item.path === input.path)
      if ((local?.content.sha256 ?? null) !== input.expectedSha256) {
        throw new Error('changed on this device')
      }
      if (input.content === null) {
        this.items = this.items.filter((item) => item.path !== input.path)
      } else if (local) {
        local.content = input.content
      } else {
        this.items.push({
          path: input.path,
          kind: input.content.encoding === 'utf8' ? 'text' : 'binary',
          content: input.content
        })
      }
    },
    async applyConflictResolutionFiles(input) {
      const current = input.expected_path
        ? this.items.find((item) => item.path === input.expected_path)
        : undefined
      if ((current?.content.sha256 ?? null) !== input.expected_sha256) {
        throw new Error('changed on this device')
      }
      for (const file of input.files) {
        const occupant = this.items.find(
          (item) => item.path === file.path && item.path !== input.expected_path
        )
        if (occupant) throw new Error(`${file.path} already exists`)
      }
      if (input.expected_path) {
        this.items = this.items.filter((item) => item.path !== input.expected_path)
      }
      for (const file of input.files) {
        this.items.push({
          path: file.path,
          kind: file.content.encoding === 'utf8' ? 'text' : 'binary',
          content: file.content
        })
      }
    },
    async resolveBootstrapConflict(input) {
      const local = this.items.find((item) => item.path === input.path)
      if (!local || local.content.sha256 !== input.expectedLocalSha256) {
        throw new Error('changed on this device')
      }
      if (input.resolution.choice === 'cloud') {
        local.content = input.cloudContent
      } else if (input.resolution.choice === 'merged') {
        local.content = content(input.resolution.merged_text ?? '')
      } else if (input.resolution.choice === 'both' && input.resolution.keep_both_path) {
        local.path = input.resolution.keep_both_path
        this.items.push({
          path: input.path,
          kind: 'text',
          content: input.cloudContent
        })
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
      return (options.manifest ?? {
        data: [],
        cursor: 0,
        next_page: null
      }) as CloudSyncManifestResponse
    },
    async changes(_vaultId, after) {
      const data = (options.changes ?? []).filter((change) => change.sequence > after)
      return { data, cursor: data.at(-1)?.sequence ?? after, has_more: false }
    },
    async mutate(_vaultId, body) {
      mutations.push(body)
      return (
        options.mutate?.(body) ?? {
          acknowledged: body.mutations.map((mutation, index) => ({
            operation_id: mutation.operation_id,
            item_id: mutation.item_id,
            revision: 1,
            sequence: index + 1
          })),
          conflicts: [],
          cursor: body.mutations.length
        }
      )
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
  it('finishes the run, queues the conflict, and advances the cursor', async () => {
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

    expect(first.localConflicts).toEqual([])
    expect(first.pendingConflicts).toEqual([
      expect.objectContaining({
        id: 'item-untracked',
        path: '.zennotes/vault.json'
      })
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
    expect(second.pendingConflicts).toEqual(first.pendingConflicts)
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
      expect.objectContaining({
        type: 'upsert',
        path: 'local.md',
        base_revision: null
      })
    )
    expect(states.current?.cursor).toBe(4)
  })

  it('parks differing settings on first sync while continuing with other files', async () => {
    const localSettings = {
      path: '.zennotes/vault.json',
      kind: 'text' as const,
      content: content('{"favorites":["local.md"]}')
    }
    const localNote = {
      path: 'local.md',
      kind: 'text' as const,
      content: content('local')
    }
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
      expect.objectContaining({
        code: 'SETTINGS_CONFLICT',
        path: '.zennotes/vault.json'
      })
    ])
    expect(server.mutations).toHaveLength(1)
    expect(server.mutations[0]?.mutations).toEqual([
      expect.objectContaining({ type: 'upsert', path: 'local.md' })
    ])
    expect(states.current?.items['settings-remote']?.sha256).toBe('hash:{"favorites":["cloud.md"]}')
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
    expect(states.current?.items['settings-remote']?.sha256).toBe('hash:{"favorites":["cloud.md"]}')
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
    const states = memoryState({
      version: 1,
      vault_id: 'vault-1',
      cursor: 0,
      items: {}
    })
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
    const states = memoryState({
      version: 1,
      vault_id: 'vault-1',
      cursor: 0,
      items: {}
    })
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
    ).toEqual([['a.md', 'b.md'], ['c.jpg'], ['d.jpg'], ['e.jpg'], ['f.jpg'], ['g.md', 'h.md']])
  })

  it('queues same-path first-sync conflicts durably without blocking other sync', async () => {
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

    expect(result.bootstrapConflicts).toEqual([])
    expect(result.pendingConflicts).toEqual([
      expect.objectContaining({
        id: 'item-remote',
        path: 'plan.md',
        has_base: false
      })
    ])
    expect(server.mutations).toEqual([])
    expect(states.current?.pending_conflicts?.['item-remote']).toMatchObject({
      local: { content: { data: 'local' } },
      cloud: { content: { data: 'remote' } }
    })
  })

  it('shows both first-sync versions and lets this device replace the cloud version', async () => {
    const repository = memoryRepository([
      { path: 'plan.md', kind: 'text', content: content('latest local edit') }
    ])
    const states = memoryState()
    const manifest: CloudSyncManifestResponse = {
      data: [
        {
          item_id: 'item-remote',
          path: 'plan.md',
          kind: 'text',
          revision: 3,
          sha256: 'hash:older cloud edit',
          byte_length: 16,
          media_type: 'text/markdown',
          content: content('older cloud edit')
        }
      ],
      cursor: 1,
      next_page: null
    }
    const server = remote({ manifest })
    const coordinator = new CloudSyncCoordinator('vault-1', server, repository, states, ids())

    const first = await coordinator.sync()
    const conflict = first.pendingConflicts[0]!

    await expect(coordinator.getConflict(conflict.id)).resolves.toMatchObject({
      conflict: { has_base: false },
      base: { deleted: false, text: null },
      local: { text: 'latest local edit' },
      cloud: { text: 'older cloud edit' },
      changes: []
    })

    await coordinator.resolveConflict({
      conflict_id: conflict.id,
      choice: 'local',
      expected_local_sha256: 'hash:latest local edit',
      expected_cloud_revision: 3
    })
    expect(states.current?.pending_conflicts).toEqual({})
    expect(server.mutations).toEqual([
      {
        mutations: [
          expect.objectContaining({
            type: 'upsert',
            item_id: 'item-remote',
            base_revision: 3,
            path: 'plan.md',
            content: expect.objectContaining({ data: 'latest local edit' })
          })
        ]
      }
    ])

    expect(states.current?.items['item-remote']?.sha256).toBe('hash:latest local edit')
  })

  it('keeps both first-sync versions only after an explicit filename choice', async () => {
    const repository = memoryRepository([
      { path: 'Daily.md', kind: 'text', content: content('latest local edit') }
    ])
    const states = memoryState()
    const server = remote({
      manifest: {
        data: [
          {
            item_id: 'item-remote',
            path: 'Daily.md',
            kind: 'text',
            revision: 3,
            sha256: 'hash:older cloud edit',
            byte_length: 16,
            media_type: 'text/markdown',
            content: content('older cloud edit')
          }
        ],
        cursor: 1,
        next_page: null
      }
    })
    const coordinator = new CloudSyncCoordinator('vault-1', server, repository, states, ids())
    const first = await coordinator.sync()

    await coordinator.resolveConflict({
      conflict_id: first.pendingConflicts[0]!.id,
      choice: 'both',
      keep_both_path: 'Daily (this device).md',
      expected_local_sha256: 'hash:latest local edit',
      expected_cloud_revision: 3
    })
    const resolved = await coordinator.sync()

    expect(resolved.bootstrapConflicts).toEqual([])
    expect(resolved.pendingConflicts).toEqual([])
    expect(repository.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'Daily.md',
          content: content('older cloud edit')
        }),
        expect.objectContaining({
          path: 'Daily (this device).md',
          content: content('latest local edit')
        })
      ])
    )
    expect(server.mutations.at(-1)?.mutations).toEqual([
      expect.objectContaining({
        type: 'upsert',
        path: 'Daily (this device).md'
      })
    ])
  })

  it('leaves other first-sync conflicts pending after resolving one file', async () => {
    const repository = memoryRepository([
      { path: 'one.md', kind: 'text', content: content('local one') },
      { path: 'two.md', kind: 'text', content: content('local two') }
    ])
    const states = memoryState()
    const server = remote({
      manifest: {
        data: [
          {
            item_id: 'one',
            path: 'one.md',
            kind: 'text',
            revision: 1,
            sha256: 'hash:cloud one',
            byte_length: 9,
            media_type: 'text/markdown',
            content: content('cloud one')
          },
          {
            item_id: 'two',
            path: 'two.md',
            kind: 'text',
            revision: 1,
            sha256: 'hash:cloud two',
            byte_length: 9,
            media_type: 'text/markdown',
            content: content('cloud two')
          }
        ],
        cursor: 2,
        next_page: null
      }
    })
    const coordinator = new CloudSyncCoordinator('vault-1', server, repository, states, ids())
    const first = await coordinator.sync()

    await coordinator.resolveConflict({
      conflict_id: first.pendingConflicts[0]!.id,
      choice: 'cloud',
      expected_local_sha256: 'hash:local one',
      expected_cloud_revision: 1
    })
    const next = await coordinator.sync()

    expect(next.pendingConflicts).toEqual([
      expect.objectContaining({ item_id: 'two', path: 'two.md' })
    ])
    expect(states.current?.pending_conflicts?.two).toBeDefined()
  })

  it('does not initialize sync for an invalid resolution choice', async () => {
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
            sha256: 'hash:cloud',
            byte_length: 5,
            media_type: 'text/markdown',
            content: content('cloud')
          }
        ],
        cursor: 1,
        next_page: null
      }
    })
    const coordinator = new CloudSyncCoordinator('vault-1', server, repository, states, ids())
    const first = await coordinator.sync()

    await expect(
      coordinator.resolveConflict({
        conflict_id: first.pendingConflicts[0]!.id,
        choice: 'unexpected',
        expected_local_sha256: 'hash:local',
        expected_cloud_revision: 1
      } as unknown as Parameters<typeof coordinator.resolveConflict>[0])
    ).rejects.toThrow('resolution choice')
    expect(states.current?.pending_conflicts?.['item-remote']).toBeDefined()
  })

  it('applies the other device deletion only after the user chooses it', async () => {
    const repository = memoryRepository([
      { path: 'Plan.md', kind: 'text', content: content('edited here') }
    ])
    const states = memoryState({
      version: 1,
      vault_id: 'vault-1',
      cursor: 2,
      items: {},
      pending_conflicts: {
        item: {
          id: 'item',
          item_id: 'item',
          kind: 'delete',
          sequence: 2,
          base: {
            path: 'Plan.md',
            revision: 1,
            kind: 'text',
            content: content('agreed')
          },
          local: {
            path: 'Plan.md',
            revision: null,
            kind: 'text',
            content: content('edited here')
          },
          cloud: { path: null, revision: 2, kind: 'text', content: null }
        }
      }
    })
    const server = remote({
      manifest: { data: [], cursor: 2, next_page: null }
    })
    const coordinator = new CloudSyncCoordinator('vault-1', server, repository, states, ids())

    await coordinator.resolveConflict({
      conflict_id: 'item',
      choice: 'cloud',
      expected_local_sha256: 'hash:edited here',
      expected_cloud_revision: 2
    })

    expect(repository.items).toEqual([])
    expect(states.current?.pending_conflicts).toEqual({})
    expect(server.mutations).toEqual([])
  })

  it('restores a locally edited note after the other device deleted it', async () => {
    const repository = memoryRepository([
      { path: 'Plan.md', kind: 'text', content: content('edited here') }
    ])
    const states = memoryState({
      version: 1,
      vault_id: 'vault-1',
      cursor: 2,
      items: {},
      pending_conflicts: {
        item: {
          id: 'item',
          item_id: 'item',
          kind: 'delete',
          sequence: 2,
          base: {
            path: 'Plan.md',
            revision: 1,
            kind: 'text',
            content: content('agreed')
          },
          local: {
            path: 'Plan.md',
            revision: null,
            kind: 'text',
            content: content('edited here')
          },
          cloud: { path: null, revision: 2, kind: 'text', content: null }
        }
      }
    })
    const server = remote({
      manifest: { data: [], cursor: 2, next_page: null }
    })
    const coordinator = new CloudSyncCoordinator('vault-1', server, repository, states, ids())

    await coordinator.resolveConflict({
      conflict_id: 'item',
      choice: 'local',
      expected_local_sha256: 'hash:edited here',
      expected_cloud_revision: 2
    })

    expect(server.mutations[0]?.mutations[0]).toMatchObject({
      type: 'upsert',
      item_id: 'item',
      base_revision: 2,
      path: 'Plan.md',
      content: { data: 'edited here' }
    })
    expect(states.current?.pending_conflicts).toEqual({})
  })

  it('leaves the local file untouched when Cloud cannot save a decision', async () => {
    const repository = memoryRepository([
      { path: 'Plan.md', kind: 'text', content: content('edited here') }
    ])
    const cloudItem = {
      item_id: 'item',
      path: 'Plan.md',
      kind: 'text' as const,
      revision: 2,
      sha256: 'hash:edited elsewhere',
      byte_length: 16,
      media_type: 'text/markdown',
      content: content('edited elsewhere')
    }
    const states = memoryState({
      version: 1,
      vault_id: 'vault-1',
      cursor: 2,
      items: { item: cloudItem },
      pending_conflicts: {
        item: {
          id: 'item',
          item_id: 'item',
          kind: 'content',
          sequence: 2,
          base: {
            path: 'Plan.md',
            revision: 1,
            kind: 'text',
            content: content('agreed')
          },
          local: {
            path: 'Plan.md',
            revision: null,
            kind: 'text',
            content: content('edited here')
          },
          cloud: {
            path: 'Plan.md',
            revision: 2,
            kind: 'text',
            content: content('edited elsewhere')
          }
        }
      }
    })
    const server = remote({
      manifest: { data: [cloudItem], cursor: 2, next_page: null }
    })
    vi.spyOn(server, 'mutate').mockRejectedValueOnce(new Error('offline'))
    const coordinator = new CloudSyncCoordinator('vault-1', server, repository, states, ids())

    await expect(
      coordinator.resolveConflict({
        conflict_id: 'item',
        choice: 'merged',
        merged_text: 'carefully combined',
        expected_local_sha256: 'hash:edited here',
        expected_cloud_revision: 2
      })
    ).rejects.toThrow('offline')

    expect(repository.items).toEqual([
      { path: 'Plan.md', kind: 'text', content: content('edited here') }
    ])
    expect(states.current?.pending_conflicts?.item).toBeDefined()
  })

  it('lets a moved-file conflict use the other device location without leaving a copy', async () => {
    const repository = memoryRepository([
      { path: 'Old/Plan.md', kind: 'text', content: content('edited here') }
    ])
    const cloudItem = {
      item_id: 'item',
      path: 'Plans/Plan.md',
      kind: 'text' as const,
      revision: 2,
      sha256: 'hash:agreed',
      byte_length: 6,
      media_type: 'text/markdown',
      content: content('agreed')
    }
    const states = memoryState({
      version: 1,
      vault_id: 'vault-1',
      cursor: 2,
      items: { item: cloudItem },
      pending_conflicts: {
        item: {
          id: 'item',
          item_id: 'item',
          kind: 'move',
          sequence: 2,
          base: {
            path: 'Old/Plan.md',
            revision: 1,
            kind: 'text',
            content: content('agreed')
          },
          local: {
            path: 'Old/Plan.md',
            revision: null,
            kind: 'text',
            content: content('edited here')
          },
          cloud: {
            path: 'Plans/Plan.md',
            revision: 2,
            kind: 'text',
            content: content('agreed')
          }
        }
      }
    })
    const server = remote({
      manifest: { data: [cloudItem], cursor: 2, next_page: null }
    })
    const coordinator = new CloudSyncCoordinator('vault-1', server, repository, states, ids())

    await coordinator.resolveConflict({
      conflict_id: 'item',
      choice: 'cloud',
      expected_local_sha256: 'hash:edited here',
      expected_cloud_revision: 2
    })

    expect(repository.items).toEqual([
      { path: 'Plans/Plan.md', kind: 'text', content: content('agreed') }
    ])
    expect(states.current?.pending_conflicts).toEqual({})
  })

  it('keeps both binary versions under an explicit human filename', async () => {
    const repository = memoryRepository([
      {
        path: 'Photo.jpg',
        kind: 'binary',
        content: binaryContent('local-bytes')
      }
    ])
    const cloudItem = {
      item_id: 'photo',
      path: 'Photo.jpg',
      kind: 'binary' as const,
      revision: 2,
      sha256: 'hash:cloud-bytes',
      byte_length: 11,
      media_type: 'image/jpeg',
      content: binaryContent('cloud-bytes')
    }
    const states = memoryState({
      version: 1,
      vault_id: 'vault-1',
      cursor: 2,
      items: { photo: cloudItem },
      pending_conflicts: {
        photo: {
          id: 'photo',
          item_id: 'photo',
          kind: 'content',
          sequence: 2,
          base: {
            path: 'Photo.jpg',
            revision: 1,
            kind: 'binary',
            content: null
          },
          local: {
            path: 'Photo.jpg',
            revision: null,
            kind: 'binary',
            content: binaryContent('local-bytes')
          },
          cloud: {
            path: 'Photo.jpg',
            revision: 2,
            kind: 'binary',
            content: binaryContent('cloud-bytes')
          }
        }
      }
    })
    const server = remote({
      manifest: { data: [cloudItem], cursor: 2, next_page: null }
    })
    const coordinator = new CloudSyncCoordinator('vault-1', server, repository, states, ids())

    await coordinator.resolveConflict({
      conflict_id: 'photo',
      choice: 'both',
      keep_both_path: 'Photo from Mac.jpg',
      expected_local_sha256: 'hash:local-bytes',
      expected_cloud_revision: 2
    })

    expect(repository.items).toEqual(
      expect.arrayContaining([
        {
          path: 'Photo.jpg',
          kind: 'binary',
          content: binaryContent('cloud-bytes')
        },
        {
          path: 'Photo from Mac.jpg',
          kind: 'binary',
          content: binaryContent('local-bytes')
        }
      ])
    )
    expect(states.current?.pending_conflicts).toEqual({})
  })

  it('coalesces overlapping runs for one vault', async () => {
    const states = memoryState({
      version: 1,
      vault_id: 'vault-1',
      cursor: 0,
      items: {}
    })
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

/** Give a fake server the retained body of one revision. */
function retaining(
  server: CloudSyncRemote,
  itemId: string,
  revision: number,
  path: string,
  content: CloudSyncContent
): void {
  Object.assign(server, {
    async revision() {
      return { data: { item_id: itemId, revision, path, kind: 'text' as const, deleted: false, content } }
    }
  })
}

function tracked(
  itemId: string,
  path: string,
  revision: number,
  data: string
): CloudSyncTrackedItem {
  const { sha256, byte_length, media_type } = realContent(data)
  return {
    item_id: itemId,
    path,
    kind: 'text',
    revision,
    sha256,
    byte_length,
    media_type
  }
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
      return [...files.keys()].some((candidate) => candidate.startsWith(prefix))
        ? 'directory'
        : null
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

describe('CloudSyncCoordinator: converged pending conflicts', () => {
  const path = 'inbox/Plan.md'
  const localText = '- [ ] Meet at 10.\n'
  const cloudText = '- [ ] Meet at 11.\n'

  function pendingState(): CloudSyncState & {
    pending_conflicts: Record<string, CloudSyncStoredConflict>
  } {
    return {
      version: 1,
      vault_id: 'vault-1',
      cursor: 2,
      items: { plan: tracked('plan', path, 2, cloudText) },
      pending_conflicts: {
        plan: {
          id: 'plan',
          item_id: 'plan',
          kind: 'content',
          sequence: 2,
          base: {
            path,
            revision: 1,
            kind: 'text',
            content: realContent('agreed')
          },
          local: {
            path,
            revision: null,
            kind: 'text',
            content: realContent(localText)
          },
          cloud: {
            path,
            revision: 2,
            kind: 'text',
            content: realContent(cloudText)
          }
        }
      }
    }
  }

  it.each(['local copy', 'remote update'] as const)(
    'clears a pending conflict after a %s makes both versions identical and resumes later edits',
    async (convergence) => {
      const fs = memoryFileSystem({ [path]: localText })
      const states = memoryState({
        version: 1,
        vault_id: 'vault-1',
        cursor: 1,
        items: { plan: tracked('plan', path, 1, 'agreed') }
      })
      const changes = [upsert(2, 'plan', path, cloudText)]
      const server = remote({
        changes,
        mutate: (body) => ({
          acknowledged: body.mutations.map((mutation) => ({
            operation_id: mutation.operation_id,
            item_id: mutation.item_id,
            revision: 4,
            sequence: 4
          })),
          conflicts: [],
          cursor: 4
        })
      })
      const repository = new PortableCloudSyncRepository(fs)
      const coordinator = new CloudSyncCoordinator('vault-1', server, repository, states, ids())
      const first = await coordinator.sync()
      expect(first.pendingConflicts).toEqual([expect.objectContaining({ id: 'plan' })])

      if (convergence === 'local copy') fs.files.set(path, cloudText)
      else changes.push(upsert(3, 'plan', path, localText))

      // Resume a persisted conflict, including after an app restart. The local
      // copy case must work even when the server has no new change to deliver.
      const resumed = new CloudSyncCoordinator('vault-1', server, repository, states, ids())
      const result = await resumed.sync()
      const agreedText = convergence === 'local copy' ? cloudText : localText
      const agreedRevision = convergence === 'local copy' ? 2 : 3

      expect(result.pendingConflicts).toEqual([])
      expect(states.current?.pending_conflicts).toEqual({})
      expect(result.state.items.plan).toMatchObject(
        tracked('plan', path, agreedRevision, agreedText)
      )
      expect(fs.files.get(path)).toBe(agreedText)
      expect(server.mutations).toEqual([])
      await expect(resumed.getConflict('plan')).rejects.toThrow('already settled')

      fs.files.set(path, `${agreedText}- [ ] Next task.\n`)
      const next = await resumed.sync()
      expect(next.pendingConflicts).toEqual([])
      expect(next.pushed).toBe(1)
      expect(server.mutations.flatMap((request) => request.mutations)).toEqual([
        expect.objectContaining({
          type: 'upsert',
          item_id: 'plan',
          path,
          base_revision: agreedRevision,
          content: expect.objectContaining({
            data: `${agreedText}- [ ] Next task.\n`
          })
        })
      ])
    }
  )

  it('preserves a saved merge draft when local and Cloud files independently converge', async () => {
    const initial = pendingState()
    initial.pending_conflicts.plan.draft_text = '- [ ] Meet at 10:30.\n'
    const states = memoryState(initial)
    const fs = memoryFileSystem({ [path]: cloudText })
    const server = remote({})
    const coordinator = new CloudSyncCoordinator(
      'vault-1',
      server,
      new PortableCloudSyncRepository(fs),
      states,
      ids()
    )

    const result = await coordinator.sync()

    expect(result.pendingConflicts).toEqual([expect.objectContaining({ id: 'plan' })])
    await expect(coordinator.getConflict('plan')).resolves.toMatchObject({
      draft_text: '- [ ] Meet at 10:30.\n',
      local: { text: cloudText },
      cloud: { text: cloudText }
    })
    expect(fs.files.get(path)).toBe(cloudText)
    expect(server.mutations).toEqual([])
  })

  it.each([
    'different path',
    'case-only path difference',
    'different kind',
    'different byte length',
    'different hash',
    'missing local file',
    'missing tracked item',
    'different tracked identity',
    'stale Cloud snapshot',
    'path conflict',
    'move conflict',
    'delete conflict',
    'repository path conflict'
  ])('keeps a pending conflict requiring review for %s', async (scenario) => {
    const initial = pendingState()
    const conflict = initial.pending_conflicts.plan
    const local: CloudSyncLocalItem = {
      path,
      kind: 'text',
      content: realContent(cloudText)
    }
    const repository = memoryRepository([local])

    if (scenario === 'different path') local.path = 'archive/Plan.md'
    if (scenario === 'case-only path difference') local.path = 'inbox/plan.md'
    if (scenario === 'different kind') local.kind = 'binary'
    if (scenario === 'different byte length') local.content.byte_length += 1
    if (scenario === 'different hash') local.content.sha256 = realContent('different').sha256
    if (scenario === 'missing local file') repository.items = []
    if (scenario === 'missing tracked item') initial.items = {}
    if (scenario === 'different tracked identity') {
      initial.items = {
        replacement: tracked('replacement', path, 2, cloudText)
      }
    }
    if (scenario === 'stale Cloud snapshot') initial.items.plan = tracked('plan', path, 3, 'newer')
    if (scenario === 'path conflict') {
      conflict.kind = 'path'
      conflict.paused_paths = ['archive/Plan.md']
    }
    if (scenario === 'move conflict') conflict.kind = 'move'
    if (scenario === 'delete conflict') {
      conflict.kind = 'delete'
      conflict.cloud = { path: null, revision: 2, kind: 'text', content: null }
      initial.items = {}
    }
    if (scenario === 'repository path conflict') {
      repository.pendingConflictPaths = async () => [path]
    }

    const states = memoryState(initial)
    const server = remote({})
    const coordinator = new CloudSyncCoordinator('vault-1', server, repository, states, ids())
    const result = await coordinator.sync()

    expect(result.pendingConflicts).toEqual([expect.objectContaining({ id: 'plan' })])
    expect(states.current?.pending_conflicts?.plan).toEqual(conflict)
    expect(repository.items).toEqual(scenario === 'missing local file' ? [] : [local])
    expect(server.mutations.flatMap((request) => request.mutations)).not.toContainEqual(
      expect.objectContaining({ item_id: 'plan' })
    )
  })
})

describe('CloudSyncCoordinator: safely merging queued conflicts', () => {
  const path = 'inbox/Daily.md'
  const baseText = '# Daily\nDate: 2026-09-09\n\nExisting notes.\n'
  const localText = `${baseText}\nNew desktop content.\n`
  const cloudText = baseText.replace('2026-09-09', '2026-09-10')
  const mergedText = `${cloudText}\nNew desktop content.\n`

  function pendingState(): CloudSyncState & {
    pending_conflicts: Record<string, CloudSyncStoredConflict>
  } {
    return {
      version: 1,
      vault_id: 'vault-1',
      cursor: 2,
      items: { daily: tracked('daily', path, 2, cloudText) },
      pending_conflicts: {
        daily: {
          id: 'daily',
          item_id: 'daily',
          kind: 'content',
          sequence: 2,
          base: {
            path,
            revision: 1,
            kind: 'text',
            content: realContent(baseText)
          },
          local: {
            path,
            revision: null,
            kind: 'text',
            content: realContent(localText)
          },
          cloud: {
            path,
            revision: 2,
            kind: 'text',
            content: realContent(cloudText)
          }
        }
      }
    }
  }

  function acceptingRemote(changes: CloudSyncChange[] = []) {
    return remote({
      changes,
      mutate: (body) => ({
        acknowledged: body.mutations.map((mutation) => ({
          operation_id: mutation.operation_id,
          item_id: mutation.item_id,
          revision: 4,
          sequence: 4
        })),
        conflicts: [],
        cursor: 4
      })
    })
  }

  it('reconsiders a persisted conflict and uploads safe top and bottom edits without a new remote change', async () => {
    const fs = memoryFileSystem({ [path]: localText })
    const states = memoryState(pendingState())
    const server = acceptingRemote()
    const coordinator = new CloudSyncCoordinator(
      'vault-1',
      server,
      new PortableCloudSyncRepository(fs),
      states,
      ids()
    )

    const result = await coordinator.sync()

    expect(result.pendingConflicts).toEqual([])
    expect(result.pushed).toBe(1)
    expect(fs.files.get(path)).toBe(mergedText)
    expect([...fs.files.keys()]).toEqual([path])
    expect(states.current?.pending_conflicts).toEqual({})
    expect(states.current?.items.daily).toMatchObject(tracked('daily', path, 4, mergedText))
    expect(server.mutations.flatMap((request) => request.mutations)).toEqual([
      expect.objectContaining({
        type: 'upsert',
        item_id: 'daily',
        path,
        base_revision: 2,
        content: expect.objectContaining({ data: mergedText })
      })
    ])
    await expect(coordinator.getConflict('daily')).rejects.toThrow('already settled')
  })

  it('rechecks a queued conflict after a new Cloud revision makes its edits non-overlapping', async () => {
    const initial = pendingState()
    const overlappingText = `${baseText}\nDifferent mobile content.\n`
    initial.items.daily = tracked('daily', path, 2, overlappingText)
    initial.pending_conflicts.daily.cloud.content = realContent(overlappingText)
    const states = memoryState(initial)
    const fs = memoryFileSystem({ [path]: localText })
    const server = acceptingRemote([upsert(3, 'daily', path, cloudText)])

    const result = await new CloudSyncCoordinator(
      'vault-1',
      server,
      new PortableCloudSyncRepository(fs),
      states,
      ids()
    ).sync()

    expect(result.pendingConflicts).toEqual([])
    expect(result.pushed).toBe(1)
    expect(fs.files.get(path)).toBe(mergedText)
    expect(states.current?.pending_conflicts).toEqual({})
    expect(server.mutations.flatMap((request) => request.mutations)).toEqual([
      expect.objectContaining({
        type: 'upsert',
        item_id: 'daily',
        base_revision: 3,
        content: expect.objectContaining({ data: mergedText })
      })
    ])
  })

  it('uses the current local file rather than a queued snapshot when combining safe edits', async () => {
    const latestLocalText = `${localText}Another desktop task.\n`
    const latestMergedText = `${mergedText}Another desktop task.\n`
    const fs = memoryFileSystem({ [path]: latestLocalText })
    const states = memoryState(pendingState())
    const server = acceptingRemote()

    const result = await new CloudSyncCoordinator(
      'vault-1',
      server,
      new PortableCloudSyncRepository(fs),
      states,
      ids()
    ).sync()

    expect(result.pendingConflicts).toEqual([])
    expect(fs.files.get(path)).toBe(latestMergedText)
    expect(server.mutations.flatMap((request) => request.mutations)).toEqual([
      expect.objectContaining({
        content: expect.objectContaining({ data: latestMergedText })
      })
    ])
  })

  it('preserves a user-written resolution draft even when the queued edits can now merge safely', async () => {
    const initial = pendingState()
    const draftText = `${mergedText}My carefully edited resolution.\n`
    initial.pending_conflicts.daily.draft_text = draftText
    const fs = memoryFileSystem({ [path]: localText })
    const states = memoryState(initial)
    const server = acceptingRemote()
    const coordinator = new CloudSyncCoordinator(
      'vault-1',
      server,
      new PortableCloudSyncRepository(fs),
      states,
      ids()
    )

    const result = await coordinator.sync()

    expect(result.pendingConflicts).toEqual([expect.objectContaining({ id: 'daily' })])
    expect(states.current?.pending_conflicts?.daily.draft_text).toBe(draftText)
    await expect(coordinator.getConflict('daily')).resolves.toMatchObject({
      draft_text: draftText,
      suggested_text: mergedText,
      changes: []
    })
    expect(fs.files.get(path)).toBe(localText)
    expect(server.mutations).toEqual([])
  })

  it('keeps genuinely overlapping edits queued for a user decision', async () => {
    const initial = pendingState()
    const overlappingLocalText = baseText.replace('2026-09-09', '2026-09-11')
    initial.pending_conflicts.daily.local.content = realContent(overlappingLocalText)
    const fs = memoryFileSystem({ [path]: overlappingLocalText })
    const states = memoryState(initial)
    const server = acceptingRemote()
    const coordinator = new CloudSyncCoordinator(
      'vault-1',
      server,
      new PortableCloudSyncRepository(fs),
      states,
      ids()
    )

    const result = await coordinator.sync()

    expect(result.pendingConflicts).toEqual([expect.objectContaining({ id: 'daily' })])
    expect((await coordinator.getConflict('daily')).changes.length).toBeGreaterThan(0)
    expect(fs.files.get(path)).toBe(overlappingLocalText)
    expect(server.mutations).toEqual([])
  })

  it('preserves an edit racing the queued automatic merge and keeps the conflict pending', async () => {
    const latestLocalText = `${localText}Typed while sync was running.\n`
    const repository = memoryRepository([{ path, kind: 'text', content: realContent(localText) }])
    const replace = repository.replaceConflictFile!.bind(repository)
    repository.replaceConflictFile = async (input) => {
      repository.items[0]!.content = realContent(latestLocalText)
      await replace(input)
    }
    const states = memoryState(pendingState())
    const server = acceptingRemote()

    const result = await new CloudSyncCoordinator(
      'vault-1',
      server,
      repository,
      states,
      ids()
    ).sync()

    expect(repository.items[0]!.content.data).toBe(latestLocalText)
    expect(result.pendingConflicts).toEqual([expect.objectContaining({ id: 'daily' })])
    expect(states.current?.pending_conflicts?.daily).toBeDefined()
    expect(server.mutations).toEqual([])
  })
})

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
      changes: [
        upsert(2, 'plan', path, 'v2'),
        upsert(3, 'plan', path, 'v3'),
        upsert(4, 'plan', path, 'v4')
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

  it('keeps the changes that landed before a failing one so a retry does not replay them (#813)', async () => {
    // The desktop saved Untitled.md, trashed it as "Untitled 2.md" because an
    // older Untitled.md already sat in the trash, then emptied it. On the
    // phone the move fails in storage every time.
    const fs = memoryFileSystem({ 'Untitled.md': 'v1', 'trash/Untitled.md': 'older' })
    const rename = fs.rename
    fs.rename = async (from, to) => {
      throw new Error(`rename failed: Already exists /storage/emulated/0/Mind/trash/Untitled.md (${from} -> ${to})`)
    }
    const states = memoryState({
      version: 1,
      vault_id: 'vault-1',
      cursor: 1,
      items: {
        note: tracked('note', 'Untitled.md', 1, 'v1'),
        older: tracked('older', 'trash/Untitled.md', 1, 'older')
      }
    })
    const server = remote({
      changes: [
        upsert(2, 'note', 'Untitled.md', 'v2'),
        {
          sequence: 3,
          item_id: 'note',
          type: 'move',
          path: 'trash/Untitled 2.md',
          previous_path: 'Untitled.md',
          revision: 3
        },
        {
          sequence: 4,
          item_id: 'note',
          type: 'delete',
          path: 'trash/Untitled 2.md',
          previous_path: null,
          revision: 4
        }
      ]
    })
    const coordinator = new CloudSyncCoordinator(
      'vault-1',
      server,
      new PortableCloudSyncRepository(fs),
      states,
      ids()
    )

    await expect(coordinator.sync()).rejects.toThrow('Already exists')
    // The saved revision is on disk, so the cursor moves past it: only the
    // move is still owed.
    expect(fs.files.get('Untitled.md')).toBe('v2')
    expect(states.current?.cursor).toBe(2)
    expect(states.current?.items.note?.sha256).toBe(realContent('v2').sha256)

    // The user deletes the note on the phone to get unstuck. A retry must not
    // bring it back by replaying the upsert; without a source the move and
    // the delete have nothing left to do.
    fs.files.delete('Untitled.md')
    fs.rename = rename
    const retry = await coordinator.sync()

    expect(retry.localConflicts).toEqual([])
    expect([...fs.files.keys()]).toEqual(['trash/Untitled.md'])
    expect(states.current?.cursor).toBe(4)
    expect(states.current?.items.note).toBeUndefined()
    expect(server.mutations).toEqual([])
  })

  it('does not persist progress past a coalesced revision whose landing change has not run', async () => {
    // Plan.md v2 is skipped in favour of v3, which comes after the failing
    // move of another note. Saving the state after v2 would describe the
    // server's history rather than this device's file, and the retry would
    // park v3 as a conflict copy.
    const fs = memoryFileSystem({ [path]: 'v1', 'Other.md': 'other' })
    const rename = fs.rename
    let refuse = true
    fs.rename = async (from, to) => {
      if (refuse) throw new Error('rename failed: Already exists')
      return rename(from, to)
    }
    const states = memoryState({
      version: 1,
      vault_id: 'vault-1',
      cursor: 1,
      items: {
        plan: tracked('plan', path, 1, 'v1'),
        other: tracked('other', 'Other.md', 1, 'other')
      }
    })
    const server = remote({
      changes: [
        upsert(2, 'plan', path, 'v2'),
        {
          sequence: 3,
          item_id: 'other',
          type: 'move',
          path: 'archive/Other.md',
          previous_path: 'Other.md',
          revision: 3
        },
        upsert(4, 'plan', path, 'v3')
      ]
    })
    const coordinator = new CloudSyncCoordinator(
      'vault-1',
      server,
      new PortableCloudSyncRepository(fs),
      states,
      ids()
    )

    await expect(coordinator.sync()).rejects.toThrow('Already exists')
    expect(states.current?.cursor).toBe(1)
    expect(fs.files.get(path)).toBe('v1')

    refuse = false
    const retry = await coordinator.sync()

    expect(retry.localConflicts).toEqual([])
    expect([...fs.files.keys()].sort()).toEqual(['archive/Other.md', path])
    expect(fs.files.get(path)).toBe('v3')
    expect(states.current?.cursor).toBe(4)
    expect(states.current?.pending_conflicts ?? {}).toEqual({})
    expect(server.mutations).toEqual([])
  })

  it('saves only what landed when a change fails while a coalesced revision is still owed', async () => {
    // Fresh.md lands on its own. Plan.md v2 is then skipped in favour of v3,
    // and New.md lands while v3 is still owed, so the newest state that can
    // stand on its own is the one right after Fresh.md. The failing move must
    // not save Plan.md as v2, nor New.md as tracked.
    const fs = memoryFileSystem({ [path]: 'v1', 'Other.md': 'other' })
    const rename = fs.rename
    let refuse = true
    fs.rename = async (from, to) => {
      if (refuse) throw new Error('rename failed: Already exists')
      return rename(from, to)
    }
    const states = memoryState({
      version: 1,
      vault_id: 'vault-1',
      cursor: 1,
      items: {
        plan: tracked('plan', path, 1, 'v1'),
        other: tracked('other', 'Other.md', 1, 'other')
      }
    })
    const server = remote({
      changes: [
        upsert(2, 'fresh', 'Fresh.md', 'fresh'),
        upsert(3, 'plan', path, 'v2'),
        upsert(4, 'new', 'New.md', 'new'),
        {
          sequence: 5,
          item_id: 'other',
          type: 'move',
          path: 'archive/Other.md',
          previous_path: 'Other.md',
          revision: 5
        },
        upsert(6, 'plan', path, 'v3')
      ]
    })
    const coordinator = new CloudSyncCoordinator(
      'vault-1',
      server,
      new PortableCloudSyncRepository(fs),
      states,
      ids()
    )

    await expect(coordinator.sync()).rejects.toThrow('Already exists')
    expect(states.current).toEqual({
      version: 1,
      vault_id: 'vault-1',
      cursor: 2,
      items: {
        plan: tracked('plan', path, 1, 'v1'),
        other: tracked('other', 'Other.md', 1, 'other'),
        fresh: tracked('fresh', 'Fresh.md', 2, 'fresh')
      }
    })

    refuse = false
    const retry = await coordinator.sync()

    expect(retry.localConflicts).toEqual([])
    expect([...fs.files.keys()].sort()).toEqual(['Fresh.md', 'New.md', 'archive/Other.md', path])
    expect(fs.files.get(path)).toBe('v3')
    expect(states.current?.cursor).toBe(6)
    expect(states.current?.items.new).toEqual(tracked('new', 'New.md', 4, 'new'))
    expect(states.current?.pending_conflicts ?? {}).toEqual({})
    expect(server.mutations).toEqual([])
  })

  it('pulls each change in a large vault in microseconds, not milliseconds', async () => {
    // Every pulled change used to copy the whole tracked state, so a phone
    // catching up on a big vault paid for its size on every file: 1.7 ms a
    // change at 10,000 notes against 0.18 ms at 600 (18 µs at both now).
    async function perChange(vaultSize: number, arriving: number): Promise<number> {
      const items: CloudSyncState['items'] = {}
      const files = new Map<string, CloudSyncLocalItem>()
      for (let index = 0; index < vaultSize; index++) {
        const notePath = `inbox/Note ${index}.md`
        const body = content(`note ${index}`)
        items[`note-${index}`] = {
          item_id: `note-${index}`, path: notePath, kind: 'text', revision: 1,
          sha256: body.sha256, byte_length: body.byte_length, media_type: body.media_type
        }
        files.set(notePath, { path: notePath, kind: 'text', content: body })
      }
      const changes = Array.from({ length: arriving }, (_, index): CloudSyncChange => ({
        sequence: vaultSize + index + 1,
        item_id: `new-${index}`,
        type: 'upsert',
        path: `inbox/New ${index}.md`,
        previous_path: null,
        revision: 1,
        content: content(`new ${index}`)
      }))
      // Timed from the first file written to the last, so the run's one scan
      // and one save, which do grow with the vault, are left out.
      let first = 0
      let last = 0
      const repository: CloudSyncRepository = {
        async scan() {
          return [...files.values()]
        },
        async apply(change) {
          last = performance.now()
          first ||= last
          if (change.content) files.set(change.path, { path: change.path, kind: 'text', content: change.content })
        }
      }
      const result = await new CloudSyncCoordinator(
        'vault-1',
        remote({ changes }),
        repository,
        memoryState({ version: 1, vault_id: 'vault-1', cursor: vaultSize, items }),
        ids()
      ).sync()
      expect(result.pulled).toBe(arriving)
      return (last - first) / (arriving - 1)
    }

    // A bound in absolute time, not a ratio to a small vault: a change there
    // takes a microsecond or two, so that ratio swung from 1.5 to 4.6 on a
    // quiet machine and failed a 5x bound on macOS CI (25 µs against 2.7 µs).
    // At 20,000 notes a change takes 2 to 5 µs now and took 3.6 ms (7 ms on a
    // busy machine) with the copy, so 250 µs sits a decade clear of both. The
    // fastest of three runs drops the pauses that only ever add time, and a
    // small run first warms the code up.
    await perChange(200, 2000)
    const runs: number[] = []
    for (let run = 0; run < 3; run++) runs.push(await perChange(20_000, 2000))
    expect(Math.min(...runs)).toBeLessThan(0.25)
  })

  it('queues a real local edit without creating a note beside it', async () => {
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

    expect(result.localConflicts).toEqual([])
    expect(result.pendingConflicts).toEqual([
      expect.objectContaining({ id: 'plan', path, kind: 'content' })
    ])
    expect(fs.files.get(path)).toBe('edited here while offline')
    expect(fs.files.has('inbox/Plan (cloud conflict).md')).toBe(false)
  })

  it('queues an overlapping edit outside the vault and keeps unrelated sync moving', async () => {
    const fs = memoryFileSystem({
      [path]: '# Plan\nMeet at 10.\n',
      'inbox/Other.md': 'old'
    })
    const base = realContent('# Plan\nMeet at 9.\n')
    const states = memoryState({
      version: 1,
      vault_id: 'vault-1',
      cursor: 1,
      items: {
        plan: tracked('plan', path, 1, base.data),
        other: tracked('other', 'inbox/Other.md', 1, 'old')
      },
      pending_conflicts: {}
    })
    const server = remote({
      manifest: {
        data: [
          {
            item_id: 'plan',
            path,
            kind: 'text',
            revision: 2,
            sha256: realContent('# Plan\nMeet at 11.\n').sha256,
            byte_length: realContent('# Plan\nMeet at 11.\n').byte_length,
            media_type: 'text/markdown',
            content: realContent('# Plan\nMeet at 11.\n')
          },
          {
            item_id: 'other',
            path: 'inbox/Other.md',
            kind: 'text',
            revision: 3,
            sha256: realContent('new').sha256,
            byte_length: 3,
            media_type: 'text/markdown',
            content: realContent('new')
          }
        ],
        cursor: 3,
        next_page: null
      },
      changes: [
        upsert(2, 'plan', path, '# Plan\nMeet at 11.\n'),
        upsert(3, 'other', 'inbox/Other.md', 'new')
      ],
      mutate: (body) => ({
        acknowledged: body.mutations.map((mutation) => ({
          operation_id: mutation.operation_id,
          item_id: mutation.item_id,
          revision: 3,
          sequence: 4
        })),
        conflicts: [],
        cursor: 4
      })
    })
    retaining(server, 'plan', 1, path, base)
    const coordinator = new CloudSyncCoordinator(
      'vault-1',
      server,
      new PortableCloudSyncRepository(fs),
      states,
      ids()
    )
    const result = await coordinator.sync()

    expect([...fs.files.keys()].sort()).toEqual(['inbox/Other.md', path].sort())
    expect(fs.files.get(path)).toBe('# Plan\nMeet at 10.\n')
    expect(fs.files.get('inbox/Other.md')).toBe('new')
    expect(result.pendingConflicts).toEqual([
      expect.objectContaining({
        id: 'plan',
        item_id: 'plan',
        path,
        kind: 'content',
        can_merge: true
      })
    ])
    expect(states.current?.pending_conflicts?.plan).toMatchObject({
      local: { content: { data: '# Plan\nMeet at 10.\n' } },
      cloud: { content: { data: '# Plan\nMeet at 11.\n' } },
      base: { content: { data: '# Plan\nMeet at 9.\n' } }
    })
    expect(states.current?.cursor).toBe(3)

    await expect(coordinator.getConflict('plan')).resolves.toMatchObject({
      base: { text: '# Plan\nMeet at 9.\n' },
      local: { text: '# Plan\nMeet at 10.\n', deleted: false },
      cloud: { text: '# Plan\nMeet at 11.\n', deleted: false },
      draft_text: null,
      changes: [
        {
          id: 'change-1',
          base_text: 'Meet at 9.\n',
          local_text: 'Meet at 10.\n',
          cloud_text: 'Meet at 11.\n'
        }
      ]
    })

    await coordinator.saveConflictDraft('plan', '# Plan\nMeet at 10:30.\n')
    const resumed = new CloudSyncCoordinator(
      'vault-1',
      server,
      new PortableCloudSyncRepository(fs),
      states,
      ids()
    )
    await expect(resumed.getConflict('plan')).resolves.toMatchObject({
      draft_text: '# Plan\nMeet at 10:30.\n'
    })

    await resumed.resolveConflict({
      conflict_id: 'plan',
      choice: 'changes',
      expected_local_sha256: realContent('# Plan\nMeet at 10.\n').sha256,
      expected_cloud_revision: 2,
      change_choices: { 'change-1': 'local' }
    })
    expect(fs.files.get(path)).toBe('# Plan\nMeet at 10.\n')
    expect(states.current?.pending_conflicts).toEqual({})
    expect(server.mutations.at(-1)?.mutations).toEqual([
      expect.objectContaining({
        type: 'upsert',
        item_id: 'plan',
        base_revision: 2,
        content: expect.objectContaining({ data: '# Plan\nMeet at 10.\n' })
      })
    ])
  })

  it('automatically combines non-overlapping local and cloud text edits', async () => {
    const baseText = '# Trip\nPack a coat.\nBook a hotel.\n'
    const localText = '# Autumn trip\nPack a coat.\nBook a hotel.\n'
    const cloudText = '# Trip\nPack a warm coat.\nBook a hotel.\n'
    const base = realContent(baseText)
    const fs = memoryFileSystem({ [path]: localText })
    const states = memoryState({
      version: 1,
      vault_id: 'vault-1',
      cursor: 1,
      items: {
        plan: tracked('plan', path, 1, baseText)
      },
      pending_conflicts: {}
    })
    const server = remote({ changes: [upsert(2, 'plan', path, cloudText)] })
    retaining(server, 'plan', 1, path, base)

    const result = await new CloudSyncCoordinator(
      'vault-1',
      server,
      new PortableCloudSyncRepository(fs),
      states,
      ids()
    ).sync()

    expect(result.pendingConflicts).toEqual([])
    expect(fs.files.get(path)).toBe('# Autumn trip\nPack a warm coat.\nBook a hotel.\n')
    expect(server.mutations.flatMap((request) => request.mutations)).toEqual([
      expect.objectContaining({
        type: 'upsert',
        item_id: 'plan',
        base_revision: 2,
        content: expect.objectContaining({
          data: '# Autumn trip\nPack a warm coat.\nBook a hotel.\n'
        })
      })
    ])
  })

  it('loads the retained base revision for an upgraded client before comparing edits', async () => {
    const baseText = '# Plan\nMeet at 9.\n'
    const localText = '# Plan\nMeet at 10.\n'
    const cloudText = '# Plan\nMeet at 11.\n'
    const fs = memoryFileSystem({ [path]: localText })
    const states = memoryState({
      version: 1,
      vault_id: 'vault-1',
      cursor: 1,
      items: { plan: tracked('plan', path, 1, baseText) }
    })
    const server = Object.assign(remote({ changes: [upsert(2, 'plan', path, cloudText)] }), {
      async revision() {
        return {
          data: {
            item_id: 'plan',
            revision: 1,
            path,
            kind: 'text' as const,
            deleted: false,
            content: realContent(baseText)
          }
        }
      }
    })
    const revision = vi.spyOn(server, 'revision')
    const coordinator = new CloudSyncCoordinator(
      'vault-1',
      server,
      new PortableCloudSyncRepository(fs),
      states,
      ids()
    )

    await coordinator.sync()

    expect(revision).toHaveBeenCalledWith('vault-1', 'plan', 1)
    await expect(coordinator.getConflict('plan')).resolves.toMatchObject({
      base: { text: baseText },
      local: { text: localText },
      cloud: { text: cloudText },
      changes: [{ base_text: 'Meet at 9.\n' }]
    })
  })
})

describe('CloudSyncCoordinator: rejected mutations name their file', () => {
  it('turns a path race into one paused resolver item instead of two warnings', async () => {
    const fs = memoryFileSystem({ 'inbox/Plan.md': 'edited here' })
    const states = memoryState({
      version: 1,
      vault_id: 'vault-1',
      cursor: 0,
      items: {}
    })
    const requests: CloudSyncMutationRequest[] = []
    let raced = false
    const cloud = realContent('made elsewhere')
    const server: CloudSyncRemote = {
      async manifest() {
        return {
          data: [
            {
              item_id: 'cloud-item',
              path: 'inbox/Plan.md',
              kind: 'text',
              revision: 1,
              sha256: cloud.sha256,
              byte_length: cloud.byte_length,
              media_type: cloud.media_type,
              content: cloud
            }
          ],
          cursor: raced ? 1 : 0,
          next_page: null
        }
      },
      async changes(_vaultId, after) {
        const data =
          raced && after < 1 ? [upsert(1, 'cloud-item', 'inbox/Plan.md', 'made elsewhere')] : []
        return { data, cursor: data.length ? 1 : after, has_more: false }
      },
      async mutate(_vaultId, body) {
        requests.push(body)
        raced = true
        return {
          acknowledged: [],
          conflicts: body.mutations.map((mutation) => ({
            operation_id: mutation.operation_id,
            item_id: mutation.item_id,
            code: 'PATH_CONFLICT' as const,
            current_revision: 1,
            current_path: 'inbox/Plan.md'
          })),
          cursor: 1
        }
      }
    }
    const coordinator = new CloudSyncCoordinator(
      'vault-1',
      server,
      new PortableCloudSyncRepository(fs),
      states,
      ids()
    )

    const first = await coordinator.sync()
    const second = await coordinator.sync()

    expect(first.conflicts).toEqual([])
    expect(first.pendingConflicts).toEqual([
      expect.objectContaining({
        id: 'cloud-item',
        kind: 'path',
        path: 'inbox/Plan.md'
      })
    ])
    expect(second.pendingConflicts).toEqual(first.pendingConflicts)
    expect(requests).toHaveLength(1)
    expect(fs.files.get('inbox/Plan.md')).toBe('edited here')
  })

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
          code:
            mutation.type === 'delete' ? ('ITEM_DELETED' as const) : ('REVISION_CONFLICT' as const),
          current_revision: 3,
          current_path: null
        })),
        cursor: 1
      })
    })

    const result = await new CloudSyncCoordinator(
      'vault-1',
      server,
      repository,
      states,
      ids()
    ).sync()

    expect(result.conflicts.map((c) => [c.item_id, c.code, c.path])).toEqual([
      ['gone', 'ITEM_DELETED', 'inbox/Gone.md'],
      ['kept', 'REVISION_CONFLICT', 'inbox/Kept.md']
    ])
  })
})

describe('CloudSyncCoordinator: decisions on queued conflicts', () => {
  const path = 'inbox/Plan.md'
  const movedPath = 'archive/Plan.md'

  function manifestItem(itemId: string, itemPath: string, revision: number, data: string) {
    const content = realContent(data)
    return {
      item_id: itemId,
      path: itemPath,
      kind: 'text' as const,
      revision,
      sha256: content.sha256,
      byte_length: content.byte_length,
      media_type: content.media_type,
      content
    }
  }

  function movedOnCloud(): { changes: CloudSyncChange[]; manifest: CloudSyncManifestResponse } {
    return {
      changes: [
        {
          sequence: 2,
          item_id: 'plan',
          type: 'move',
          path: movedPath,
          previous_path: path,
          revision: 2
        }
      ],
      manifest: { data: [manifestItem('plan', movedPath, 2, 'agreed')], cursor: 2, next_page: null }
    }
  }

  it('lets a file edited here and moved on the other device take the Cloud side', async () => {
    const fs = memoryFileSystem({ [path]: 'edited here' })
    const states = memoryState({
      version: 1,
      vault_id: 'vault-1',
      cursor: 1,
      items: { plan: tracked('plan', path, 1, 'agreed') }
    })
    const coordinator = new CloudSyncCoordinator(
      'vault-1',
      remote(movedOnCloud()),
      new PortableCloudSyncRepository(fs),
      states,
      ids()
    )

    const result = await coordinator.sync()
    expect(result.pendingConflicts).toEqual([
      expect.objectContaining({ id: 'plan', kind: 'move', path, cloud_path: movedPath })
    ])
    // Without a revision endpoint the Cloud side is metadata only, which is
    // still enough to verify freshness and to fetch the body at decision time.
    expect(states.current?.pending_conflicts?.plan.cloud.content).toMatchObject({
      sha256: realContent('agreed').sha256,
      byte_length: realContent('agreed').byte_length,
      data: ''
    })

    const details = await coordinator.getConflict('plan')
    await coordinator.resolveConflict({
      conflict_id: 'plan',
      choice: 'cloud',
      expected_local_sha256: details.local.sha256,
      expected_cloud_revision: 2
    })

    expect([...fs.files.keys()]).toEqual([movedPath])
    expect(fs.files.get(movedPath)).toBe('agreed')
    expect(states.current?.pending_conflicts?.plan).toBeUndefined()
  })

  it('lets that file keep this device version without rewriting it', async () => {
    const fs = memoryFileSystem({ [path]: 'edited here' })
    const states = memoryState({
      version: 1,
      vault_id: 'vault-1',
      cursor: 1,
      items: { plan: tracked('plan', path, 1, 'agreed') }
    })
    const server = remote(movedOnCloud())
    retaining(server, 'plan', 2, movedPath, realContent('agreed'))
    const repository = new PortableCloudSyncRepository(fs)
    const writes = vi.spyOn(repository, 'applyConflictResolutionFiles')
    const coordinator = new CloudSyncCoordinator('vault-1', server, repository, states, ids())

    await coordinator.sync()
    const details = await coordinator.getConflict('plan')
    // The retained revision gives the resolver the Cloud text to compare.
    expect(details.cloud.text).toBe('agreed')
    await coordinator.resolveConflict({
      conflict_id: 'plan',
      choice: 'local',
      expected_local_sha256: details.local.sha256,
      expected_cloud_revision: 2
    })

    expect(writes).not.toHaveBeenCalled()
    expect(fs.files.get(path)).toBe('edited here')
    expect(server.mutations.flatMap((request) => request.mutations)).toEqual([
      expect.objectContaining({
        type: 'upsert',
        item_id: 'plan',
        path,
        base_revision: 2,
        content: expect.objectContaining({ data: 'edited here' })
      })
    ])
    expect(states.current?.pending_conflicts?.plan).toBeUndefined()
  })

  it('keeps a same-path conflict labelled as content when the other device saves again', async () => {
    const local: CloudSyncLocalItem = { path: 'Plan.md', kind: 'text', content: content('mine') }
    const repository: CloudSyncRepository = {
      async scan() {
        return [local]
      },
      async apply(change) {
        return {
          code: 'LOCAL_EDIT_CONFLICT',
          path: change.path,
          conflict_copy_path: 'Plan (cloud conflict).md',
          local
        }
      }
    }
    const changes: CloudSyncChange[] = [upsert(2, 'plan', 'Plan.md', 'theirs')]
    const states = memoryState({ version: 1, vault_id: 'vault-1', cursor: 1, items: {} })
    const server = remote({
      changes,
      mutate: () => ({ acknowledged: [], conflicts: [], cursor: 2 })
    })
    const coordinator = new CloudSyncCoordinator('vault-1', server, repository, states, ids())

    await coordinator.sync()
    changes.push(upsert(3, 'plan', 'Plan.md', 'theirs again'))
    const result = await coordinator.sync()

    expect(result.pendingConflicts).toEqual([
      expect.objectContaining({ id: 'plan', kind: 'content', path: 'Plan.md', cloud_path: 'Plan.md' })
    ])
    expect(states.current?.pending_conflicts?.plan.cloud.content?.data).toBe('theirs again')
  })

  it('queues the conflict when the file changes under an automatic merge', async () => {
    const baseText = '# Trip\nPack a coat.\n'
    const local: CloudSyncLocalItem = {
      path,
      kind: 'text',
      content: realContent('# Autumn trip\nPack a coat.\n')
    }
    const repository: CloudSyncRepository = {
      async scan() {
        return [local]
      },
      async apply(change) {
        return { code: 'LOCAL_EDIT_CONFLICT', path: change.path, conflict_copy_path: '', local }
      },
      async replaceConflictFile() {
        throw new Error('This file changed on this device.')
      }
    }
    const states = memoryState({
      version: 1,
      vault_id: 'vault-1',
      cursor: 1,
      items: { plan: tracked('plan', path, 1, baseText) }
    })
    const server = remote({
      changes: [upsert(2, 'plan', path, '# Trip\nPack a warm coat.\n')],
      mutate: () => ({ acknowledged: [], conflicts: [], cursor: 2 })
    })
    retaining(server, 'plan', 1, path, realContent(baseText))

    const result = await new CloudSyncCoordinator(
      'vault-1',
      server,
      repository,
      states,
      ids()
    ).sync()

    expect(result.pendingConflicts).toEqual([expect.objectContaining({ id: 'plan', path })])
    expect(states.current?.cursor).toBe(2)
  })

  it('keeps large snapshots out of state and fetches the Cloud bytes for a decision', async () => {
    const big = (fill: string) => `${fill}\n`.repeat(80_000)
    const local: CloudSyncLocalItem = { path, kind: 'text', content: realContent(big('mine')) }
    const cloudText = big('theirs')
    const written: Array<{ path: string; content: CloudSyncContent }> = []
    const repository: CloudSyncRepository = {
      async scan() {
        return [local]
      },
      async apply(change) {
        return { code: 'LOCAL_EDIT_CONFLICT', path: change.path, conflict_copy_path: '', local }
      },
      async applyConflictResolutionFiles(input) {
        written.push(...input.files)
      }
    }
    const states = memoryState({
      version: 1,
      vault_id: 'vault-1',
      cursor: 1,
      items: { plan: tracked('plan', path, 1, 'agreed') }
    })
    const server = remote({
      changes: [upsert(2, 'plan', path, cloudText)],
      manifest: { data: [manifestItem('plan', path, 2, cloudText)], cursor: 2, next_page: null },
      mutate: () => ({ acknowledged: [], conflicts: [], cursor: 2 })
    })
    const coordinator = new CloudSyncCoordinator('vault-1', server, repository, states, ids())

    await coordinator.sync()
    const stored = states.current?.pending_conflicts?.plan
    expect(stored?.local.content).toMatchObject({ data: '', byte_length: local.content.byte_length })
    expect(stored?.cloud.content).toMatchObject({ data: '', byte_length: Buffer.byteLength(cloudText) })

    const details = await coordinator.getConflict('plan')
    expect(details.local.text).toBeNull()
    expect(details.cloud.text).toBeNull()
    await coordinator.resolveConflict({
      conflict_id: 'plan',
      choice: 'cloud',
      expected_local_sha256: details.local.sha256,
      expected_cloud_revision: 2
    })

    expect(written).toEqual([{ path, content: expect.objectContaining({ data: cloudText }), displace_existing: true }])
  })

  it('uploads a large local file from disk without rewriting it as empty', async () => {
    const marker: CloudSyncContent = {
      encoding: 'base64',
      data: '',
      sha256: 'hash:six-megabytes',
      byte_length: 6 * 1024 * 1024,
      media_type: 'application/pdf'
    }
    const local: CloudSyncLocalItem = { path: 'Deck.pdf', kind: 'binary', content: marker }
    const writes = vi.fn()
    const repository: CloudSyncRepository = {
      async scan() {
        return [local]
      },
      async apply(change) {
        return { code: 'LOCAL_EDIT_CONFLICT', path: change.path, conflict_copy_path: '', local }
      },
      applyConflictResolutionFiles: writes
    }
    const cloud = binaryContent('theirs')
    const states = memoryState({
      version: 1,
      vault_id: 'vault-1',
      cursor: 1,
      items: {
        deck: {
          item_id: 'deck',
          path: 'Deck.pdf',
          kind: 'binary',
          revision: 1,
          sha256: 'hash:agreed',
          byte_length: 6,
          media_type: 'application/pdf'
        }
      }
    })
    const server = remote({
      changes: [
        {
          sequence: 2,
          item_id: 'deck',
          type: 'upsert',
          path: 'Deck.pdf',
          previous_path: null,
          revision: 2,
          content: cloud
        }
      ],
      manifest: {
        data: [
          {
            item_id: 'deck',
            path: 'Deck.pdf',
            kind: 'binary',
            revision: 2,
            sha256: cloud.sha256,
            byte_length: cloud.byte_length,
            media_type: cloud.media_type,
            content: cloud
          }
        ],
        cursor: 2,
        next_page: null
      },
      mutate: (body) => ({
        acknowledged: body.mutations.map((mutation) => ({
          operation_id: mutation.operation_id,
          item_id: mutation.item_id,
          revision: 3,
          sequence: 3
        })),
        conflicts: [],
        cursor: 3
      })
    })
    const coordinator = new CloudSyncCoordinator('vault-1', server, repository, states, ids())

    await coordinator.sync()
    const details = await coordinator.getConflict('deck')
    await coordinator.resolveConflict({
      conflict_id: 'deck',
      choice: 'local',
      expected_local_sha256: details.local.sha256,
      expected_cloud_revision: 2
    })

    expect(writes).not.toHaveBeenCalled()
    expect(server.mutations.flatMap((request) => request.mutations)).toEqual([
      expect.objectContaining({
        type: 'upsert',
        item_id: 'deck',
        path: 'Deck.pdf',
        content: expect.objectContaining({ data: '', byte_length: 6 * 1024 * 1024 })
      })
    ])
  })
})

/* ---------- A device away longer than Cloud keeps its change log ---------- */

/** Cloud's answer to a cursor older than what is left of its change log. */
function cursorExpired(): Error {
  return Object.assign(
    new Error('This cursor is older than the retained change log. Rebuild this vault from its manifest.'),
    { name: 'CloudServiceRequestError', status: 410, code: 'CURSOR_EXPIRED', details: { pruned_through: 30, cursor: 40 } }
  )
}

/** Cloud at cursor 40, with everything through 30 pruned from its log. */
function prunedServer(
  files: Array<[itemId: string, path: string, revision: number, data: string]>,
  changes: CloudSyncChange[] = []
): ReturnType<typeof remote> {
  const server = remote({
    manifest: {
      data: files.map(([item_id, path, revision, data]) => {
        const body = realContent(data)
        return {
          item_id, path, kind: 'text' as const, revision,
          sha256: body.sha256, byte_length: body.byte_length, media_type: body.media_type,
          content: body
        }
      }),
      cursor: 40,
      next_page: null
    },
    changes
  })
  const follow = server.changes.bind(server)
  server.changes = vi.fn(async (vaultId: string, after: number, limit?: number) => {
    if (after < 30) throw cursorExpired()
    return follow(vaultId, after, limit)
  })
  return server
}

/** What sync last agreed on before this device went away, at cursor 3. */
function awayState(...items: CloudSyncTrackedItem[]): CloudSyncState {
  return { version: 1, vault_id: 'vault-1', cursor: 3, items: Object.fromEntries(items.map((item) => [item.item_id, item])) }
}

describe('CloudSyncCoordinator: a cursor older than the change log (CURSOR_EXPIRED)', () => {
  it('catches up from the manifest when nothing changed on this device', async () => {
    const fs = memoryFileSystem({ 'Plan.md': 'v1', 'Old.md': 'old', 'Trip.md': 'same' })
    const states = memoryState(awayState(
      tracked('plan', 'Plan.md', 1, 'v1'),
      tracked('old', 'Old.md', 1, 'old'),
      tracked('trip', 'Trip.md', 1, 'same')
    ))
    // Edited, deleted, moved and created elsewhere while this device was away.
    const server = prunedServer(
      [['plan', 'Plan.md', 7, 'v7'], ['trip', 'archive/Trip.md', 2, 'same'], ['new', 'New.md', 1, 'new']],
      [upsert(41, 'later', 'Later.md', 'after the trip')]
    )
    const coordinator = new CloudSyncCoordinator('vault-1', server, new PortableCloudSyncRepository(fs), states, ids())

    const result = await coordinator.sync()

    expect(Object.fromEntries(fs.files)).toEqual({
      'Plan.md': 'v7',
      'archive/Trip.md': 'same',
      'New.md': 'new',
      'Later.md': 'after the trip'
    })
    expect(server.mutations).toEqual([])
    expect(result).toMatchObject({ pulled: 5, pushed: 0, localConflicts: [], pendingConflicts: [] })
    // Then it follows the log again from the manifest's cursor.
    expect(states.current?.cursor).toBe(41)
    expect(states.current?.items).toEqual({
      plan: tracked('plan', 'Plan.md', 7, 'v7'),
      trip: tracked('trip', 'archive/Trip.md', 2, 'same'),
      new: tracked('new', 'New.md', 1, 'new'),
      later: tracked('later', 'Later.md', 41, 'after the trip')
    })
    await expect(coordinator.sync()).resolves.toMatchObject({ pulled: 0, pushed: 0 })
  })

  it('pushes edits made while away and never overwrites one Cloud also changed', async () => {
    // Plan.md was edited here, Gone.md deleted here, Fresh.md created here.
    // Notes.md was edited on both sides.
    const fs = memoryFileSystem({ 'Plan.md': 'mine', 'Notes.md': 'notes, edited here', 'Fresh.md': 'fresh' })
    const states = memoryState(awayState(
      tracked('plan', 'Plan.md', 1, 'v1'),
      tracked('notes', 'Notes.md', 1, 'notes'),
      tracked('gone', 'Gone.md', 1, 'gone')
    ))
    const server = prunedServer([
      ['plan', 'Plan.md', 1, 'v1'],
      ['notes', 'Notes.md', 5, 'notes, edited in Cloud'],
      ['gone', 'Gone.md', 1, 'gone']
    ])

    const result = await new CloudSyncCoordinator(
      'vault-1', server, new PortableCloudSyncRepository(fs), states, ids()
    ).sync()

    expect(Object.fromEntries(fs.files)).toEqual({
      'Plan.md': 'mine',
      'Notes.md': 'notes, edited here',
      'Fresh.md': 'fresh'
    })
    expect(server.mutations.flatMap((request) => request.mutations)).toEqual([
      expect.objectContaining({ type: 'delete', item_id: 'gone', base_revision: 1 }),
      expect.objectContaining({ type: 'upsert', item_id: 'plan', base_revision: 1, path: 'Plan.md', content: realContent('mine') }),
      expect.objectContaining({ type: 'upsert', base_revision: null, path: 'Fresh.md', content: realContent('fresh') })
    ])
    expect(result.localConflicts).toEqual([])
    expect(result.pendingConflicts).toEqual([
      expect.objectContaining({ item_id: 'notes', kind: 'content', path: 'Notes.md' })
    ])
    expect(states.current?.pending_conflicts?.notes).toMatchObject({
      base: { path: 'Notes.md', revision: 1 },
      local: { path: 'Notes.md', content: realContent('notes, edited here') },
      cloud: { path: 'Notes.md', revision: 5, content: realContent('notes, edited in Cloud') }
    })
    expect(states.current?.cursor).toBe(40)
  })

  it('keeps a file edited here that Cloud deleted, and asks', async () => {
    const fs = memoryFileSystem({ 'Plan.md': 'mine' })
    const states = memoryState(awayState(tracked('plan', 'Plan.md', 2, 'v2')))
    const server = prunedServer([])
    const coordinator = new CloudSyncCoordinator('vault-1', server, new PortableCloudSyncRepository(fs), states, ids())

    const result = await coordinator.sync()

    expect(fs.files.get('Plan.md')).toBe('mine')
    expect(server.mutations).toEqual([])
    expect(result.pendingConflicts).toEqual([
      expect.objectContaining({ item_id: 'plan', kind: 'delete', path: 'Plan.md', cloud_path: null })
    ])
    // The manifest lists only live files, so the revision that deleted it is unknown.
    expect(states.current?.pending_conflicts?.plan?.cloud).toMatchObject({ path: null, revision: null })
    expect(states.current?.items).toEqual({})

    const details = await coordinator.getConflict('plan')
    expect(details.cloud).toMatchObject({ deleted: true, revision: null })
    await coordinator.resolveConflict({
      conflict_id: 'plan',
      choice: 'local',
      expected_local_sha256: details.local.sha256,
      expected_cloud_revision: details.cloud.revision
    })

    // With no revision of the deleted file to build on, this device's version
    // goes back to Cloud as a new file.
    expect(server.mutations.flatMap((request) => request.mutations)).toEqual([
      expect.objectContaining({ type: 'upsert', item_id: 'item-local-1', base_revision: null, path: 'Plan.md', content: realContent('mine') })
    ])
    expect(fs.files.get('Plan.md')).toBe('mine')
    expect(states.current?.pending_conflicts).toEqual({})
    expect(states.current?.items['item-local-1']).toMatchObject({ path: 'Plan.md', sha256: realContent('mine').sha256 })
  })

  it('removes the file when the person accepts a delete it found while away', async () => {
    const fs = memoryFileSystem({ 'Plan.md': 'mine' })
    const states = memoryState(awayState(tracked('plan', 'Plan.md', 2, 'v2')))
    const server = prunedServer([])
    const coordinator = new CloudSyncCoordinator('vault-1', server, new PortableCloudSyncRepository(fs), states, ids())
    await coordinator.sync()

    await coordinator.resolveConflict({
      conflict_id: 'plan',
      choice: 'cloud',
      expected_local_sha256: realContent('mine').sha256,
      expected_cloud_revision: null
    })

    expect(fs.files.has('Plan.md')).toBe(false)
    expect(server.mutations).toEqual([])
    expect(states.current?.pending_conflicts).toEqual({})
  })

  it('moves a decision queued before the trip to the Cloud version it now faces', async () => {
    const fs = memoryFileSystem({ 'Plan.md': 'mine' })
    const states = memoryState({
      ...awayState(tracked('plan', 'Plan.md', 2, 'v2')),
      pending_conflicts: {
        plan: {
          id: 'plan',
          item_id: 'plan',
          kind: 'content',
          sequence: 3,
          base: { path: 'Plan.md', revision: 1, kind: 'text', content: realContent('v1') },
          local: { path: 'Plan.md', revision: null, kind: 'text', content: realContent('mine') },
          cloud: { path: 'Plan.md', revision: 2, kind: 'text', content: realContent('v2') }
        }
      }
    })
    const server = prunedServer([['plan', 'Plan.md', 9, 'v9']])

    const result = await new CloudSyncCoordinator(
      'vault-1', server, new PortableCloudSyncRepository(fs), states, ids()
    ).sync()

    expect(fs.files.get('Plan.md')).toBe('mine')
    expect(server.mutations).toEqual([])
    expect(result.pendingConflicts).toHaveLength(1)
    expect(states.current?.pending_conflicts?.plan?.cloud).toMatchObject({ revision: 9, content: realContent('v9') })
    expect(states.current?.items.plan).toEqual(tracked('plan', 'Plan.md', 9, 'v9'))
  })

  it('lands a file Cloud re-created at a path whose old file it deleted', async () => {
    // Plan.md was deleted elsewhere and a new Plan.md with the same words
    // made in its place. The delete must not take the new note with it.
    const fs = memoryFileSystem({ 'Plan.md': 'same words' })
    const states = memoryState(awayState(tracked('old-plan', 'Plan.md', 1, 'same words')))
    const server = prunedServer([['new-plan', 'Plan.md', 1, 'same words']])

    const result = await new CloudSyncCoordinator(
      'vault-1', server, new PortableCloudSyncRepository(fs), states, ids()
    ).sync()

    expect(Object.fromEntries(fs.files)).toEqual({ 'Plan.md': 'same words' })
    expect(server.mutations).toEqual([])
    expect(result).toMatchObject({ pulled: 2, pendingConflicts: [] })
    expect(states.current?.items).toEqual({ 'new-plan': tracked('new-plan', 'Plan.md', 1, 'same words') })
  })

  it('lands a chain of renames in the order that frees each path', async () => {
    // Cloud renamed B to C, then A to B. Tracked order puts A first, which
    // used to find B still taken and queue a false conflict whose local side
    // later matched C by hash; choosing Cloud then removed C.
    const fs = memoryFileSystem({ 'A.md': 'x', 'B.md': 'y' })
    const states = memoryState(awayState(tracked('x', 'A.md', 1, 'x'), tracked('y', 'B.md', 1, 'y')))
    const server = prunedServer([['x', 'B.md', 2, 'x'], ['y', 'C.md', 2, 'y']])
    const coordinator = new CloudSyncCoordinator('vault-1', server, new PortableCloudSyncRepository(fs), states, ids())

    const result = await coordinator.sync()

    expect(Object.fromEntries(fs.files)).toEqual({ 'B.md': 'x', 'C.md': 'y' })
    expect(result).toMatchObject({ pendingConflicts: [], localConflicts: [] })
    expect(server.mutations).toEqual([])
    await expect(coordinator.sync()).resolves.toMatchObject({ pushed: 0, pendingConflicts: [] })
    expect(server.mutations).toEqual([])
  })

  it('lands a longer chain, a rename with new bytes in the middle, without a conflict', async () => {
    const fs = memoryFileSystem({ 'A.md': 'w', 'B.md': 'x', 'C.md': 'y' })
    const states = memoryState(awayState(
      tracked('w', 'A.md', 1, 'w'),
      tracked('x', 'B.md', 1, 'x'),
      tracked('y', 'C.md', 1, 'y')
    ))
    // C to D first, then B to C with an edit, then A to B.
    const server = prunedServer([['w', 'B.md', 2, 'w'], ['x', 'C.md', 3, 'x, edited in Cloud'], ['y', 'D.md', 2, 'y']])

    const result = await new CloudSyncCoordinator(
      'vault-1', server, new PortableCloudSyncRepository(fs), states, ids()
    ).sync()

    expect(Object.fromEntries(fs.files)).toEqual({ 'B.md': 'w', 'C.md': 'x, edited in Cloud', 'D.md': 'y' })
    expect(result).toMatchObject({ pulled: 3, pendingConflicts: [], localConflicts: [] })
    expect(server.mutations).toEqual([])
  })

  it('queues a ring of renames instead of moving anything, and settles it on Cloud', async () => {
    // A to B, B to C, C to A cannot be ordered without a temporary name.
    const fs = memoryFileSystem({ 'A.md': 'x', 'B.md': 'y', 'C.md': 'z' })
    const states = memoryState(awayState(
      tracked('x', 'A.md', 1, 'x'),
      tracked('y', 'B.md', 1, 'y'),
      tracked('z', 'C.md', 1, 'z')
    ))
    const server = prunedServer([['x', 'B.md', 2, 'x'], ['y', 'C.md', 2, 'y'], ['z', 'A.md', 2, 'z']])
    const coordinator = new CloudSyncCoordinator('vault-1', server, new PortableCloudSyncRepository(fs), states, ids())

    const result = await coordinator.sync()

    expect(Object.fromEntries(fs.files)).toEqual({ 'A.md': 'x', 'B.md': 'y', 'C.md': 'z' })
    expect(result.pendingConflicts.map((conflict) => [conflict.item_id, conflict.kind]).sort()).toEqual([
      ['x', 'move'], ['y', 'move'], ['z', 'move']
    ])
    expect(server.mutations).toEqual([])

    for (const id of ['x', 'y', 'z']) {
      const details = await coordinator.getConflict(id)
      await coordinator.resolveConflict({
        conflict_id: id,
        choice: 'cloud',
        expected_local_sha256: details.local.sha256,
        expected_cloud_revision: details.cloud.revision
      })
    }
    expect(Object.fromEntries(fs.files)).toEqual({ 'A.md': 'z', 'B.md': 'x', 'C.md': 'y' })
    await expect(coordinator.sync()).resolves.toMatchObject({ pushed: 0, pendingConflicts: [] })
    expect(server.mutations).toEqual([])
  })

  it('keeps what landed when a file fails midway, so a retry does not redo it (#813)', async () => {
    const fs = memoryFileSystem({ 'A.md': 'a1', 'B.md': 'b1' })
    const writeText = fs.writeText
    fs.writeText = async (path, value) => {
      if (path === 'B.md') throw new Error('disk full')
      await writeText(path, value)
    }
    const states = memoryState(awayState(tracked('a', 'A.md', 1, 'a1'), tracked('b', 'B.md', 1, 'b1')))
    const server = prunedServer([['a', 'A.md', 4, 'a4'], ['b', 'B.md', 4, 'b4']])
    const coordinator = new CloudSyncCoordinator('vault-1', server, new PortableCloudSyncRepository(fs), states, ids())

    await expect(coordinator.sync()).rejects.toThrow('disk full')
    expect(fs.files.get('A.md')).toBe('a4')
    expect(states.current?.cursor).toBe(3)
    expect(states.current?.items.a).toEqual(tracked('a', 'A.md', 4, 'a4'))
    expect(states.current?.items.b).toEqual(tracked('b', 'B.md', 1, 'b1'))

    // The person deletes A.md before the retry: it stays deleted.
    fs.files.delete('A.md')
    fs.writeText = writeText
    await coordinator.sync()

    expect(Object.fromEntries(fs.files)).toEqual({ 'B.md': 'b4' })
    expect(server.mutations.flatMap((request) => request.mutations)).toEqual([
      expect.objectContaining({ type: 'delete', item_id: 'a', base_revision: 4 })
    ])
    expect(states.current?.cursor).toBe(40)
  })
})

describe('CloudSyncCoordinator: a file that only passed through this device (Dave, 2026-10-23)', () => {
  const note = 'inbox/Daily Notes/Untitled.md'
  const trashed = 'trash/Daily Notes/Untitled.md'
  const second = 'trash/Daily Notes/Untitled 2.md'

  function manifestItem(itemId: string, itemPath: string, revision: number, data: string) {
    const content = realContent(data)
    return {
      item_id: itemId, path: itemPath, kind: 'text' as const, revision,
      sha256: content.sha256, byte_length: content.byte_length, media_type: content.media_type, content
    }
  }

  // While this device's sync was stuck it edited Untitled.md; the computer
  // trashed it, made a new Untitled.md at the same path and trashed that too.
  function computerChurn() {
    return {
      changes: [
        { sequence: 2, item_id: 'plan', type: 'move' as const, path: trashed, previous_path: note, revision: 2 },
        upsert(3, 'second', note, 'second note'),
        { sequence: 4, item_id: 'second', type: 'move' as const, path: second, previous_path: note, revision: 4 }
      ],
      manifest: {
        data: [manifestItem('plan', trashed, 2, 'agreed'), manifestItem('second', second, 4, 'second note')],
        cursor: 4,
        next_page: null
      }
    }
  }

  function storedPhantom(): CloudSyncStoredConflict {
    return {
      id: 'second', item_id: 'second', kind: 'move', sequence: 4,
      base: { path: null, revision: null, kind: 'text', content: null },
      local: { path: note, revision: null, kind: 'text', content: realContent('edited here') },
      cloud: { path: second, revision: 4, kind: 'text', content: realContent('second note') }
    }
  }

  it('lands the computer\'s second note in the trash instead of queuing it against this device\'s note', async () => {
    const fs = memoryFileSystem({ [note]: 'edited here' })
    const states = memoryState({ version: 1, vault_id: 'vault-1', cursor: 1, items: { plan: tracked('plan', note, 1, 'agreed') } })
    const server = remote(computerChurn())

    const result = await new CloudSyncCoordinator('vault-1', server, new PortableCloudSyncRepository(fs), states, ids()).sync()

    expect(result.pendingConflicts).toEqual([
      expect.objectContaining({ id: 'plan', kind: 'move', path: note, cloud_path: trashed })
    ])
    expect(fs.files.get(note)).toBe('edited here')
    expect(fs.files.get(second)).toBe('second note')
    expect(states.current?.items.second).toMatchObject({ path: second, revision: 4 })
    expect(server.mutations).toEqual([])
  })

  it('settles a queued conflict an earlier version left on this device\'s note', async () => {
    const fs = memoryFileSystem({ [note]: 'edited here' })
    const states = memoryState({
      version: 1, vault_id: 'vault-1', cursor: 4,
      items: { plan: tracked('plan', trashed, 2, 'agreed'), second: tracked('second', second, 4, 'second note') },
      pending_conflicts: { second: storedPhantom() }
    })
    const server = remote({ manifest: computerChurn().manifest })

    const result = await new CloudSyncCoordinator('vault-1', server, new PortableCloudSyncRepository(fs), states, ids()).sync()

    expect(result.pendingConflicts).toEqual([])
    expect(fs.files.get(note)).toBe('edited here')
    expect(fs.files.get(second)).toBe('second note')
  })

  for (const choice of ['local', 'cloud'] as const) {
    it(`never deletes this device's note when "${choice}" is chosen on such a conflict`, async () => {
      const fs = memoryFileSystem({ [note]: 'edited here' })
      const states = memoryState({
        version: 1, vault_id: 'vault-1', cursor: 4,
        items: { second: tracked('second', second, 4, 'second note') },
        pending_conflicts: { second: storedPhantom() }
      })
      const server = remote({ manifest: computerChurn().manifest })
      const coordinator = new CloudSyncCoordinator('vault-1', server, new PortableCloudSyncRepository(fs), states, ids())

      await coordinator.resolveConflict({
        conflict_id: 'second', choice,
        expected_local_sha256: realContent('edited here').sha256, expected_cloud_revision: 4
      })

      expect(fs.files.get(note)).toBe('edited here')
      expect(fs.files.get(second)).toBe('second note')
      expect(states.current?.pending_conflicts?.second).toBeUndefined()
      expect(server.mutations).toEqual([])
    })
  }

  it('moves this device\'s own trashed note aside when the computer\'s version is chosen', async () => {
    const fs = memoryFileSystem({ [note]: 'edited here', [trashed]: 'the phone\'s own scratch' })
    const states = memoryState({ version: 1, vault_id: 'vault-1', cursor: 1, items: { plan: tracked('plan', note, 1, 'agreed') } })
    const churn = computerChurn()
    const server = remote({
      changes: [churn.changes[0]],
      manifest: { data: [manifestItem('plan', trashed, 2, 'agreed')], cursor: 2, next_page: null }
    })
    const coordinator = new CloudSyncCoordinator('vault-1', server, new PortableCloudSyncRepository(fs), states, ids())
    await coordinator.sync()
    const details = await coordinator.getConflict('plan')

    await coordinator.resolveConflict({
      conflict_id: 'plan', choice: 'cloud',
      expected_local_sha256: details.local.sha256, expected_cloud_revision: 2
    })

    expect(fs.files.get(trashed)).toBe('agreed')
    expect(fs.files.get(second)).toBe('the phone\'s own scratch')
    expect(fs.files.has(note)).toBe(false)
  })

  it('says another Cloud file holds the name instead of "changed again"', async () => {
    const fs = memoryFileSystem({ [note]: 'edited here' })
    const states = memoryState({ version: 1, vault_id: 'vault-1', cursor: 1, items: { plan: tracked('plan', note, 1, 'agreed') } })
    const churn = computerChurn()
    const server = remote({
      changes: [churn.changes[0]],
      manifest: { data: [manifestItem('plan', trashed, 2, 'agreed')], cursor: 2, next_page: null },
      mutate: (body) => ({
        acknowledged: [],
        conflicts: body.mutations.map((mutation) => ({
          operation_id: mutation.operation_id, item_id: mutation.item_id,
          code: 'PATH_CONFLICT' as const, current_revision: null, current_path: note
        })),
        cursor: 2
      })
    })
    const coordinator = new CloudSyncCoordinator('vault-1', server, new PortableCloudSyncRepository(fs), states, ids())
    await coordinator.sync()
    const details = await coordinator.getConflict('plan')

    await expect(coordinator.resolveConflict({
      conflict_id: 'plan', choice: 'local',
      expected_local_sha256: details.local.sha256, expected_cloud_revision: 2
    })).rejects.toThrow(`Another file in Cloud already uses “${note}”`)
    expect(fs.files.get(note)).toBe('edited here')
  })
})
