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

function content(data: string): CloudSyncContent {
  return {
    encoding: 'utf8',
    data,
    sha256: `hash:${data}`,
    byte_length: data.length,
    media_type: 'text/markdown'
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
