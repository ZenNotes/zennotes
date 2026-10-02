import type {
  CloudSyncChange,
  CloudSyncBootstrapConflict,
  CloudSyncBootstrapConflictDetails,
  CloudSyncBootstrapConflictResolution,
  CloudSyncConflict,
  CloudSyncContent,
  CloudSyncContentReference,
  CloudSyncContentRequestOptions,
  CloudSyncDownloadResponse,
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
import {
  validateCloudSyncContentReference, validateCloudSyncDownloadInstruction,
  cloudSyncStagedHandle, releaseCloudSyncStagedFile, throwIfCloudSyncCancelled,
  type CloudSyncDownloadSource, type CloudSyncStagedFile, type CloudSyncStagedConflict
} from './cloud-sync-content'

const MUTATION_BATCH_SIZE = 100
const MANIFEST_PAGE_SIZE = 250
const CHANGE_PAGE_SIZE = 250
const MANIFEST_RETRIES = 3
const BOOTSTRAP_BULK_MIN_ITEMS = 5
const BOOTSTRAP_BULK_FILE_LIMIT_BYTES = 1024 * 1024
const BOOTSTRAP_BULK_RESPONSE_LIMIT_BYTES = 16 * 1024 * 1024
// Every size divides its predecessor, so subdivision preserves the offset
// using only the existing page/per_page API, including around a large asset.
const BOOTSTRAP_PAGE_SIZES = [MANIFEST_PAGE_SIZE, 125, 25, 5, 1]
const CONFLICT_PREVIEW_LIMIT_BYTES = 256 * 1024
/** Conflict snapshots above this size keep only their metadata in state. The
 * local bytes stay on disk untouched while the decision waits, and the Cloud
 * bytes are fetched again, hash-checked, when a decision needs them. */
const CONFLICT_SNAPSHOT_INLINE_LIMIT_BYTES = CONFLICT_PREVIEW_LIMIT_BYTES

export interface CloudSyncRemote {
  readonly downloadSignal?: AbortSignal
  readonly allowInsecureLoopbackDownloads?: boolean
  readonly requiresContentReferenceHost?: boolean
  negotiateContentReferences?(): Promise<boolean>
  download?(vaultId: string, itemId: string, revision: number): Promise<CloudSyncDownloadResponse>
  /** Host memory budget for estimated bulk responses, capped at the shared
   * default. Hosts must preserve requested manifest page/perPage values. */
  readonly bootstrapContentPageBytes?: number
  manifest(
    vaultId: string,
    options: { includeContent?: boolean; page?: number; perPage?: number } & CloudSyncContentRequestOptions
  ): Promise<CloudSyncManifestResponse>
  changes(
    vaultId: string,
    after: number,
    limit?: number,
    options?: CloudSyncContentRequestOptions
  ): Promise<{
    data: CloudSyncChange[]
    cursor: number
    has_more: boolean
  }>
  mutate(vaultId: string, body: CloudSyncMutationRequest): Promise<CloudSyncMutationResponse>
  revision?(vaultId: string, itemId: string, revision: number, options?: CloudSyncContentRequestOptions): Promise<CloudSyncRevisionResponse>
}

export interface CloudSyncRepository {
  /** Native fingerprint fast path, including acknowledged echoes after restart. */
  matchesCloudContent?(path: string, reference: CloudSyncContentReference): Promise<boolean>
  stageCloudContent?(source: CloudSyncDownloadSource): Promise<CloudSyncStagedFile>
  applyStagedCloudContent?(change: CloudSyncChange, previous: CloudSyncTrackedItem | undefined, file: CloudSyncStagedFile): Promise<CloudSyncRepositoryConflict | void>
  resolveStagedCloudConflict?(input: CloudSyncStagedConflict): Promise<void>
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
  private referencesEnabled = false
  private referenceNegotiation?: Promise<void>

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
    await this.ensureReferences()
    const state = await this.requireState()
    const stored = state.pending_conflicts?.[conflictId]
    if (!stored) throw new Error('This conflict is no longer waiting for a decision.')
    const current = await this.currentLocalSnapshot(stored)
    const conflict = { ...stored, local: current, cloud: await this.previewSnapshot(stored.cloud) }
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
    await this.ensureReferences()
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
    if (resolution.choice === 'cloud' || resolution.choice === 'both') {
      // These choices consume Cloud bytes locally rather than writing a
      // revision. Check freshness using metadata, fetching only this file's
      // retained bytes when they are not already in the conflict snapshot.
      // Older hosts without a revision reader still need the content manifest.
      const needsContentFallback =
        !this.referencesEnabled && !this.remote.revision && stored.cloud.content !== null &&
        !hasInlineData(stored.cloud.content)
      const manifest = await this.stableManifest(needsContentFallback)
      assertCloudSnapshotIsCurrent(stored, manifest)
      const referenced = manifest.items.find((item) => item.item_id === stored.item_id)?.content_ref
      if (referenced && stored.cloud.path !== null) {
        if (resolution.choice === 'both' && (typeof resolution.keep_both_path !== 'string' || !resolution.keep_both_path.trim() || !local.path || !local.content)) {
          throw new Error('Choose a filename for this device’s version.')
        }
        await this.withStaged(referenced, (file) => this.repository.resolveStagedCloudConflict!({
          expected_path: local.path, expected_sha256: local.content?.sha256 ?? null,
          cloud_path: stored.cloud.path!, file,
          ...(resolution.choice === 'both' ? { keep_both_path: resolution.keep_both_path } : {})
        }))
        await this.saveWithoutConflict(state, stored.id)
        return
      }
      const current = await this.withCloudBytes(stored, manifest)
      if (resolution.choice === 'cloud') await this.applyCloudChoice(current, local)
      else await this.applyKeepBothChoice(current, local, resolution.keep_both_path)
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
        local.content?.media_type ?? stored.cloud.content?.media_type ?? stored.cloud.content_ref?.media_type ?? 'text/markdown'
      )
    } else if (resolution.choice === 'changes') {
      const merge = conflictTextMerge({ ...stored, local, cloud: await this.previewSnapshot(stored.cloud) })
      if (!merge) throw new Error('This file cannot be combined as text.')
      chosen = await textContent(
        resolveCloudSyncMerge(merge, resolution.change_choices ?? {}),
        local.content?.media_type ?? stored.cloud.content?.media_type ?? stored.cloud.content_ref?.media_type ?? 'text/markdown'
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
    // The server atomically checks base_revision and destination ownership.
    // A full-vault content download cannot strengthen that check and makes
    // resolving one small note depend on every unrelated asset in the vault.
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
    await this.ensureReferences()
    const current = await this.currentBootstrapConflict(conflict)
    const preview = await this.previewSnapshot({ path: current.item.path, revision: current.item.revision,
      kind: current.item.kind, content: current.item.content ?? null, content_ref: current.item.content_ref })
    return {
      conflict,
      kind: current.item.kind,
      local: conflictVersion(current.local.content),
      cloud: conflictVersion(preview.content ?? preview.content_ref!)
    }
  }

  async resolveBootstrapConflict(resolution: CloudSyncBootstrapConflictResolution): Promise<void> {
    await this.ensureReferences()
    if (!['local', 'cloud', 'both', 'merged'].includes(resolution.choice)) {
      throw new Error('That Cloud conflict resolution choice is not valid.')
    }
    if (resolution.choice === 'both' && (typeof resolution.keep_both_path !== 'string' || !resolution.keep_both_path.trim())) {
      throw new Error('Choose a filename for this device’s version.')
    }
    if (resolution.choice === 'merged' && typeof resolution.merged_text !== 'string') {
      throw new Error('Enter the merged text before resolving this conflict.')
    }

    const current = await this.currentBootstrapConflict(resolution.conflict)
    if (current.item.content_ref && (resolution.choice === 'cloud' || resolution.choice === 'both')) {
      await this.withStaged(current.item.content_ref, (file) => this.repository.resolveStagedCloudConflict!({
        expected_path: current.local.path, expected_sha256: current.local.content.sha256,
        cloud_path: current.item.path, file,
        ...(resolution.choice === 'both' ? { keep_both_path: resolution.keep_both_path } : {})
      }))
      return
    }
    if (resolution.choice !== 'local' && !this.repository.resolveBootstrapConflict &&
        !(current.item.content_ref && this.repository.replaceConflictFile)) {
      throw new Error('This device cannot resolve Cloud file conflicts yet.')
    }

    if (resolution.choice === 'local' || resolution.choice === 'merged') {
      if (resolution.choice === 'merged' && (current.item.content ?? current.item.content_ref)?.encoding !== 'utf8') {
        throw new Error('Only text conflicts can be merged.')
      }
      const chosen =
        resolution.choice === 'local'
          ? current.local.content
          : await textContent(resolution.merged_text!, current.local.content.media_type)

      const operationId = this.ids.operationId()
      const response = await this.remote.mutate(this.vaultId, {
        mutations: [
          {
            type: 'upsert',
            operation_id: operationId,
            item_id: current.item.item_id,
            base_revision: current.item.revision,
            path: current.item.path,
            kind: current.local.kind,
            content: chosen
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
    // A merged choice must reach Cloud before replacing the local version,
    // so a failed request leaves the original conflict safe to review again.
    if (resolution.choice !== 'local') {
      if (current.item.content_ref) {
        if (!this.repository.replaceConflictFile) throw new Error('This host cannot save a merged conflict.')
        await this.repository.replaceConflictFile({ path: current.item.path,
          expectedSha256: current.local.content.sha256,
          content: await textContent(resolution.merged_text!, current.local.content.media_type) })
        return
      }
      await this.repository.resolveBootstrapConflict!({
        path: current.item.path,
        expectedLocalSha256: current.local.content.sha256,
        cloudContent: current.item.content!,
        resolution
      })
    }
    // Do not initialize state here. The follow-up sync must still pull other
    // Cloud-only files and report any other first-sync conflicts.
  }

  private async run(): Promise<CloudSyncRunResult> {
    await this.ensureReferences()
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

    let localItems = await this.repository.scan()
    const repositoryPendingPaths = (await this.repository.pendingConflictPaths?.()) ?? []
    const reconciled = clearConvergedConflicts(state, localItems, repositoryPendingPaths)
    if (reconciled !== state) {
      state = reconciled
      await this.states.save(state)
    }
    const merged = await this.retryPendingMerges(state, localItems, repositoryPendingPaths)
    if (merged !== state) {
      state = merged
      await this.states.save(state)
      // Plan from the merged bytes, never from the scan preceding the write.
      localItems = await this.repository.scan()
    }
    const pendingPathKeys = new Set([
      ...repositoryPendingPaths.map(cloudSyncPathKey),
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
    const pages: Array<{ after: number; start: number; end: number }> = []
    let after = state.cursor

    for (;;) {
      // Coalescing needs the entire history's metadata, never its file bodies.
      // Content is hydrated one bounded page at a time after obsolete writes
      // and acknowledged echoes have been identified.
      const response = this.referencesEnabled
        ? await this.remote.changes(this.vaultId, after, CHANGE_PAGE_SIZE, { contentMode: 'references', maxInlineBytes: 0 })
        : await this.remote.changes(this.vaultId, after, CHANGE_PAGE_SIZE)
      let expectedSequence = after + 1
      for (const change of response.data) {
        this.validateWireItem(change)
        if (this.referencesEnabled && change.sequence !== expectedSequence++) {
          throw new Error(`Expected sync sequence ${expectedSequence - 1}, received ${change.sequence}`)
        }
        if (this.referencesEnabled && change.type === 'upsert' && !change.content_ref && !change.content) {
          throw new Error('Reference-mode change feed returned an upsert without content or a reference.')
        }
      }
      pages.push({ after, start: changes.length, end: changes.length + response.data.length })
      for (const change of response.data) {
        if (this.referencesEnabled && change.content) {
          const { content, ...metadata } = change
          const { data: _bytes, ...contentMetadata } = content
          changes.push({
            ...metadata,
            content_ref: { ...contentMetadata, item_id: change.item_id, revision: change.revision }
          })
        } else {
          changes.push(change)
        }
      }
      const last = response.data[response.data.length - 1]
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
    // The files a change touched stay changed when a later change in the same
    // batch fails, but the cursor used to move only once the whole batch was
    // through. Every retry then replayed the applied changes from the old
    // cursor: an upsert re-created a note the user had since deleted on this
    // device, and the batch failed again on the same change (#813). Remember
    // the newest state that can be persisted on its own (no coalesced
    // revision still waiting for the change that lands it) and save that
    // before the error escapes, so a retry resumes at the failing change.
    let landed = initialState
    let hydratedPage = -1
    let pageBodies = new Map<number, CloudSyncChange>()
    try {
      for (let index = 0; index < changes.length; index++) {
        throwIfCloudSyncCancelled(this.remote.downloadSignal)
        let change = changes[index]
        if (this.referencesEnabled && change.type === 'move' && change.content_ref && state.items[change.item_id]) {
          validateCloudSyncContentReference(change.content_ref, { ...state.items[change.item_id], revision: change.revision })
        }
        const acknowledged = acknowledgedSequences.has(change.sequence)
        if (acknowledged) {
          if (this.referencesEnabled && change.type === 'upsert') {
            const expected = state.items[change.item_id]
            const content = change.content ?? change.content_ref
            if (!expected || !content || expected.revision !== change.revision || expected.path !== change.path ||
                expected.sha256 !== content.sha256 || expected.byte_length !== content.byte_length) {
              throw new Error('Cloud echo did not match its acknowledged mutation.')
            }
          }
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
            if (this.referencesEnabled && change.type === 'upsert') {
              const pageIndex = pages.findIndex((page) => page.start <= index && index < page.end)
              if (pageIndex !== hydratedPage) {
                const page = pages[pageIndex]
                const response = await this.remote.changes(this.vaultId, page.after, page.end - page.start, { contentMode: 'references' })
                if (response.data.length !== page.end - page.start ||
                    response.data.some((body, offset) => !sameChangeMetadata(body, changes[page.start + offset]))) {
                  throw new Error('Cloud change page changed while its content was loading.')
                }
                for (const body of response.data) this.validateWireItem(body)
                pageBodies = new Map(response.data.map((body) => [body.sequence, body]))
                hydratedPage = pageIndex
              }
              change = pageBodies.get(change.sequence)!
              if (change.content) await this.validatedManifestContent({
                item_id: change.item_id, revision: change.revision, path: change.path,
                kind: change.content.encoding === 'utf8' ? 'text' : 'binary', ...change.content
              }, change.content)
            }
            const applied = await this.applyRemoteChange(change, previous)
            const conflict = applied.conflict
            if (conflict?.code === 'LOCAL_EDIT_CONFLICT') {
              const pending = await this.storedConflict(applied.change, previous, conflict.local ?? null)
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
        if (onDisk.size === 0) landed = state
      }
      throwIfCloudSyncCancelled(this.remote.downloadSignal)
    } catch (error) {
      if (landed !== initialState) await this.states.save(landed)
      throw error
    }
    if (changes.length > 0) await this.states.save(state)

    return { state, pulled, localConflicts }
  }

  private async retryPendingMerges(
    initialState: CloudSyncState,
    localItems: CloudSyncLocalItem[],
    repositoryPendingPaths: string[]
  ): Promise<CloudSyncState> {
    let state = initialState
    const blocked = new Set(repositoryPendingPaths.map(cloudSyncPathKey))
    const locals = new Map<string, CloudSyncLocalItem>()
    for (const item of localItems) {
      const key = cloudSyncPathKey(item.path)
      if (locals.has(key)) blocked.add(key)
      locals.set(key, item)
    }
    const pendingPaths = new Set<string>()
    for (const conflict of Object.values(state.pending_conflicts ?? {})) {
      const keys = new Set(
        pendingConflictPaths({
          ...state,
          pending_conflicts: { [conflict.id]: conflict }
        }).map(cloudSyncPathKey)
      )
      for (const key of keys) {
        if (pendingPaths.has(key)) blocked.add(key)
        pendingPaths.add(key)
      }
    }
    for (const conflict of Object.values(state.pending_conflicts ?? {})) {
      const cloud = conflict.cloud
      const tracked = state.items[conflict.item_id]
      if (
        conflict.kind !== 'content' ||
        conflict.draft_text !== undefined ||
        (conflict.paused_paths?.length ?? 0) > 0 ||
        cloud.path === null ||
        cloud.path !== conflict.local.path ||
        cloud.path !== conflict.base.path ||
        cloud.kind !== 'text' ||
        !cloud.content ||
        !tracked ||
        tracked.item_id !== conflict.item_id ||
        tracked.path !== cloud.path ||
        tracked.revision !== cloud.revision ||
        tracked.kind !== cloud.kind ||
        tracked.sha256 !== cloud.content.sha256 ||
        tracked.byte_length !== cloud.content.byte_length
      ) {
        continue
      }
      const key = cloudSyncPathKey(cloud.path)
      if (blocked.has(key)) continue
      const local = locals.get(key)
      if (!local || local.path !== cloud.path || local.kind !== 'text') continue
      // Identical bytes have their own stricter convergence checks above.
      if (inlineText(local.content) === inlineText(cloud.content)) continue
      if (
        await this.applyAutomaticMerge({
          ...conflict,
          local: { path: local.path, kind: local.kind, revision: null, content: local.content }
        })
      ) {
        state = withoutConflict(state, conflict.id)
      }
    }
    return state
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
    // A supplied reference identifies its immutable upsert. Only fall back to
    // the state revision (resolved by the server) when the move omitted one.
    if (this.referencesEnabled && change.type === 'move' && previous && !change.content_ref) {
      change = { ...change, content_ref: { item_id: change.item_id, revision: change.revision,
        encoding: previous.kind === 'text' ? 'utf8' : 'base64', sha256: previous.sha256,
        byte_length: previous.byte_length, media_type: previous.media_type } }
    }
    const conflict = storedConflict(change, previous, local)
    if (previous && !conflict.base.content) {
      conflict.base.content = await this.retainedText(previous.item_id, previous.revision, {
        sha256: previous.sha256,
        byte_length: previous.byte_length,
        text: previous.kind === 'text'
      })
    }
    if (conflict.cloud.content_ref) conflict.cloud = await this.previewSnapshot(conflict.cloud)
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
      if (this.referencesEnabled && (response.data.item_id !== itemId || response.data.revision !== revision || response.data.deleted)) return null
      if (response.data.content_ref) {
        if (response.data.content) throw new Error('Ambiguous Cloud revision content.')
        if (response.data.item_id !== itemId || response.data.revision !== revision || response.data.deleted) return null
        const ref = validateCloudSyncContentReference(response.data.content_ref, { item_id: itemId, revision, ...expected })
        return await this.withStaged(ref, async (file) => file.preview ?? null)
      }
      const content = response.data.content
      if (content?.encoding === 'utf8' && content.sha256 === expected.sha256) {
        if (this.referencesEnabled) return await this.validatedManifestContent({
          item_id: itemId, revision, path: response.data.path, kind: response.data.kind,
          sha256: expected.sha256, byte_length: expected.byte_length, media_type: content.media_type
        }, content)
        return content
      }
    } catch {
      throwIfCloudSyncCancelled(this.remote.downloadSignal)
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
    if (!content && item && this.remote.revision && conflict.cloud.revision !== null) {
      try {
        const hydrated = await this.hydrateManifestItem(item)
        if (matches(hydrated.content)) content = hydrated.content
      } catch (cause) {
        throw new Error(
          'The Cloud version of this file is not available right now. Sync again and retry.',
          { cause }
        )
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

  private async ensureReferences(): Promise<void> {
    if (!this.remote.negotiateContentReferences || !this.remote.download ||
        !this.repository.stageCloudContent || !this.repository.applyStagedCloudContent ||
        !this.repository.resolveStagedCloudConflict) {
      if (this.remote.requiresContentReferenceHost) throw new Error('This host needs all Cloud staging and conflict hooks before streaming sync.')
      return
    }
    this.referenceNegotiation ??= this.remote.negotiateContentReferences().then((enabled) => {
      this.referencesEnabled = enabled
    }).finally(() => { this.referenceNegotiation = undefined })
    await this.referenceNegotiation
  }

  private async withStaged<Result>(reference: CloudSyncContentReference, use: (file: CloudSyncStagedFile) => Promise<Result>): Promise<Result> {
    if (!this.referencesEnabled || !this.remote.download || !this.repository.stageCloudContent) {
      throw new Error('This host cannot safely download Cloud content references.')
    }
    const ref = Object.freeze(validateCloudSyncContentReference(reference))
    throwIfCloudSyncCancelled(this.remote.downloadSignal)
    const file = await this.repository.stageCloudContent({
      reference: ref, signal: this.remote.downloadSignal, previewLimitBytes: CONFLICT_PREVIEW_LIMIT_BYTES,
      allowInsecureLoopback: this.remote.allowInsecureLoopbackDownloads,
      getInstruction: async () => {
        throwIfCloudSyncCancelled(this.remote.downloadSignal)
        return validateCloudSyncDownloadInstruction(
          await this.remote.download!(this.vaultId, ref.item_id, ref.revision), ref,
          this.remote.allowInsecureLoopbackDownloads
        )
      }
    })
    try {
      cloudSyncStagedHandle(file, ref)
      throwIfCloudSyncCancelled(this.remote.downloadSignal)
      if (file.preview) {
        if (ref.byte_length > CONFLICT_PREVIEW_LIMIT_BYTES || typeof file.preview.data !== 'string' || file.preview.data.length > CONFLICT_PREVIEW_LIMIT_BYTES * 2) {
          throw new Error('Cloud staging preview exceeded its byte budget.')
        }
        const item: CloudSyncManifestItem = { ...ref, path: 'preview', kind: ref.encoding === 'utf8' ? 'text' : 'binary', content: file.preview }
        this.validateWireItem(item)
        await this.validatedManifestContent(item, file.preview)
      }
      return await use(file)
    } finally {
      await releaseCloudSyncStagedFile(file)
    }
  }

  private async previewSnapshot(snapshot: CloudSyncStoredConflict['cloud']): Promise<CloudSyncStoredConflict['cloud']> {
    const ref = snapshot.content_ref
    if (!ref || ref.encoding !== 'utf8' || ref.byte_length > CONFLICT_PREVIEW_LIMIT_BYTES) return snapshot
    return this.withStaged(ref, async (file) => file.preview ? { ...snapshot, content: file.preview } : snapshot)
  }

  private async applyRemoteChange(change: CloudSyncChange, previous: CloudSyncTrackedItem | undefined): Promise<{
    change: CloudSyncChange; conflict: CloudSyncRepositoryConflict | void
  }> {
    throwIfCloudSyncCancelled(this.remote.downloadSignal)
    if (!change.content_ref || change.type !== 'upsert') return { change, conflict: await this.repository.apply(change, previous) }
    const ref = validateCloudSyncContentReference(change.content_ref, change)
    if (await this.repository.matchesCloudContent?.(change.path, ref)) return { change, conflict: undefined }
    return this.withStaged(ref, async (file) => {
      const applied = file.preview ? { ...change, content: file.preview, content_ref: undefined } : change
      const conflict = file.preview ? await this.repository.apply(applied, previous) :
        await this.repository.applyStagedCloudContent!(change, previous, file)
      return { change: applied, conflict }
    })
  }

  private validateWireItem(item: CloudSyncManifestItem | CloudSyncChange): void {
    if (this.referencesEnabled) {
      if (typeof item.item_id !== 'string' || !item.item_id || !Number.isSafeInteger(item.revision) || item.revision < 1) {
        throw new Error('Invalid Cloud item identity or revision.')
      }
      normalizeCloudSyncPath(item.path)
      if ('sequence' in item) {
        if (!Number.isSafeInteger(item.sequence) || item.sequence < 1 || !['upsert', 'move', 'delete'].includes(item.type)) {
          throw new Error('Invalid Cloud change sequence or type.')
        }
      } else if (!['text', 'binary'].includes(item.kind) || typeof item.sha256 !== 'string' ||
          !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.byte_length) || item.byte_length < 0 ||
          typeof item.media_type !== 'string' || !item.media_type) {
        throw new Error('Invalid Cloud manifest metadata.')
      }
    }
    if (item.content_ref) {
      if (!this.referencesEnabled || item.content) throw new Error('Unexpected or ambiguous Cloud content reference.')
      validateCloudSyncContentReference(item.content_ref, item)
    }
    if (this.referencesEnabled && item.content) {
      if (typeof item.content.data !== 'string' || item.content.byte_length > 1_048_576 ||
          item.content.data.length > 2_097_152 || Object.keys(item.content).some((key) =>
        !['encoding', 'data', 'sha256', 'byte_length', 'media_type'].includes(key))) {
        throw new Error('Invalid inline Cloud content or remote staging handle.')
      }
      const { data: _bytes, ...metadata } = item.content
      validateCloudSyncContentReference({ ...metadata, item_id: item.item_id, revision: item.revision }, item)
    }
  }

  private async loadOrBootstrap(): Promise<{
    state: CloudSyncState
    pulled: number
    conflicts: CloudSyncBootstrapConflict[]
    localConflicts: CloudSyncLocalConflict[]
  }> {
    const existing = await this.states.load(this.vaultId)
    if (existing) return { state: existing, pulled: 0, conflicts: [], localConflicts: [] }

    const manifest = await this.stableManifest(!this.referencesEnabled && !this.remote.revision)
    const localItems = await this.repository.scan()
    const localByPath = new Map(localItems.map((item) => [cloudSyncPathKey(item.path), item]))
    const conflicts: CloudSyncBootstrapConflict[] = []
    const localConflicts: CloudSyncLocalConflict[] = []
    let pulled = 0
    const state = manifestState(this.vaultId, manifest.cursor, manifest.items)

    for await (const item of this.bootstrapItems(manifest, localByPath)) {
      throwIfCloudSyncCancelled(this.remote.downloadSignal)
      const local = localByPath.get(cloudSyncPathKey(item.path))

      if (!local || isCloudSyncVaultSettingsPath(item.path)) {
        const applied = await this.applyRemoteChange(manifestUpsert(item), undefined)
        const conflict = applied.conflict
        if (conflict?.code === 'LOCAL_EDIT_CONFLICT') {
          state.pending_conflicts ??= {}
          state.pending_conflicts[item.item_id] = await this.storedConflict(applied.change, undefined, conflict.local ?? null)
        } else if (conflict) localConflicts.push(conflict)
        pulled++
        continue
      }
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
          content: item.content ? snapshotContent(item.content) : null,
          ...(item.content_ref ? { content_ref: item.content_ref } : {})
        }
      }
    }
    throwIfCloudSyncCancelled(this.remote.downloadSignal)
    await this.states.save(state)

    return { state, pulled, conflicts, localConflicts }
  }

  private async *bootstrapItems(
    manifest: { cursor: number; items: CloudSyncManifestItem[] },
    localByPath: ReadonlyMap<string, CloudSyncLocalItem>
  ): AsyncGenerator<CloudSyncManifestItem> {
    const budget = this.remote.bootstrapContentPageBytes ?? BOOTSTRAP_BULK_RESPONSE_LIMIT_BYTES
    if (!Number.isSafeInteger(budget) || budget <= 0) {
      throw new Error('The bootstrap content-page byte budget must be a positive integer.')
    }
    const limits = {
      pageSize: MANIFEST_PAGE_SIZE,
      contentBytes: Math.min(budget, BOOTSTRAP_BULK_RESPONSE_LIMIT_BYTES)
    }
    for (let offset = 0; offset < manifest.items.length; offset += MANIFEST_PAGE_SIZE) {
      yield* this.bootstrapPage(manifest, localByPath, offset, MANIFEST_PAGE_SIZE, limits)
    }
  }

  private async *bootstrapPage(
    manifest: { cursor: number; items: CloudSyncManifestItem[] },
    localByPath: ReadonlyMap<string, CloudSyncLocalItem>,
    offset: number,
    pageSize: number,
    limits: { pageSize: number; contentBytes: number }
  ): AsyncGenerator<CloudSyncManifestItem> {
    const items = manifest.items.slice(offset, offset + pageSize)
    const needed = items.filter(
      (item) => localByPath.get(cloudSyncPathKey(item.path))?.content.sha256 !== item.sha256
    )
    if (needed.length === 0) return
    if (
      (!this.referencesEnabled && !this.remote.revision) ||
      needed.every((item) => item.content) ||
      (this.referencesEnabled
        ? needed.every((item) => item.content_ref && item.byte_length > CONFLICT_PREVIEW_LIMIT_BYTES)
        : needed.length < BOOTSTRAP_BULK_MIN_ITEMS)
    ) {
      for (const item of needed) yield await this.hydrateManifestItem(item)
      return
    }

    // JSON can expand one text byte to six escaped characters. Leave space
    // below the server's 32 MiB limit for framing, and never put a large file
    // in a content page just because the other files already exist locally.
    const estimatedBytes = items.reduce(
      (total, item) =>
        total +
        item.byte_length * 6 +
        (item.path.length + item.item_id.length + item.media_type.length) * 12 +
        1024,
      0
    )
    if (
      pageSize <= limits.pageSize &&
      (this.referencesEnabled || (items.every((item) => item.byte_length <= BOOTSTRAP_BULK_FILE_LIMIT_BYTES) &&
      estimatedBytes <= limits.contentBytes))
    ) {
      let response: CloudSyncManifestResponse | undefined
      try {
        response = await this.remote.manifest(this.vaultId, {
          includeContent: true,
          page: offset / pageSize + 1,
          perPage: pageSize
        })
      } catch (error) {
        if (!isCloudManifestTooLarge(error)) throw error
        limits.pageSize = BOOTSTRAP_PAGE_SIZES.find((size) => size < pageSize)!
      }
      if (response) {
        // Page offsets are meaningful only for the captured inventory. Do
        // not turn cursor drift, 429s or aborts into a per-file retry storm.
        if (
          response.cursor !== manifest.cursor ||
          response.data.length !== items.length ||
          response.data.some((item, index) => !sameManifestItem(item, items[index]))
        ) {
          throw new Error('Vault changed while bootstrap content was loading. Retry sync.')
        }
        const neededIds = new Set(needed.map((item) => item.item_id))
        for (const item of response.data) {
          this.validateWireItem(item)
          if (!neededIds.has(item.item_id)) continue
          if (item.content_ref) { yield item; continue }
          yield {
            ...item,
            content: await this.validatedManifestContent(item, item.content)
          }
        }
        // The page is consumed before the next is fetched. Only metadata and
        // bounded conflict previews survive in the inventory and sync state.
        return
      }
    }

    const smallerSize = BOOTSTRAP_PAGE_SIZES.find((size) => size < pageSize)!
    for (let start = offset; start < offset + items.length; start += smallerSize) {
      yield* this.bootstrapPage(manifest, localByPath, start, smallerSize, limits)
    }
  }

  private async currentBootstrapConflict(conflict: CloudSyncBootstrapConflict): Promise<{
    item: CloudSyncManifestItem
    local: CloudSyncLocalItem
  }> {
    if (await this.states.load(this.vaultId)) {
      throw new Error(
        'This Cloud conflict is no longer pending. Sync again to see the latest state.'
      )
    }

    const manifest = await this.stableManifest(!this.referencesEnabled && !this.remote.revision)
    const item = manifest.items.find(
      (candidate) =>
        candidate.item_id === conflict.item_id &&
        cloudSyncPathKey(candidate.path) === cloudSyncPathKey(conflict.path)
    )
    const local = (await this.repository.scan()).find(
      (candidate) => cloudSyncPathKey(candidate.path) === cloudSyncPathKey(conflict.path)
    )
    if (
      !item ||
      !local ||
      item.sha256 !== conflict.remote_sha256 ||
      local.content.sha256 !== conflict.local_sha256
    ) {
      throw new Error('This Cloud conflict changed. Sync again to compare the latest versions.')
    }
    return {
      item: await this.hydrateManifestItem(item),
      local
    }
  }

  private async hydrateManifestItem(
    item: CloudSyncManifestItem
  ): Promise<CloudSyncManifestItem> {
    this.validateWireItem(item)
    if (item.content_ref) return item
    if (item.content) return { ...item, content: item.content }
    if (!this.remote.revision) {
      throw new Error(`Manifest item ${item.item_id} did not include content`)
    }

    const { data } = await this.remote.revision(this.vaultId, item.item_id, item.revision)
    if (
      data.item_id !== item.item_id ||
      data.revision !== item.revision ||
      data.path !== item.path ||
      data.kind !== item.kind ||
      data.deleted
    ) {
      throw new Error(
        `Cloud revision for ${item.path} did not match the sync manifest. Retry sync.`
      )
    }
    if (data.content_ref) {
      if (data.content) throw new Error('Ambiguous Cloud revision content.')
      const referenced = { ...item, content: undefined, content_ref: data.content_ref }
      this.validateWireItem(referenced)
      return referenced
    }
    return {
      ...item,
      content: await this.validatedManifestContent(item, data.content)
    }
  }

  private async validatedManifestContent(
    item: CloudSyncManifestItem,
    content: CloudSyncContent | null | undefined
  ): Promise<CloudSyncContent> {
    if (
      !content ||
      content.sha256 !== item.sha256 ||
      content.byte_length !== item.byte_length ||
      content.media_type !== item.media_type ||
      !hasInlineData(content)
    ) {
      throw new Error(
        `Cloud revision for ${item.path} did not match the sync manifest. Retry sync.`
      )
    }

    // A content response is independent of the metadata request. Check its
    // actual bytes too before a host writes them or stores a conflict preview.
    let bytes: Uint8Array<ArrayBuffer>
    if (content.encoding === 'utf8') {
      bytes = new TextEncoder().encode(content.data)
    } else if (content.encoding === 'base64') {
      const binary = atob(content.data)
      bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    } else {
      throw new Error('Encrypted cloud sync content must be decrypted before filesystem apply')
    }
    if (bytes.byteLength !== item.byte_length) {
      throw new Error(`Cloud revision for ${item.path} has invalid bytes. Retry sync.`)
    }
    const digest = await crypto.subtle.digest('SHA-256', bytes.buffer)
    const hash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
    if (hash !== item.sha256) {
      throw new Error(`Cloud revision for ${item.path} has an invalid hash. Retry sync.`)
    }
    return content
  }

  private async stableManifest(includeContent: boolean): Promise<{
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
          includeContent,
          page,
          perPage: MANIFEST_PAGE_SIZE
        })
        if (this.referencesEnabled && (!Number.isSafeInteger(response.cursor) || response.cursor < 0 ||
            !Array.isArray(response.data) ||
            (response.next_page !== null && (response.next_page !== page + 1 || response.data.length !== MANIFEST_PAGE_SIZE)))) {
          throw new Error('Invalid reference-mode manifest cursor or pagination.')
        }
        cursor ??= response.cursor

        if (cursor !== response.cursor) {
          stable = false
          break
        }
        for (const item of response.data) {
          this.validateWireItem(item)
          if (this.referencesEnabled && !includeContent && !item.content_ref) {
            throw new Error('Reference-mode manifest omitted a content reference.')
          }
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

function isCloudManifestTooLarge(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as { status?: unknown; code?: unknown }
  return value.status === 413 && value.code === 'SYNC_RESPONSE_TOO_LARGE'
}

function sameManifestItem(left: CloudSyncManifestItem, right: CloudSyncManifestItem): boolean {
  return (
    left.item_id === right.item_id &&
    left.path === right.path &&
    left.kind === right.kind &&
    left.revision === right.revision &&
    left.sha256 === right.sha256 &&
    left.byte_length === right.byte_length &&
    left.media_type === right.media_type
  )
}

function conflictVersion(content: CloudSyncContent | CloudSyncContentReference): {
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
      'data' in content &&
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
  const ref = change.content_ref ?? (change.type === 'move' ? prior?.content_ref : undefined)
  if (ref) return {
    path: change.path, revision: change.revision,
    kind: ref.encoding === 'utf8' ? 'text' : 'binary', content: null,
    content_ref: validateCloudSyncContentReference(ref, { item_id: change.item_id, revision: change.revision })
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
    current.sha256 !== (conflict.cloud.content ?? conflict.cloud.content_ref)?.sha256 ||
    current.byte_length !== (conflict.cloud.content ?? conflict.cloud.content_ref)?.byte_length
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
  const content = snapshot.content ?? snapshot.content_ref ?? null
  return {
    path: snapshot.path,
    revision: snapshot.revision,
    sha256: content?.sha256 ?? null,
    byte_length: content?.byte_length ?? 0,
    media_type: content?.media_type ?? null,
    text:
      content?.encoding === 'utf8' &&
      'data' in content &&
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

function clearConvergedConflicts(
  state: CloudSyncState,
  localItems: CloudSyncLocalItem[],
  repositoryPendingPaths: string[]
): CloudSyncState {
  const blocked = new Set(repositoryPendingPaths.map(cloudSyncPathKey))
  const locals = new Map<string, CloudSyncLocalItem>()
  for (const item of localItems) {
    const key = cloudSyncPathKey(item.path)
    if (locals.has(key)) blocked.add(key)
    locals.set(key, item)
  }
  let next = state
  for (const conflict of Object.values(state.pending_conflicts ?? {})) {
    const cloud = conflict.cloud
    const cloudContent = cloud.content ?? cloud.content_ref
    const tracked = state.items[conflict.item_id]
    if (
      conflict.kind !== 'content' ||
      (conflict.paused_paths?.length ?? 0) > 0 ||
      cloud.path === null ||
      cloud.path !== conflict.local.path ||
      cloud.path !== conflict.base.path ||
      !cloudContent ||
      !tracked ||
      tracked.item_id !== conflict.item_id ||
      tracked.path !== cloud.path ||
      tracked.revision !== cloud.revision ||
      tracked.kind !== cloud.kind ||
      tracked.sha256 !== cloudContent.sha256 ||
      tracked.byte_length !== cloudContent.byte_length ||
      blocked.has(cloudSyncPathKey(cloud.path))
    ) continue

    const local = locals.get(cloudSyncPathKey(cloud.path))
    if (
      !local ||
      local.path !== cloud.path ||
      local.kind !== cloud.kind ||
      local.content.sha256 !== cloudContent.sha256 ||
      local.content.byte_length !== cloudContent.byte_length ||
      (conflict.draft_text !== undefined && conflict.draft_text !== inlineText(local.content))
    ) continue

    // The change feed already advanced the tracked revision. Agreement only
    // removes the pause; it never rewrites either file or sends a new version.
    next = withoutConflict(next, conflict.id)
  }
  return next
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
    content: item.content,
    ...(item.content_ref ? { content_ref: item.content_ref } : {})
  }
}

function sameChangeMetadata(left: CloudSyncChange, right: CloudSyncChange): boolean {
  const a = left.content ?? left.content_ref
  const b = right.content ?? right.content_ref
  return left.sequence === right.sequence && left.item_id === right.item_id &&
    left.revision === right.revision && left.type === right.type && left.path === right.path &&
    left.previous_path === right.previous_path && a?.sha256 === b?.sha256 &&
    a?.byte_length === b?.byte_length && a?.encoding === b?.encoding && a?.media_type === b?.media_type
}
