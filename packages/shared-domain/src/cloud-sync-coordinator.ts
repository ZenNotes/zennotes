import type {
  CloudSyncChange,
  CloudSyncBootstrapConflict,
  CloudSyncConflict,
  CloudSyncLocalConflict,
  CloudSyncManifestItem,
  CloudSyncManifestResponse,
  CloudSyncMutation,
  CloudSyncMutationRequest,
  CloudSyncMutationResponse
} from '@zennotes/bridge-contract/cloud-sync'
import { cloudSyncPathKey, isCloudSyncVaultSettingsPath } from './cloud-sync'
import {
  emptyCloudSyncState,
  planCloudSyncMutations,
  reduceCloudSyncChange,
  resolveCloudSyncMutations,
  type CloudSyncIdSource,
  type CloudSyncLocalItem,
  type CloudSyncState,
  type CloudSyncTrackedItem
} from './cloud-sync-engine'

const MUTATION_BATCH_SIZE = 100
const MANIFEST_PAGE_SIZE = 250
const CHANGE_PAGE_SIZE = 250
const MANIFEST_RETRIES = 3

export interface CloudSyncRemote {
  manifest(
    vaultId: string,
    options: { includeContent?: boolean; page?: number; perPage?: number }
  ): Promise<CloudSyncManifestResponse>
  changes(vaultId: string, after: number, limit?: number): Promise<{
    data: CloudSyncChange[]
    cursor: number
    has_more: boolean
  }>
  mutate(vaultId: string, body: CloudSyncMutationRequest): Promise<CloudSyncMutationResponse>
}

export interface CloudSyncRepository {
  scan(): Promise<CloudSyncLocalItem[]>
  /** Paths with a durable user decision still pending. The coordinator leaves
   *  both their tracked and local versions out of mutation planning until the
   *  host removes the pending marker. */
  pendingConflictPaths?(): Promise<string[]>
  /** Returns a conflict when the local file was kept instead of being
   *  replaced, so one unapplied change reports itself rather than stopping
   *  the run. Sync must always be able to move past a single file. */
  apply(
    change: CloudSyncChange,
    previous: CloudSyncTrackedItem | undefined
  ): Promise<CloudSyncLocalConflict | void>
}

export interface CloudSyncStateStore {
  load(vaultId: string): Promise<CloudSyncState | null>
  save(state: CloudSyncState): Promise<void>
}

export interface CloudSyncRunResult {
  state: CloudSyncState
  pulled: number
  pushed: number
  conflicts: CloudSyncConflict[]
  bootstrapConflicts: CloudSyncBootstrapConflict[]
  localConflicts: CloudSyncLocalConflict[]
}

/**
 * One offline-first sync run. The coordinator owns ordering and crash-safe
 * cursor updates; hosts only provide filesystem and state persistence.
 */
export class CloudSyncCoordinator {
  private running: Promise<CloudSyncRunResult> | null = null

  constructor(
    private readonly vaultId: string,
    private readonly remote: CloudSyncRemote,
    private readonly repository: CloudSyncRepository,
    private readonly states: CloudSyncStateStore,
    private readonly ids: CloudSyncIdSource
  ) {}

  sync(): Promise<CloudSyncRunResult> {
    if (this.running) return this.running

    this.running = this.run().finally(() => {
      this.running = null
    })

    return this.running
  }

  private async run(): Promise<CloudSyncRunResult> {
    const bootstrap = await this.loadOrBootstrap()
    if (bootstrap.conflicts.length > 0) {
      return {
        state: bootstrap.state,
        pulled: bootstrap.pulled,
        pushed: 0,
        conflicts: [],
        bootstrapConflicts: bootstrap.conflicts,
        localConflicts: bootstrap.localConflicts
      }
    }

    let state = bootstrap.state
    let pulled = bootstrap.pulled
    const localConflicts = [...bootstrap.localConflicts]
    const initialPull = await this.pullChanges(state)
    state = initialPull.state
    pulled += initialPull.pulled
    localConflicts.push(...initialPull.localConflicts)

    const localItems = await this.repository.scan()
    const pendingPathKeys = new Set(
      (await this.repository.pendingConflictPaths?.() ?? []).map(cloudSyncPathKey)
    )
    const mutationState =
      pendingPathKeys.size === 0
        ? state
        : {
            ...state,
            items: Object.fromEntries(
              Object.entries(state.items).filter(
                ([, item]) => !pendingPathKeys.has(cloudSyncPathKey(item.path))
              )
            )
          }
    const mutationItems = localItems.filter(
      (item) => !pendingPathKeys.has(cloudSyncPathKey(item.path))
    )
    const plan = planCloudSyncMutations(mutationState, mutationItems, this.ids)
    const conflicts: CloudSyncConflict[] = []
    const acknowledgedSequences = new Set<number>()
    let mutationCursor = state.cursor
    let pushed = 0

    for (const batch of mutationBatches(plan.mutations)) {
      const response = await this.remote.mutate(this.vaultId, batch)
      const before = state
      const resolution = resolveCloudSyncMutations(state, batch, response)
      state = resolution.state
      pushed += response.acknowledged.length
      // The server names rejected operations by id; the file they were about
      // is only known here. Attach it so the user can be told which file
      // needs attention instead of how many.
      const byOperation = new Map(batch.mutations.map((mutation) => [mutation.operation_id, mutation]))
      conflicts.push(
        ...resolution.conflicts.map((conflict) => ({
          ...conflict,
          path: conflictPath(conflict, byOperation.get(conflict.operation_id), before)
        }))
      )
      mutationCursor = Math.max(mutationCursor, response.cursor)
      for (const acknowledgement of response.acknowledged) {
        acknowledgedSequences.add(acknowledgement.sequence)
      }
      await this.states.save(state)
    }

    if (mutationCursor > state.cursor) {
      const finalPull = await this.pullChanges(state, acknowledgedSequences)
      state = finalPull.state
      pulled += finalPull.pulled
      localConflicts.push(...finalPull.localConflicts)
    }

    return { state, pulled, pushed, conflicts, bootstrapConflicts: [], localConflicts }
  }

  private async pullChanges(
    initialState: CloudSyncState,
    acknowledgedSequences: ReadonlySet<number> = new Set()
  ): Promise<{ state: CloudSyncState; pulled: number; localConflicts: CloudSyncLocalConflict[] }> {
    let state = initialState
    let pulled = 0
    const localConflicts: CloudSyncLocalConflict[] = []
    const changes: CloudSyncChange[] = []
    let after = state.cursor

    for (;;) {
      const response = await this.remote.changes(this.vaultId, after, CHANGE_PAGE_SIZE)
      changes.push(...response.data)
      const last = response.data.at(-1)
      if (last) after = last.sequence

      if (!response.has_more) break
      if (response.data.length === 0) {
        throw new Error('Cloud sync change feed reported another page without returning a change')
      }
    }

    // A client that catches up after another device created and filled a note
    // can receive every saved revision of that file. Applying each historical
    // body turns stale intermediate bytes into numbered conflict copies even
    // when both devices already agree on the final body. Skip an upsert when
    // the next change for that item is another upsert at the same path. Moves
    // and deletes still run because later content changes depend on their
    // filesystem effects. Every change is reduced so cursor and tracked state
    // remain exact (#661).
    const supersededUpserts = new Set<number>()
    const nextChangeByItem = new Map<string, CloudSyncChange>()
    for (let index = changes.length - 1; index >= 0; index -= 1) {
      const change = changes[index]
      const next = nextChangeByItem.get(change.item_id)
      if (change.type === 'upsert' && next?.type === 'upsert' && next.path === change.path) {
        supersededUpserts.add(change.sequence)
      }
      nextChangeByItem.set(change.item_id, change)
    }

    // `previous` tells the repository what it last wrote for an item, which is
    // how it vouches for the local file before replacing it. A coalesced
    // upsert is reduced into `state` (cursor and revision stay exact) but is
    // never written, so from then on the live state describes the server's
    // history rather than this device's file. Handing that to `apply` made a
    // device that had touched nothing park every multi-revision catch-up as a
    // conflict copy, then re-upload its stale bytes over the revision it had
    // just received. Remember what was on disk before the first skipped
    // revision and give the change that finally lands that instead.
    const onDisk = new Map<string, CloudSyncTrackedItem | undefined>()
    for (const change of changes) {
      const acknowledged = acknowledgedSequences.has(change.sequence)
      if (acknowledged) {
        // This device's own push: the file already holds these bytes.
        onDisk.delete(change.item_id)
      } else if (supersededUpserts.has(change.sequence)) {
        if (!onDisk.has(change.item_id)) onDisk.set(change.item_id, state.items[change.item_id])
        pulled++
      } else {
        const previous = onDisk.has(change.item_id)
          ? onDisk.get(change.item_id)
          : state.items[change.item_id]
        onDisk.delete(change.item_id)
        const conflict = await this.repository.apply(change, previous)
        if (conflict) localConflicts.push(conflict)
        pulled++
      }
      state = reduceCloudSyncChange(state, change)
    }
    if (changes.length > 0) await this.states.save(state)

    return { state, pulled, localConflicts }
  }

  private async loadOrBootstrap(): Promise<{
    state: CloudSyncState
    pulled: number
    conflicts: CloudSyncBootstrapConflict[]
    localConflicts: CloudSyncLocalConflict[]
  }> {
    const existing = await this.states.load(this.vaultId)
    if (existing) return { state: existing, pulled: 0, conflicts: [], localConflicts: [] }

    const manifest = await this.stableManifest()
    const localItems = await this.repository.scan()
    const localByPath = new Map(localItems.map((item) => [cloudSyncPathKey(item.path), item]))
    const conflicts: CloudSyncBootstrapConflict[] = []
    const localConflicts: CloudSyncLocalConflict[] = []
    let pulled = 0

    for (const item of manifest.items) {
      const local = localByPath.get(cloudSyncPathKey(item.path))
      if (local && local.content.sha256 !== item.sha256) {
        if (isCloudSyncVaultSettingsPath(item.path)) {
          if (!item.content) throw new Error(`Manifest item ${item.item_id} did not include content`)
          const conflict = await this.repository.apply(manifestUpsert(item), undefined)
          if (conflict) localConflicts.push(conflict)
          pulled++
          continue
        }
        conflicts.push({
          code: 'BOOTSTRAP_CONTENT_CONFLICT',
          item_id: item.item_id,
          path: item.path,
          local_sha256: local.content.sha256,
          remote_sha256: item.sha256
        })
        continue
      }

      if (!local) {
        if (!item.content) throw new Error(`Manifest item ${item.item_id} did not include content`)
        const conflict = await this.repository.apply(manifestUpsert(item), undefined)
        if (conflict) localConflicts.push(conflict)
        pulled++
      }
    }

    const state = manifestState(this.vaultId, manifest.cursor, manifest.items)
    if (conflicts.length === 0) await this.states.save(state)

    return { state, pulled, conflicts, localConflicts }
  }

  private async stableManifest(): Promise<{
    cursor: number
    items: CloudSyncManifestItem[]
  }> {
    for (let attempt = 0; attempt < MANIFEST_RETRIES; attempt++) {
      const items: CloudSyncManifestItem[] = []
      let page = 1
      let cursor: number | null = null
      let stable = true

      for (;;) {
        const response = await this.remote.manifest(this.vaultId, {
          includeContent: true,
          page,
          perPage: MANIFEST_PAGE_SIZE
        })
        cursor ??= response.cursor

        if (cursor !== response.cursor) {
          stable = false
          break
        }

        items.push(...response.data)
        if (response.next_page === null) break
        page = response.next_page
      }

      if (stable && cursor !== null) return { cursor, items }
    }

    throw new Error('Vault changed repeatedly while the initial sync manifest was loading')
  }
}

/** The local path a rejected mutation was about: the path it sent, or for a
 *  delete the path the item had on this device before the run. */
function conflictPath(
  conflict: CloudSyncConflict,
  mutation: CloudSyncMutation | undefined,
  state: CloudSyncState
): string | null {
  if (mutation && mutation.type !== 'delete') return mutation.path
  return state.items[conflict.item_id]?.path ?? conflict.current_path ?? null
}

function mutationBatches(mutations: CloudSyncMutation[]): CloudSyncMutationRequest[] {
  const batches: CloudSyncMutationRequest[] = []
  let batch: CloudSyncMutation[] = []

  const flush = (): void => {
    if (batch.length === 0) return
    batches.push({ mutations: batch })
    batch = []
  }

  for (const mutation of mutations) {
    // The cloud server persists non-UTF-8 payloads to object storage serially.
    // Isolating each one keeps several assets from exhausting one request's
    // timeout and rolling back the whole batch before progress is checkpointed.
    const usesObjectStorage =
      mutation.type === 'upsert' && mutation.content.encoding !== 'utf8'

    if (usesObjectStorage) {
      flush()
      batches.push({ mutations: [mutation] })
      continue
    }

    batch.push(mutation)
    if (batch.length === MUTATION_BATCH_SIZE) flush()
  }

  flush()
  return batches
}

function manifestState(
  vaultId: string,
  cursor: number,
  items: CloudSyncManifestItem[]
): CloudSyncState {
  const state = emptyCloudSyncState(vaultId)
  state.cursor = cursor

  for (const item of items) {
    state.items[item.item_id] = {
      item_id: item.item_id,
      path: item.path,
      kind: item.kind,
      revision: item.revision,
      sha256: item.sha256,
      byte_length: item.byte_length,
      media_type: item.media_type
    }
  }

  return state
}

function manifestUpsert(item: CloudSyncManifestItem): CloudSyncChange {
  return {
    sequence: 0,
    item_id: item.item_id,
    type: 'upsert',
    path: item.path,
    previous_path: null,
    revision: item.revision,
    content: item.content
  }
}
