import type {
  CloudSyncChange,
  CloudSyncBootstrapConflict,
  CloudSyncBootstrapConflictDetails,
  CloudSyncBootstrapConflictResolution,
  CloudSyncConflict,
  CloudSyncContent,
  CloudSyncLocalConflict,
  CloudSyncManifestItem,
  CloudSyncManifestResponse,
  CloudSyncMutation,
  CloudSyncMutationRequest,
  CloudSyncMutationResponse,
  CloudSyncPendingConflict,
  CloudSyncPendingConflictDetails,
  CloudSyncPendingConflictResolution,
  CloudSyncRevisionResponse
} from '@zennotes/bridge-contract/cloud-sync'
import {
  cloudSyncLegacyConflictOriginalPath,
  cloudSyncPathKey,
  isCloudSyncVaultSettingsPath,
  normalizeCloudSyncPath,
  shouldSyncVaultPath
} from './cloud-sync'
import {
  emptyCloudSyncState,
  planCloudSyncMutations,
  reduceCloudSyncChange,
  resolveCloudSyncMutations,
  type CloudSyncIdSource,
  type CloudSyncLocalItem,
  type CloudSyncState,
  type CloudSyncStoredConflict,
  type CloudSyncTrackedItem
} from './cloud-sync-engine'
import { mergeCloudSyncText, resolveCloudSyncMerge } from './cloud-sync-merge'

const MUTATION_BATCH_SIZE = 100
const MANIFEST_PAGE_SIZE = 250
const CHANGE_PAGE_SIZE = 250
const MANIFEST_RETRIES = 3
const CONFLICT_PREVIEW_LIMIT_BYTES = 256 * 1024
/** Conflict snapshots above this size keep only their metadata in state. The
 * local bytes stay on disk untouched while the decision waits, and the Cloud
 * bytes are fetched again, hash-checked, when a decision needs them. */
const CONFLICT_SNAPSHOT_INLINE_LIMIT_BYTES = CONFLICT_PREVIEW_LIMIT_BYTES

export interface CloudSyncRemote {
  manifest(
    vaultId: string,
    options: { includeContent?: boolean; page?: number; perPage?: number }
  ): Promise<CloudSyncManifestResponse>
  changes(
    vaultId: string,
    after: number,
    limit?: number
  ): Promise<{
    data: CloudSyncChange[]
    cursor: number
    has_more: boolean
  }>
  mutate(vaultId: string, body: CloudSyncMutationRequest): Promise<CloudSyncMutationResponse>
  revision?(vaultId: string, itemId: string, revision: number): Promise<CloudSyncRevisionResponse>
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
  ): Promise<CloudSyncRepositoryConflict | void>
  replaceConflictFile?(input: {
    path: string
    expectedSha256: string | null
    content: CloudSyncContent | null
  }): Promise<void>
  /** Materialize the complete local result of a decision without overwriting
   * an unrelated destination. The expected file is removed only after all
   * replacement files have been written successfully. */
  applyConflictResolutionFiles?(input: {
    expected_path: string | null
    expected_sha256: string | null
    files: Array<{
      path: string
      content: CloudSyncContent
    }>
  }): Promise<void>
  /** Apply the local filesystem half of an explicit first-sync decision. */
  resolveBootstrapConflict?(input: {
    path: string
    expectedLocalSha256: string
    cloudContent: CloudSyncContent
    resolution: CloudSyncBootstrapConflictResolution
  }): Promise<void>
}

export interface CloudSyncRepositoryConflict extends CloudSyncLocalConflict {
  local?: CloudSyncLocalItem | null
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
  pendingConflicts: CloudSyncPendingConflict[]
  legacyConflictCopies: Array<{ path: string; original_path: string }>
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

  async getConflict(conflictId: string): Promise<CloudSyncPendingConflictDetails> {
    const state = await this.requireState()
    const stored = state.pending_conflicts?.[conflictId]
    if (!stored) throw new Error('This conflict is no longer waiting for a decision.')
    const current = await this.currentLocalSnapshot(stored)
    const conflict = { ...stored, local: current }
    const merge = conflictTextMerge(conflict)
    return {
      conflict: pendingConflictSummary(conflict),
      base: publicConflictVersion(conflict.base, 'base'),
      local: publicConflictVersion(conflict.local, 'local'),
      cloud: publicConflictVersion(conflict.cloud, 'cloud'),
      suggested_text: merge?.text ?? null,
      draft_text: conflict.draft_text ?? null,
      changes: merge?.conflicts ?? [],
      parts:
        merge?.parts.map((part) =>
          part.type === 'text'
            ? { type: 'text' as const, text: part.text }
            : { type: 'change' as const, change_id: part.conflict.id }
        ) ?? []
    }
  }

  async saveConflictDraft(conflictId: string, draftText: string | null): Promise<void> {
    const state = await this.requireState()
    const conflict = state.pending_conflicts?.[conflictId]
    if (!conflict) throw new Error('This conflict is no longer waiting for a decision.')
    const pending = { ...state.pending_conflicts }
    pending[conflictId] = {
      ...conflict,
      ...(draftText === null ? { draft_text: undefined } : { draft_text: draftText })
    }
    await this.states.save({ ...state, pending_conflicts: pending })
  }

  async resolveConflict(resolution: CloudSyncPendingConflictResolution): Promise<void> {
    if (!['local', 'cloud', 'both', 'merged', 'changes'].includes(resolution.choice)) {
      throw new Error('That conflict resolution choice is not valid.')
    }
    const state = await this.requireState()
    const stored = state.pending_conflicts?.[resolution.conflict_id]
    if (!stored) throw new Error('This conflict is no longer waiting for a decision.')
    const local = await this.currentLocalSnapshot(stored)
    if ((local.content?.sha256 ?? null) !== resolution.expected_local_sha256) {
      throw new Error(
        'This note changed on this device. Review the latest changes before continuing.'
      )
    }
    if (stored.cloud.revision !== resolution.expected_cloud_revision) {
      throw new Error('The Cloud version changed. Sync again before choosing a version.')
    }
    const manifest = await this.stableManifest()
    assertCloudSnapshotIsCurrent(stored, manifest)

    if (resolution.choice === 'cloud') {
      await this.applyCloudChoice(await this.withCloudBytes(stored, manifest), local)
      await this.saveWithoutConflict(state, stored.id)
      return
    }

    if (resolution.choice === 'both') {
      await this.applyKeepBothChoice(
        await this.withCloudBytes(stored, manifest),
        local,
        resolution.keep_both_path
      )
      await this.saveWithoutConflict(state, stored.id)
      return
    }

    let chosen = local.content
    if (resolution.choice === 'merged') {
      if (typeof resolution.merged_text !== 'string') {
        throw new Error('Review the combined note before saving it.')
      }
      chosen = await textContent(
        resolution.merged_text,
        local.content?.media_type ?? stored.cloud.content?.media_type ?? 'text/markdown'
      )
    } else if (resolution.choice === 'changes') {
      const merge = conflictTextMerge({ ...stored, local })
      if (!merge) throw new Error('This file cannot be combined as text.')
      chosen = await textContent(
        resolveCloudSyncMerge(merge, resolution.change_choices ?? {}),
        local.content?.media_type ?? stored.cloud.content?.media_type ?? 'text/markdown'
      )
    }

    const selectedPath =
      resolution.resolved_path ?? local.path ?? stored.cloud.path ?? stored.base.path
    const resolvedPath = chosen && selectedPath ? normalizeCloudSyncPath(selectedPath) : selectedPath
    if (chosen && (!resolvedPath || !shouldSyncVaultPath(resolvedPath))) {
      throw new Error('Choose a filename inside the synced vault.')
    }

    const operationId = this.ids.operationId()
    const mutation: CloudSyncMutation = chosen
      ? {
          type: 'upsert',
          operation_id: operationId,
          item_id: stored.item_id,
          base_revision: stored.cloud.revision,
          path: resolvedPath ?? '',
          kind: local.kind,
          content: chosen
        }
      : {
          type: 'delete',
          operation_id: operationId,
          item_id: stored.item_id,
          base_revision: stored.cloud.revision
        }
    if (mutation.type !== 'delete' && !mutation.path) {
      throw new Error('The resolved file path is no longer available.')
    }
    const request = { mutations: [mutation] }
    const response = await this.remote.mutate(this.vaultId, request)
    const conflict = response.conflicts.find((item) => item.operation_id === operationId)
    if (conflict) {
      throw new Error(
        'The Cloud version changed while saving. Sync again to review the latest changes.'
      )
    }
    if (!response.acknowledged.some((item) => item.operation_id === operationId)) {
      throw new Error('Cloud did not confirm the resolution. Try again.')
    }

    // Save to Cloud first. If the request fails, the file the user is looking
    // at remains untouched and the decision stays queued for a clean retry.
    // Keeping this device's version at its current path changes nothing on
    // disk, and a scan snapshot of a large file carries no bytes to rewrite
    // it with, so that decision never touches the file.
    const fileAlreadyChosen =
      resolution.choice === 'local' &&
      local.path !== null &&
      typeof resolvedPath === 'string' &&
      cloudSyncPathKey(resolvedPath) === cloudSyncPathKey(local.path)
    if (!fileAlreadyChosen && this.repository.applyConflictResolutionFiles) {
      await this.repository.applyConflictResolutionFiles({
        expected_path: local.path,
        expected_sha256: local.content?.sha256 ?? null,
        files: chosen && resolvedPath ? [{ path: resolvedPath, content: chosen }] : []
      })
    } else if (!fileAlreadyChosen && local.path && this.repository.replaceConflictFile) {
      await this.repository.replaceConflictFile({
        path: local.path,
        expectedSha256: local.content?.sha256 ?? null,
        content: chosen
      })
    }
    const withoutPending = withoutConflict(state, stored.id)
    await this.states.save(resolveCloudSyncMutations(withoutPending, request, response).state)
  }

  async getBootstrapConflict(
    conflict: CloudSyncBootstrapConflict
  ): Promise<CloudSyncBootstrapConflictDetails> {
    const current = await this.currentBootstrapConflict(conflict)
    return {
      conflict,
      kind: current.item.kind,
      local: conflictVersion(current.local.content),
      cloud: conflictVersion(current.item.content)
    }
  }

  async resolveBootstrapConflict(resolution: CloudSyncBootstrapConflictResolution): Promise<void> {
    if (!['local', 'cloud', 'both', 'merged'].includes(resolution.choice)) {
      throw new Error('That Cloud conflict resolution choice is not valid.')
    }
    if (resolution.choice === 'both' && typeof resolution.keep_both_path !== 'string') {
      throw new Error('Choose a filename for this device’s version.')
    }
    if (resolution.choice === 'merged' && typeof resolution.merged_text !== 'string') {
      throw new Error('Enter the merged text before resolving this conflict.')
    }

    const current = await this.currentBootstrapConflict(resolution.conflict)
    if (resolution.choice !== 'local') {
      if (!this.repository.resolveBootstrapConflict) {
        throw new Error('This device cannot resolve Cloud file conflicts yet.')
      }
      await this.repository.resolveBootstrapConflict({
        path: current.item.path,
        expectedLocalSha256: current.local.content.sha256,
        cloudContent: current.item.content,
        resolution
      })
    }

    if (resolution.choice === 'local' || resolution.choice === 'merged') {
      const chosen =
        resolution.choice === 'local'
          ? current.local
          : (await this.repository.scan()).find(
              (candidate) =>
                cloudSyncPathKey(candidate.path) === cloudSyncPathKey(current.item.path)
            )
      if (!chosen) {
        throw new Error('The resolved file is no longer available on this device.')
      }

      const operationId = this.ids.operationId()
      const response = await this.remote.mutate(this.vaultId, {
        mutations: [
          {
            type: 'upsert',
            operation_id: operationId,
            item_id: current.item.item_id,
            base_revision: current.item.revision,
            path: current.item.path,
            kind: chosen.kind,
            content: chosen.content
          }
        ]
      })
      const conflict = response.conflicts.find((item) => item.operation_id === operationId)
      if (conflict) {
        throw new Error(
          `Cloud changed while resolving this file (${conflict.code}). Sync again to compare the latest versions.`
        )
      }
      if (!response.acknowledged.some((item) => item.operation_id === operationId)) {
        throw new Error('Cloud did not confirm the conflict resolution. Try again.')
      }
    }
    // Do not initialize state here. The follow-up sync must still pull other
    // Cloud-only files and report any other first-sync conflicts.
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
        localConflicts: bootstrap.localConflicts,
        pendingConflicts: pendingConflictSummaries(bootstrap.state),
        legacyConflictCopies: []
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
    const pendingPathKeys = new Set([
      ...((await this.repository.pendingConflictPaths?.()) ?? []).map(cloudSyncPathKey),
      ...pendingConflictPaths(state).map(cloudSyncPathKey)
    ])
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
    const pausedPathsByKey = new Map<string, Set<string>>()
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
      const byOperation = new Map(
        batch.mutations.map((mutation) => [mutation.operation_id, mutation])
      )
      const annotatedConflicts = resolution.conflicts.map((conflict) => ({
        ...conflict,
        path: conflictPath(conflict, byOperation.get(conflict.operation_id), before)
      }))
      conflicts.push(...annotatedConflicts)
      for (const conflict of annotatedConflicts) {
        if (conflict.code !== 'PATH_CONFLICT') continue
        const mutation = byOperation.get(conflict.operation_id)
        const paths = [
          conflict.path,
          conflict.current_path,
          mutation ? before.items[mutation.item_id]?.path : null
        ].filter((path): path is string => Boolean(path))
        for (const keyPath of [conflict.path, conflict.current_path]) {
          if (!keyPath) continue
          const key = cloudSyncPathKey(keyPath)
          const values = pausedPathsByKey.get(key) ?? new Set<string>()
          paths.forEach((path) => values.add(path))
          pausedPathsByKey.set(key, values)
        }
      }
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

    if (pausedPathsByKey.size > 0) {
      state = withAdditionalPausedPaths(state, pausedPathsByKey)
      await this.states.save(state)
    }

    const reportedConflicts = conflicts.filter(
      (conflict) => isCapacityConflict(conflict) || !pendingMatchesConflict(state, conflict)
    )

    return {
      state,
      pulled,
      pushed,
      conflicts: reportedConflicts,
      bootstrapConflicts: [],
      localConflicts,
      pendingConflicts: pendingConflictSummaries(state),
      legacyConflictCopies: localItems.flatMap((item) => {
        const original = cloudSyncLegacyConflictOriginalPath(item.path)
        return original ? [{ path: item.path, original_path: original }] : []
      })
    }
  }

  private async pullChanges(
    initialState: CloudSyncState,
    acknowledgedSequences: ReadonlySet<number> = new Set()
  ): Promise<{
    state: CloudSyncState
    pulled: number
    localConflicts: CloudSyncLocalConflict[]
  }> {
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
        const existingConflict = state.pending_conflicts?.[change.item_id]
        if (existingConflict) {
          state = {
            ...state,
            pending_conflicts: {
              ...state.pending_conflicts,
              [change.item_id]: advancePendingConflict(existingConflict, change)
            }
          }
        } else {
          const conflict = await this.repository.apply(change, previous)
          if (conflict?.code === 'LOCAL_EDIT_CONFLICT') {
            const pending = await this.storedConflict(change, previous, conflict.local ?? null)
            if (!(await this.applyAutomaticMerge(pending))) {
              state = {
                ...state,
                pending_conflicts: {
                  ...state.pending_conflicts,
                  [pending.id]: pending
                }
              }
            }
          } else if (conflict) {
            localConflicts.push(publicLocalConflict(conflict))
          }
        }
        pulled++
      }
      state = reduceCloudSyncChange(state, change)
    }
    if (changes.length > 0) await this.states.save(state)

    return { state, pulled, localConflicts }
  }

  private async applyAutomaticMerge(conflict: CloudSyncStoredConflict): Promise<boolean> {
    const base = conflict.base.content
    const local = conflict.local.content
    const cloud = conflict.cloud.content
    if (
      !this.repository.replaceConflictFile ||
      conflict.local.path === null ||
      conflict.local.path !== conflict.cloud.path ||
      base?.encoding !== 'utf8' ||
      local?.encoding !== 'utf8' ||
      cloud?.encoding !== 'utf8'
    ) {
      return false
    }

    const baseText = inlineText(base)
    const localText = inlineText(local)
    const cloudText = inlineText(cloud)
    if (baseText === null || localText === null || cloudText === null) return false

    const merge = mergeCloudSyncText(baseText, localText, cloudText)
    if (merge.status !== 'clean') return false
    const merged = await textContent(merge.text, local.media_type)
    try {
      await this.repository.replaceConflictFile!({
        path: conflict.local.path,
        expectedSha256: local.sha256,
        content: merged
      })
    } catch {
      // A save landed between the pull and this write. The conflict is queued
      // so the run still finishes, and the resolver re-reads the file before
      // it offers any choice.
      return false
    }
    return true
  }

  private async storedConflict(
    change: CloudSyncChange,
    previous: CloudSyncTrackedItem | undefined,
    local: CloudSyncLocalItem | null
  ): Promise<CloudSyncStoredConflict> {
    const conflict = storedConflict(change, previous, local)
    if (previous && !conflict.base.content) {
      conflict.base.content = await this.retainedText(previous.item_id, previous.revision, {
        sha256: previous.sha256,
        byte_length: previous.byte_length,
        text: previous.kind === 'text'
      })
    }
    // A move carries no body, so its Cloud side starts as metadata. Small
    // text is fetched now so the resolver can offer a merge; anything else is
    // fetched when a decision needs the bytes.
    const cloud = conflict.cloud.content
    if (change.type === 'move' && cloud && !hasInlineData(cloud)) {
      conflict.cloud.content =
        (await this.retainedText(change.item_id, change.revision, {
          sha256: cloud.sha256,
          byte_length: cloud.byte_length,
          text: cloud.encoding === 'utf8'
        })) ?? cloud
    }
    return conflict
  }

  /** The retained body of one revision, when it is text small enough to
   * preview, the server still has it, and its hash matches. */
  private async retainedText(
    itemId: string,
    revision: number,
    expected: { sha256: string; byte_length: number; text: boolean }
  ): Promise<CloudSyncContent | null> {
    if (
      !expected.text ||
      expected.byte_length > CONFLICT_PREVIEW_LIMIT_BYTES ||
      !this.remote.revision
    ) {
      return null
    }
    try {
      const response = await this.remote.revision(this.vaultId, itemId, revision)
      const content = response.data.content
      if (content?.encoding === 'utf8' && content.sha256 === expected.sha256) return content
    } catch {
      // Retention is finite and older servers do not expose revision reads.
      // The conflict remains safely two-way instead of blocking all sync.
    }
    return null
  }

  /** A snapshot above the inline limit holds only metadata; the bytes come
   * from the manifest already fetched for the freshness check, or from the
   * retained revision, and must match the snapshot hash. */
  private async withCloudBytes(
    conflict: CloudSyncStoredConflict,
    manifest: { items: CloudSyncManifestItem[] }
  ): Promise<CloudSyncStoredConflict> {
    const snapshot = conflict.cloud.content
    if (!snapshot || hasInlineData(snapshot)) return conflict
    const matches = (content: CloudSyncContent | null | undefined): content is CloudSyncContent =>
      !!content && content.sha256 === snapshot.sha256 && hasInlineData(content)
    const item = manifest.items.find((candidate) => candidate.item_id === conflict.item_id)
    let content: CloudSyncContent | null = matches(item?.content) ? item.content : null
    if (!content && this.remote.revision && conflict.cloud.revision !== null) {
      try {
        const response = await this.remote.revision(
          this.vaultId,
          conflict.item_id,
          conflict.cloud.revision
        )
        if (matches(response.data.content)) content = response.data.content
      } catch {
        // Fall through to the error below.
      }
    }
    if (!content) {
      throw new Error(
        'The Cloud version of this file is not available right now. Sync again and retry.'
      )
    }
    return { ...conflict, cloud: { ...conflict.cloud, content } }
  }

  private async requireState(): Promise<CloudSyncState> {
    const state = await this.states.load(this.vaultId)
    if (!state) throw new Error('Sync this vault before resolving conflicts.')
    return state
  }

  private async currentLocalSnapshot(
    conflict: CloudSyncStoredConflict
  ): Promise<CloudSyncStoredConflict['local']> {
    const items = await this.repository.scan()
    const expectedPath = conflict.local.path ?? conflict.base.path
    const exact = expectedPath
      ? items.find((item) => cloudSyncPathKey(item.path) === cloudSyncPathKey(expectedPath))
      : undefined
    const moved =
      exact ??
      (conflict.local.content
        ? uniqueItemWithHash(items, conflict.local.content.sha256)
        : undefined)
    return {
      path: moved?.path ?? expectedPath ?? null,
      revision: null,
      kind: moved?.kind ?? conflict.local.kind,
      content: moved?.content ?? null
    }
  }

  private async applyCloudChoice(
    conflict: CloudSyncStoredConflict,
    local: CloudSyncStoredConflict['local']
  ): Promise<void> {
    if (!this.repository.applyConflictResolutionFiles && !this.repository.replaceConflictFile) {
      throw new Error('This device cannot resolve Cloud file conflicts yet.')
    }
    // An empty file list below means "remove the local file", which is only
    // right when Cloud deleted it. A Cloud file whose bytes are missing must
    // never be applied as a delete.
    if (conflict.cloud.path !== null && !conflict.cloud.content) {
      throw new Error(
        'The Cloud version of this file is not available right now. Sync again and retry.'
      )
    }
    if (this.repository.applyConflictResolutionFiles) {
      await this.repository.applyConflictResolutionFiles({
        expected_path: local.path,
        expected_sha256: local.content?.sha256 ?? null,
        files:
          conflict.cloud.path && conflict.cloud.content
            ? [{ path: conflict.cloud.path, content: conflict.cloud.content }]
            : []
      })
      return
    }
    const localPath = local.path ?? conflict.base.path
    if (!localPath) throw new Error('The local file path is no longer available.')
    if (conflict.cloud.path !== null && conflict.cloud.path !== localPath) {
      throw new Error('This device needs an update before it can resolve moved files.')
    }
    await this.repository.replaceConflictFile!({
      path: localPath,
      expectedSha256: local.content?.sha256 ?? null,
      content: conflict.cloud.content
    })
  }

  private async applyKeepBothChoice(
    conflict: CloudSyncStoredConflict,
    local: CloudSyncStoredConflict['local'],
    keepBothPath: string | undefined
  ): Promise<void> {
    if (!keepBothPath) throw new Error('Choose a filename for this device’s version.')
    if (!local.path || !local.content || !conflict.cloud.content || !conflict.cloud.path) {
      throw new Error('Both versions cannot be kept automatically for this kind of conflict.')
    }
    if (this.repository.applyConflictResolutionFiles) {
      await this.repository.applyConflictResolutionFiles({
        expected_path: local.path,
        expected_sha256: local.content.sha256,
        files: [
          { path: conflict.cloud.path, content: conflict.cloud.content },
          { path: keepBothPath, content: local.content }
        ]
      })
      return
    }
    if (!this.repository.resolveBootstrapConflict || conflict.cloud.path !== local.path) {
      throw new Error('This device needs an update before it can keep both moved files.')
    }
    await this.repository.resolveBootstrapConflict({
      path: local.path,
      expectedLocalSha256: local.content.sha256,
      cloudContent: conflict.cloud.content,
      resolution: {
        conflict: {
          code: 'BOOTSTRAP_CONTENT_CONFLICT',
          item_id: conflict.item_id,
          path: local.path,
          local_sha256: local.content.sha256,
          remote_sha256: conflict.cloud.content.sha256
        },
        choice: 'both',
        keep_both_path: keepBothPath
      }
    })
  }

  private async saveWithoutConflict(state: CloudSyncState, conflictId: string): Promise<void> {
    await this.states.save(withoutConflict(state, conflictId))
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
          if (!item.content)
            throw new Error(`Manifest item ${item.item_id} did not include content`)
          const conflict = await this.repository.apply(manifestUpsert(item), undefined)
          if (conflict) localConflicts.push(conflict)
          pulled++
          continue
        }
        if (!item.content) throw new Error(`Manifest item ${item.item_id} did not include content`)
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
    for (const item of manifest.items) {
      const local = localByPath.get(cloudSyncPathKey(item.path))
      if (
        !local ||
        local.content.sha256 === item.sha256 ||
        isCloudSyncVaultSettingsPath(item.path)
      ) {
        continue
      }
      if (!item.content) throw new Error(`Manifest item ${item.item_id} did not include content`)
      state.pending_conflicts ??= {}
      state.pending_conflicts[item.item_id] = {
        id: item.item_id,
        item_id: item.item_id,
        kind: 'content',
        sequence: manifest.cursor,
        base: {
          path: item.path,
          revision: null,
          kind: item.kind,
          content: null
        },
        local: {
          path: local.path,
          revision: null,
          kind: local.kind,
          content: snapshotContent(local.content)
        },
        cloud: {
          path: item.path,
          revision: item.revision,
          kind: item.kind,
          content: snapshotContent(item.content)
        }
      }
    }
    await this.states.save(state)

    return { state, pulled, conflicts, localConflicts }
  }

  private async currentBootstrapConflict(conflict: CloudSyncBootstrapConflict): Promise<{
    item: CloudSyncManifestItem & { content: CloudSyncContent }
    local: CloudSyncLocalItem
  }> {
    if (await this.states.load(this.vaultId)) {
      throw new Error(
        'This Cloud conflict is no longer pending. Sync again to see the latest state.'
      )
    }

    const manifest = await this.stableManifest()
    const item = manifest.items.find(
      (candidate) =>
        candidate.item_id === conflict.item_id &&
        cloudSyncPathKey(candidate.path) === cloudSyncPathKey(conflict.path)
    )
    const local = (await this.repository.scan()).find(
      (candidate) => cloudSyncPathKey(candidate.path) === cloudSyncPathKey(conflict.path)
    )
    if (
      !item?.content ||
      !local ||
      item.sha256 !== conflict.remote_sha256 ||
      local.content.sha256 !== conflict.local_sha256
    ) {
      throw new Error('This Cloud conflict changed. Sync again to compare the latest versions.')
    }
    return {
      item: item as CloudSyncManifestItem & { content: CloudSyncContent },
      local
    }
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

function conflictVersion(content: CloudSyncContent): {
  sha256: string
  byte_length: number
  media_type: string
  text: string | null
} {
  return {
    sha256: content.sha256,
    byte_length: content.byte_length,
    media_type: content.media_type,
    text:
      content.encoding === 'utf8' &&
      content.byte_length <= CONFLICT_PREVIEW_LIMIT_BYTES &&
      (content.data.length > 0 || content.byte_length === 0)
        ? content.data
        : null
  }
}

function storedConflict(
  change: CloudSyncChange,
  previous: CloudSyncTrackedItem | undefined,
  local: CloudSyncLocalItem | null
): CloudSyncStoredConflict {
  return {
    id: change.item_id,
    item_id: change.item_id,
    kind:
      change.type === 'delete'
        ? 'delete'
        : change.type === 'move' || (previous && previous.path !== change.path)
          ? 'move'
          : 'content',
    sequence: change.sequence,
    base: {
      path: previous?.path ?? null,
      revision: previous?.revision ?? null,
      kind: previous?.kind ?? local?.kind ?? 'text',
      content: null
    },
    local: {
      path: local?.path ?? previous?.path ?? change.previous_path ?? change.path,
      revision: null,
      kind: local?.kind ?? previous?.kind ?? 'text',
      content: local ? snapshotContent(local.content) : null
    },
    cloud: cloudSnapshot(change, previous)
  }
}

function advancePendingConflict(
  conflict: CloudSyncStoredConflict,
  change: CloudSyncChange
): CloudSyncStoredConflict {
  return {
    ...conflict,
    kind:
      change.type === 'delete'
        ? 'delete'
        : change.type === 'move' ||
            (conflict.local.path !== null &&
              cloudSyncPathKey(change.path) !== cloudSyncPathKey(conflict.local.path))
          ? 'move'
          : 'content',
    sequence: change.sequence,
    cloud: cloudSnapshot(change, undefined, conflict.cloud),
    draft_text: conflict.draft_text
  }
}

function cloudSnapshot(
  change: CloudSyncChange,
  previous: CloudSyncTrackedItem | undefined,
  prior?: CloudSyncStoredConflict['cloud']
): CloudSyncStoredConflict['cloud'] {
  if (change.type === 'delete') {
    return {
      path: null,
      revision: change.revision,
      kind: prior?.kind ?? previous?.kind ?? 'text',
      content: null
    }
  }
  return {
    path: change.path,
    revision: change.revision,
    kind:
      previous?.kind ?? prior?.kind ?? (change.content?.encoding === 'base64' ? 'binary' : 'text'),
    content:
      change.type === 'upsert'
        ? change.content
          ? snapshotContent(change.content)
          : null
        : (prior?.content ?? (previous ? metadataContent(previous) : null))
  }
}

function assertCloudSnapshotIsCurrent(
  conflict: CloudSyncStoredConflict,
  manifest: { items: CloudSyncManifestItem[] }
): void {
  const current = manifest.items.find((item) => item.item_id === conflict.item_id)
  if (conflict.cloud.path === null) {
    if (current) throw new Error('The Cloud version changed. Sync again before choosing a version.')
    return
  }
  if (
    !current ||
    current.revision !== conflict.cloud.revision ||
    cloudSyncPathKey(current.path) !== cloudSyncPathKey(conflict.cloud.path) ||
    current.sha256 !== conflict.cloud.content?.sha256
  ) {
    throw new Error('The Cloud version changed. Sync again before choosing a version.')
  }
}

/** A tracked item's bytes without the bytes: enough to verify freshness and
 * to fetch the body later. */
function metadataContent(item: CloudSyncTrackedItem): CloudSyncContent {
  return {
    encoding: item.kind === 'text' ? 'utf8' : 'base64',
    data: '',
    sha256: item.sha256,
    byte_length: item.byte_length,
    media_type: item.media_type
  }
}

function snapshotContent(content: CloudSyncContent): CloudSyncContent {
  return content.byte_length > CONFLICT_SNAPSHOT_INLINE_LIMIT_BYTES && content.data
    ? { ...content, data: '' }
    : content
}

/** False for a metadata-only snapshot and for a host's direct-upload marker,
 * both of which describe bytes they do not carry. */
function hasInlineData(content: CloudSyncContent): boolean {
  return content.data.length > 0 || content.byte_length === 0
}

function inlineText(content: CloudSyncContent | null | undefined): string | null {
  return content?.encoding === 'utf8' && hasInlineData(content) ? content.data : null
}

function pendingConflictSummaries(state: CloudSyncState): CloudSyncPendingConflict[] {
  return Object.values(state.pending_conflicts ?? {})
    .sort((left, right) => left.local.path?.localeCompare(right.local.path ?? '') ?? -1)
    .map(pendingConflictSummary)
}

function pendingConflictSummary(conflict: CloudSyncStoredConflict): CloudSyncPendingConflict {
  return {
    id: conflict.id,
    item_id: conflict.item_id,
    path: conflict.local.path ?? conflict.base.path ?? conflict.cloud.path ?? 'Unknown file',
    cloud_path: conflict.cloud.path,
    kind: conflict.kind,
    can_merge: conflictTextMerge(conflict) !== null,
    has_base: conflict.base.content !== null
  }
}

function conflictTextMerge(conflict: CloudSyncStoredConflict) {
  const base = inlineText(conflict.base.content)
  const local = inlineText(conflict.local.content)
  const cloud = inlineText(conflict.cloud.content)
  if (base === null || local === null || cloud === null) return null
  return mergeCloudSyncText(base, local, cloud)
}

function publicConflictVersion(
  snapshot: CloudSyncStoredConflict['local'],
  role: 'base' | 'local' | 'cloud'
): CloudSyncPendingConflictDetails['local'] {
  const content = snapshot.content
  return {
    path: snapshot.path,
    revision: snapshot.revision,
    sha256: content?.sha256 ?? null,
    byte_length: content?.byte_length ?? 0,
    media_type: content?.media_type ?? null,
    text:
      content?.encoding === 'utf8' &&
      content.byte_length <= CONFLICT_PREVIEW_LIMIT_BYTES &&
      (content.data.length > 0 || content.byte_length === 0)
        ? content.data
        : null,
    deleted: role === 'local' ? content === null : role === 'cloud' ? snapshot.path === null : false
  }
}

function withoutConflict(state: CloudSyncState, conflictId: string): CloudSyncState {
  const pending = { ...state.pending_conflicts }
  delete pending[conflictId]
  return { ...state, pending_conflicts: pending }
}

function uniqueItemWithHash(
  items: CloudSyncLocalItem[],
  sha256: string
): CloudSyncLocalItem | undefined {
  const matches = items.filter((item) => item.content.sha256 === sha256)
  return matches.length === 1 ? matches[0] : undefined
}

function pendingConflictPaths(state: CloudSyncState): string[] {
  return Object.values(state.pending_conflicts ?? {}).flatMap((conflict) =>
    [
      conflict.base.path,
      conflict.local.path,
      conflict.cloud.path,
      ...(conflict.paused_paths ?? [])
    ].filter((path): path is string => path !== null)
  )
}

function withAdditionalPausedPaths(
  state: CloudSyncState,
  byPathKey: ReadonlyMap<string, ReadonlySet<string>>
): CloudSyncState {
  const pending = { ...state.pending_conflicts }
  let changed = false
  for (const [id, conflict] of Object.entries(pending)) {
    const keys = [conflict.base.path, conflict.local.path, conflict.cloud.path]
      .filter((path): path is string => path !== null)
      .map(cloudSyncPathKey)
    const additions = keys.flatMap((key) => [...(byPathKey.get(key) ?? [])])
    if (additions.length === 0) continue
    pending[id] = {
      ...conflict,
      kind: 'path',
      paused_paths: [...new Set([...(conflict.paused_paths ?? []), ...additions])]
    }
    changed = true
  }
  return changed ? { ...state, pending_conflicts: pending } : state
}

function pendingMatchesConflict(state: CloudSyncState, conflict: CloudSyncConflict): boolean {
  const keys = [conflict.path, conflict.current_path]
    .filter((path): path is string => Boolean(path))
    .map(cloudSyncPathKey)
  if (keys.length === 0) return false
  return Object.values(state.pending_conflicts ?? {}).some((pending) =>
    pendingConflictPaths({
      ...state,
      pending_conflicts: { [pending.id]: pending }
    }).some((path) => keys.includes(cloudSyncPathKey(path)))
  )
}

function isCapacityConflict(conflict: CloudSyncConflict): boolean {
  return ['QUOTA_EXCEEDED', 'CAPACITY_EXCEEDED', 'FILE_SIZE_LIMIT_EXCEEDED'].includes(conflict.code)
}

function publicLocalConflict(conflict: CloudSyncRepositoryConflict): CloudSyncLocalConflict {
  return {
    code: conflict.code,
    path: conflict.path,
    conflict_copy_path: conflict.conflict_copy_path
  }
}

async function textContent(text: string, mediaType: string): Promise<CloudSyncContent> {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer)
  return {
    encoding: 'utf8',
    data: text,
    sha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
    byte_length: bytes.byteLength,
    media_type: mediaType
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
    const usesObjectStorage = mutation.type === 'upsert' && mutation.content.encoding !== 'utf8'

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
