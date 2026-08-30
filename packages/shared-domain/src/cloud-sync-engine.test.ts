import { describe, expect, it } from 'vitest'
import type { CloudSyncContent, CloudSyncMutationResponse } from '@zennotes/bridge-contract/cloud-sync'
import {
  emptyCloudSyncState,
  planCloudSyncMutations,
  reduceCloudSyncChange,
  resolveCloudSyncMutations,
  type CloudSyncIdSource,
  type CloudSyncState
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
    itemId: () => `item-${++item}`,
    operationId: () => `operation-${++operation}`
  }
}

function trackedState(): CloudSyncState {
  return {
    version: 1,
    vault_id: 'vault-1',
    cursor: 4,
    items: {
      'item-existing': {
        item_id: 'item-existing',
        path: 'notes/existing.md',
        kind: 'text',
        revision: 2,
        sha256: 'hash:old',
        byte_length: 3,
        media_type: 'text/markdown'
      }
    }
  }
}

describe('planCloudSyncMutations', () => {
  it('creates an upsert for a new local file', () => {
    const plan = planCloudSyncMutations(
      emptyCloudSyncState('vault-1'),
      [{ path: 'notes/new.md', kind: 'text', content: content('new') }],
      ids()
    )

    expect(plan.mutations).toEqual([
      expect.objectContaining({
        type: 'upsert',
        item_id: 'item-1',
        operation_id: 'operation-1',
        base_revision: null,
        path: 'notes/new.md'
      })
    ])
  })

  it('upserts changed content and does nothing for acknowledged content', () => {
    const state = trackedState()
    expect(
      planCloudSyncMutations(
        state,
        [{ path: 'notes/existing.md', kind: 'text', content: content('old') }],
        ids()
      ).mutations
    ).toEqual([])

    expect(
      planCloudSyncMutations(
        state,
        [{ path: 'notes/existing.md', kind: 'text', content: content('edited') }],
        ids()
      ).mutations[0]
    ).toEqual(
      expect.objectContaining({
        type: 'upsert',
        item_id: 'item-existing',
        base_revision: 2,
        path: 'notes/existing.md'
      })
    )
  })

  it('detects a unique content-preserving rename as a move', () => {
    const plan = planCloudSyncMutations(
      trackedState(),
      [{ path: 'archive/existing.md', kind: 'text', content: content('old') }],
      ids()
    )

    expect(plan.mutations).toEqual([
      expect.objectContaining({
        type: 'move',
        item_id: 'item-existing',
        base_revision: 2,
        path: 'archive/existing.md'
      })
    ])
  })

  it('plans a linked-note rename as one move plus one rewritten-note update', () => {
    const state: CloudSyncState = {
      version: 1,
      vault_id: 'vault-1',
      cursor: 8,
      items: {
        target: {
          item_id: 'target',
          path: 'inbox/Untitled.md',
          kind: 'text',
          revision: 3,
          sha256: 'hash:# Untitled',
          byte_length: 10,
          media_type: 'text/markdown'
        },
        daily: {
          item_id: 'daily',
          path: 'inbox/Daily.md',
          kind: 'text',
          revision: 5,
          sha256: 'hash:See [[Untitled]]',
          byte_length: 16,
          media_type: 'text/markdown'
        }
      }
    }

    const plan = planCloudSyncMutations(
      state,
      [
        { path: 'inbox/Groceries.md', kind: 'text', content: content('# Untitled') },
        { path: 'inbox/Daily.md', kind: 'text', content: content('See [[Groceries]]') }
      ],
      ids()
    )

    expect(plan.mutations).toHaveLength(2)
    expect(plan.mutations).toContainEqual(
      expect.objectContaining({
        type: 'move',
        item_id: 'target',
        base_revision: 3,
        path: 'inbox/Groceries.md'
      })
    )
    expect(plan.mutations).toContainEqual(
      expect.objectContaining({
        type: 'upsert',
        item_id: 'daily',
        base_revision: 5,
        path: 'inbox/Daily.md',
        content: expect.objectContaining({ sha256: 'hash:See [[Groceries]]' })
      })
    )
  })

  it('turns a removed tracked file into a tombstone mutation', () => {
    expect(planCloudSyncMutations(trackedState(), [], ids()).mutations).toEqual([
      expect.objectContaining({
        type: 'delete',
        item_id: 'item-existing',
        base_revision: 2
      })
    ])
  })

  it('ignores local-only files and rejects case-insensitive collisions', () => {
    expect(
      planCloudSyncMutations(
        emptyCloudSyncState('vault-1'),
        [{ path: '.zennotes/sync/state.json', kind: 'text', content: content('local') }],
        ids()
      ).mutations
    ).toEqual([])

    expect(() =>
      planCloudSyncMutations(
        emptyCloudSyncState('vault-1'),
        [
          { path: 'Notes/Plan.md', kind: 'text', content: content('one') },
          { path: 'notes/plan.md', kind: 'text', content: content('two') }
        ],
        ids()
      )
    ).toThrow('portable path collision')
  })
})

describe('resolveCloudSyncMutations', () => {
  it('commits acknowledgements while leaving conflicts dirty', () => {
    const plan = planCloudSyncMutations(
      trackedState(),
      [
        { path: 'notes/existing.md', kind: 'text', content: content('edited') },
        { path: 'notes/new.md', kind: 'text', content: content('new') }
      ],
      ids()
    )
    const response: CloudSyncMutationResponse = {
      acknowledged: [
        { operation_id: 'operation-1', item_id: 'item-existing', revision: 3, sequence: 5 }
      ],
      conflicts: [
        {
          operation_id: 'operation-2',
          item_id: 'item-1',
          code: 'PATH_CONFLICT',
          current_revision: 1,
          current_path: 'notes/new.md'
        }
      ],
      cursor: 5
    }

    const resolution = resolveCloudSyncMutations(trackedState(), plan, response)

    expect(resolution.state.cursor).toBe(4)
    expect(resolution.state.items['item-existing']).toEqual(
      expect.objectContaining({ revision: 3, sha256: 'hash:edited' })
    )
    expect(resolution.state.items['item-1']).toBeUndefined()
    expect(resolution.conflicts).toHaveLength(1)
  })
})

describe('reduceCloudSyncChange', () => {
  it('requires contiguous changes and updates the tracked cursor', () => {
    const state = emptyCloudSyncState('vault-1')
    const next = reduceCloudSyncChange(state, {
      sequence: 1,
      item_id: 'item-remote',
      type: 'upsert',
      path: 'remote.md',
      previous_path: null,
      revision: 1,
      content: content('remote')
    })

    expect(next.cursor).toBe(1)
    expect(next.items['item-remote']).toEqual(
      expect.objectContaining({ path: 'remote.md', revision: 1, sha256: 'hash:remote' })
    )
    expect(() =>
      reduceCloudSyncChange(next, {
        sequence: 3,
        item_id: 'item-remote',
        type: 'delete',
        path: 'remote.md',
        previous_path: null,
        revision: 2
      })
    ).toThrow('Expected sync sequence 2')
  })
})
