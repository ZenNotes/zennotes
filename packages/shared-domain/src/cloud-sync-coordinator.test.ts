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

    expect(written).toEqual([{ path, content: expect.objectContaining({ data: cloudText }) }])
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
