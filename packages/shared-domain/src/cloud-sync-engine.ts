import type {
  CloudSyncChange,
  CloudSyncContent,
  CloudSyncItemKind,
  CloudSyncMutation,
  CloudSyncMutationResponse
} from '@zennotes/bridge-contract/cloud-sync'
import { cloudSyncPathKey, normalizeCloudSyncPath, shouldSyncVaultPath } from './cloud-sync'

export interface CloudSyncLocalItem {
  path: string
  kind: CloudSyncItemKind
  content: CloudSyncContent
}

export interface CloudSyncTrackedItem {
  item_id: string
  path: string
  kind: CloudSyncItemKind
  revision: number
  sha256: string
  byte_length: number
  media_type: string
}

export interface CloudSyncConflictSnapshot {
  path: string | null
  revision: number | null
  kind: CloudSyncItemKind
  content: CloudSyncContent | null
}

export interface CloudSyncStoredConflict {
  id: string
  item_id: string
  kind: 'content' | 'delete' | 'move' | 'path'
  sequence: number
  base: CloudSyncConflictSnapshot
  local: CloudSyncConflictSnapshot
  cloud: CloudSyncConflictSnapshot
  draft_text?: string
  /** Additional paths involved in a rejected rename/path race. */
  paused_paths?: string[]
}

export interface CloudSyncState {
  version: 1
  vault_id: string
  cursor: number
  items: Record<string, CloudSyncTrackedItem>
  /** Optional for backward compatibility with state written before v2.44. */
  pending_conflicts?: Record<string, CloudSyncStoredConflict>
}

export interface CloudSyncIdSource {
  itemId(): string
  operationId(): string
}

export interface CloudSyncMutationPlan {
  mutations: CloudSyncMutation[]
}

export interface CloudSyncMutationResolution {
  state: CloudSyncState
  conflicts: CloudSyncMutationResponse['conflicts']
}

export function emptyCloudSyncState(vaultId: string): CloudSyncState {
  return { version: 1, vault_id: vaultId, cursor: 0, items: {} }
}

/**
 * Compare a stable acknowledged state with the current vault scan. Nothing in
 * this function touches disk or the network, so desktop and both Capacitor
 * apps use exactly the same identity, move-detection, and retry semantics.
 */
export function planCloudSyncMutations(
  state: CloudSyncState,
  localItems: CloudSyncLocalItem[],
  ids: CloudSyncIdSource
): CloudSyncMutationPlan {
  const localByPathKey = new Map<string, CloudSyncLocalItem>()

  for (const localItem of localItems) {
    if (!shouldSyncVaultPath(localItem.path)) continue

    const normalizedItem = {
      ...localItem,
      path: normalizeCloudSyncPath(localItem.path)
    }
    const key = cloudSyncPathKey(normalizedItem.path)
    if (localByPathKey.has(key)) {
      throw new Error(`Vault contains a portable path collision at ${normalizedItem.path}`)
    }
    localByPathKey.set(key, normalizedItem)
  }

  const mutations: CloudSyncMutation[] = []
  const unmatchedLocalItems = new Set(localByPathKey.values())
  const trackedItems = Object.values(state.items).sort((left, right) =>
    left.path.localeCompare(right.path)
  )

  for (const trackedItem of trackedItems) {
    const exactLocalItem = localByPathKey.get(cloudSyncPathKey(trackedItem.path))
    if (exactLocalItem) {
      unmatchedLocalItems.delete(exactLocalItem)

      if (exactLocalItem.content.sha256 !== trackedItem.sha256) {
        mutations.push({
          type: 'upsert',
          operation_id: ids.operationId(),
          item_id: trackedItem.item_id,
          base_revision: trackedItem.revision,
          path: exactLocalItem.path,
          kind: exactLocalItem.kind,
          content: exactLocalItem.content
        })
      } else if (exactLocalItem.path !== trackedItem.path) {
        mutations.push({
          type: 'move',
          operation_id: ids.operationId(),
          item_id: trackedItem.item_id,
          base_revision: trackedItem.revision,
          path: exactLocalItem.path
        })
      }

      continue
    }

    const moveCandidates = [...unmatchedLocalItems].filter(
      (localItem) =>
        localItem.kind === trackedItem.kind && localItem.content.sha256 === trackedItem.sha256
    )

    if (moveCandidates.length === 1) {
      const movedItem = moveCandidates[0]
      unmatchedLocalItems.delete(movedItem)
      mutations.push({
        type: 'move',
        operation_id: ids.operationId(),
        item_id: trackedItem.item_id,
        base_revision: trackedItem.revision,
        path: movedItem.path
      })
    } else {
      mutations.push({
        type: 'delete',
        operation_id: ids.operationId(),
        item_id: trackedItem.item_id,
        base_revision: trackedItem.revision
      })
    }
  }

  for (const localItem of [...unmatchedLocalItems].sort((left, right) =>
    left.path.localeCompare(right.path)
  )) {
    mutations.push({
      type: 'upsert',
      operation_id: ids.operationId(),
      item_id: ids.itemId(),
      base_revision: null,
      path: localItem.path,
      kind: localItem.kind,
      content: localItem.content
    })
  }

  return { mutations }
}

/** Commit only server-acknowledged operations; conflicts remain locally dirty. */
export function resolveCloudSyncMutations(
  state: CloudSyncState,
  plan: CloudSyncMutationPlan,
  response: CloudSyncMutationResponse
): CloudSyncMutationResolution {
  const nextState: CloudSyncState = {
    ...state,
    // A mutation response can include unseen changes from another device.
    // The pull cursor only advances while reducing contiguous change-feed rows.
    cursor: state.cursor,
    items: { ...state.items }
  }
  const mutationByOperation = new Map(
    plan.mutations.map((mutation) => [mutation.operation_id, mutation])
  )

  for (const acknowledgement of response.acknowledged) {
    const mutation = mutationByOperation.get(acknowledgement.operation_id)
    if (!mutation || mutation.item_id !== acknowledgement.item_id) {
      throw new Error(
        `Server acknowledged an unknown sync operation ${acknowledgement.operation_id}`
      )
    }

    if (mutation.type === 'delete') {
      delete nextState.items[mutation.item_id]
      continue
    }

    const previousItem = nextState.items[mutation.item_id]
    if (mutation.type === 'move') {
      if (!previousItem) {
        throw new Error(`Server acknowledged a move for unknown item ${mutation.item_id}`)
      }
      nextState.items[mutation.item_id] = {
        ...previousItem,
        path: mutation.path,
        revision: acknowledgement.revision
      }
      continue
    }

    nextState.items[mutation.item_id] = {
      item_id: mutation.item_id,
      path: mutation.path,
      kind: mutation.kind,
      revision: acknowledgement.revision,
      sha256: mutation.content.sha256,
      byte_length: mutation.content.byte_length,
      media_type: mutation.content.media_type
    }
  }

  return { state: nextState, conflicts: response.conflicts }
}

/** Reduce one already-applied remote change into the durable client cursor state. */
export function reduceCloudSyncChange(
  state: CloudSyncState,
  change: CloudSyncChange
): CloudSyncState {
  if (change.sequence <= state.cursor) return state
  if (change.sequence !== state.cursor + 1) {
    throw new Error(`Expected sync sequence ${state.cursor + 1}, received ${change.sequence}`)
  }

  const items = { ...state.items }
  if (change.type === 'delete') {
    delete items[change.item_id]
  } else if (change.type === 'move') {
    const previousItem = items[change.item_id]
    if (!previousItem) throw new Error(`Received a move for unknown item ${change.item_id}`)
    items[change.item_id] = {
      ...previousItem,
      path: change.path,
      revision: change.revision
    }
  } else {
    if (!change.content) throw new Error(`Upsert change ${change.sequence} did not include content`)
    items[change.item_id] = {
      item_id: change.item_id,
      path: change.path,
      kind: items[change.item_id]?.kind ?? inferItemKind(change.content),
      revision: change.revision,
      sha256: change.content.sha256,
      byte_length: change.content.byte_length,
      media_type: change.content.media_type
    }
  }

  return { ...state, cursor: change.sequence, items }
}

function inferItemKind(content: CloudSyncContent): CloudSyncItemKind {
  return content.encoding === 'utf8' ? 'text' : 'binary'
}
