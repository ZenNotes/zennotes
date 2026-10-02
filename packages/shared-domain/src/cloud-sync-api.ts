import type {
  CloudBackupNoteRestoreRequest,
  CloudBackupNoteRestoreResponse,
  CloudBackupRestoreRequest,
  CloudBackupRestoreResponse,
  CloudBackupScheduleResponse,
  CloudBackupSnapshotCollection,
  CloudBackupSnapshotItemCollection,
  CloudBackupSnapshotResponse,
  CloudPublishedNoteCollection,
  CloudPublishedNoteResult,
  CloudPublishNoteInput,
  CloudServiceAccountResponse,
  CloudSyncChangeResponse,
  CloudSyncContentRequestOptions,
  CloudSyncDownloadResponse,
  CloudSyncManifestResponse,
  CloudSyncMutationRequest,
  CloudSyncMutationResponse,
  CloudSyncRevisionResponse,
  CloudSyncUploadCompletionResponse,
  CloudSyncUploadInitiationResponse,
  CloudSyncUploadRequest,
  CloudSyncVaultCollection,
  CloudSyncVaultResponse
} from '@zennotes/bridge-contract/cloud-sync'
import type { CloudSyncRateLimitScope } from './cloud-sync-rate-limit'

export * from './cloud-sync-content'
export type {
  CloudSyncContentMetadata, CloudSyncContentReference, CloudSyncContentRequestOptions,
  CloudSyncDownloadInstruction, CloudSyncDownloadResponse
} from '@zennotes/bridge-contract/cloud-sync'

const contentCapabilities = new Map<string, { until: number; value: Promise<boolean> }>()

export {
  CloudSyncRateLimitCoordinator,
  cloudSyncRateLimits,
  cloudSyncRetryAfterMs,
  type CloudSyncRateLimitScope,
  type CloudSyncRateLimitOptions,
  type CloudSyncResponseHeaders
} from './cloud-sync-rate-limit'

export interface CloudSyncHttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  body?: unknown
  timeoutMs?: number
  signal?: AbortSignal
  /** Only for explicitly idempotent JSON operations with stable operation/session IDs.
   * GETs are replayable by default. Other requests are never retried implicitly. */
  retryOnRateLimit?: boolean
}

export interface CloudSyncHttpTransport {
  request<Response>(request: CloudSyncHttpRequest): Promise<Response>
}

export interface CloudSyncApiClientOptions {
  /** Lower the coordinator's estimated bulk content-page budget. Does not
   * change page offsets or cap the size of an individual revision download. */
  bootstrapContentPageBytes?: number
  /** Explicit streaming-host opt-in. Negotiation must succeed before reads. */
  contentReferences?: boolean
  accountScope?: CloudSyncRateLimitScope
  maxInlineBytes?: number
  signal?: AbortSignal
  allowInsecureLoopbackDownloads?: boolean
}

/** Typed API surface shared by Electron and both Capacitor shells. */
export class CloudSyncApiClient {
  readonly bootstrapContentPageBytes?: number
  readonly downloadSignal?: AbortSignal
  readonly allowInsecureLoopbackDownloads: boolean
  readonly requiresContentReferenceHost: boolean
  private referencesActive = false
  private capabilityPromise?: Promise<boolean>
  private capabilityExpiresAt = 0

  constructor(
    private readonly http: CloudSyncHttpTransport,
    private readonly options: CloudSyncApiClientOptions = {}
  ) {
    this.options = { ...options, accountScope: options.accountScope ? { ...options.accountScope } : undefined }
    const budget = options.bootstrapContentPageBytes
    if (budget !== undefined && (!Number.isSafeInteger(budget) || budget <= 0)) {
      throw new Error('The bootstrap content-page byte budget must be a positive integer.')
    }
    this.bootstrapContentPageBytes = budget
    this.downloadSignal = options.signal
    this.allowInsecureLoopbackDownloads = options.allowInsecureLoopbackDownloads === true
    this.requiresContentReferenceHost = options.contentReferences === true
  }

  async listVaults(): Promise<CloudSyncVaultCollection> {
    return this.http.request({ method: 'GET', path: '/api/v1/vaults' })
  }

  async account(): Promise<CloudServiceAccountResponse> {
    const response = await this.http.request<CloudServiceAccountResponse>({ method: 'GET', path: '/api/v1/account' })
    const key = this.capabilityKey()
    if (key) contentCapabilities.set(key, {
      until: Date.now() + 300_000, value: Promise.resolve(response.data.capabilities?.content_references === true)
    })
    return response
  }

  async negotiateContentReferences(): Promise<boolean> {
    if (!this.options.contentReferences) return false
    if (Date.now() >= this.capabilityExpiresAt) this.capabilityPromise = undefined
    const key = this.capabilityKey()
    const cached = key ? contentCapabilities.get(key) : undefined
    if (!this.capabilityPromise) {
      const value = cached && cached.until > Date.now() ? cached.value :
        this.account().then((response) => response.data.capabilities?.content_references === true)
      if (key && value !== cached?.value) contentCapabilities.set(key, { until: Date.now() + 300_000, value })
      this.capabilityExpiresAt = cached && value === cached.value ? cached.until : Date.now() + 300_000
      this.capabilityPromise = value.catch((error) => {
        this.capabilityPromise = undefined
        if (key && contentCapabilities.get(key)?.value === value) contentCapabilities.delete(key)
        throw error
      })
    }
    if (!await this.capabilityPromise) {
      this.referencesActive = false
      throw new Error('This Cloud server needs content-reference support before this streaming host can sync.')
    }
    this.referencesActive = true
    return true
  }

  private capabilityKey(): string | undefined {
    const scope = this.options.accountScope
    return scope ? JSON.stringify([new URL(scope.baseUrl).href.replace(/\/+$/, ''), scope.accountId]) : undefined
  }

  private contentQuery(options: CloudSyncContentRequestOptions = {}, metadataOnly = false): Record<string, string | number> {
    if (!this.referencesActive) {
      if (options.contentMode || (this.options.contentReferences && !metadataOnly)) throw new Error('Negotiate Cloud content references before using the reference protocol.')
      return {}
    }
    const inline = options.maxInlineBytes ?? this.options.maxInlineBytes ?? 262_144
    const response = options.maxResponseBytes ?? Math.max(65_536, Math.min(this.bootstrapContentPageBytes ?? 16_777_216, 33_554_432))
    if (!Number.isInteger(inline) || inline < 0 || inline > 1_048_576 ||
        !Number.isInteger(response) || response < 65_536 || response > 33_554_432) {
      throw new Error('Invalid Cloud content response budgets.')
    }
    return { content_mode: 'references', max_inline_bytes: inline, max_response_bytes: response }
  }

  async createVault(name: string): Promise<CloudSyncVaultResponse> {
    return this.http.request({
      method: 'POST',
      path: '/api/v1/vaults',
      body: { name }
    })
  }

  async deleteVault(vaultId: string): Promise<void> {
    await this.http.request({
      method: 'DELETE',
      path: `/api/v1/vaults/${encodeURIComponent(vaultId)}`
    })
  }

  async listPublishedNotes(): Promise<CloudPublishedNoteCollection> {
    return this.http.request({ method: 'GET', path: '/api/v1/shares' })
  }

  async publishNote(input: CloudPublishNoteInput): Promise<CloudPublishedNoteResult> {
    return this.http.request({
      method: 'POST',
      path: '/api/v1/shares',
      body: publishedNoteBody(input),
      timeoutMs: 300_000
    })
  }

  async updatePublishedNote(
    shareId: number,
    input: CloudPublishNoteInput
  ): Promise<CloudPublishedNoteResult> {
    return this.http.request({
      method: 'PUT',
      path: `/api/v1/shares/${encodeURIComponent(String(shareId))}`,
      body: publishedNoteBody(input),
      timeoutMs: 300_000
    })
  }

  async unpublishNote(shareId: number): Promise<void> {
    await this.http.request({
      method: 'DELETE',
      path: `/api/v1/shares/${encodeURIComponent(String(shareId))}`
    })
  }

  async manifest(
    vaultId: string,
    options: { includeContent?: boolean; page?: number; perPage?: number } & CloudSyncContentRequestOptions = {}
  ): Promise<CloudSyncManifestResponse> {
    const query = encodeQuery({
      include_content: options.includeContent,
      page: options.page,
      per_page: options.perPage,
      ...this.contentQuery(options, options.includeContent === false)
    })
    return this.http.request({
      method: 'GET',
      path: `/api/v1/vaults/${encodeURIComponent(vaultId)}/manifest${query}`
    })
  }

  async changes(vaultId: string, after: number, limit = 100, options: CloudSyncContentRequestOptions = {}): Promise<CloudSyncChangeResponse> {
    return this.http.request({
      method: 'GET',
      path: `/api/v1/vaults/${encodeURIComponent(vaultId)}/changes${encodeQuery({ after, limit, ...this.contentQuery(options) })}`
    })
  }

  async revision(
    vaultId: string,
    itemId: string,
    revision: number,
    options: CloudSyncContentRequestOptions = {}
  ): Promise<CloudSyncRevisionResponse> {
    return this.http.request({
      method: 'GET',
      path: `/api/v1/vaults/${encodeURIComponent(vaultId)}/items/${encodeURIComponent(itemId)}/revisions/${encodeURIComponent(String(revision))}${encodeQuery(this.contentQuery(options))}`
    })
  }

  async download(vaultId: string, itemId: string, revision: number): Promise<CloudSyncDownloadResponse> {
    if (!this.referencesActive) throw new Error('Negotiate Cloud content references before downloading revisions.')
    return this.http.request({ method: 'GET',
      path: `/api/v1/vaults/${encodeURIComponent(vaultId)}/items/${encodeURIComponent(itemId)}/revisions/${encodeURIComponent(String(revision))}/download`
    })
  }

  async mutate(
    vaultId: string,
    body: CloudSyncMutationRequest
  ): Promise<CloudSyncMutationResponse> {
    return this.http.request({
      method: 'POST',
      path: `/api/v1/vaults/${encodeURIComponent(vaultId)}/mutations`,
      body,
      ...(body.mutations.length > 0 && body.mutations.every((mutation) => mutation.operation_id)
        ? { retryOnRateLimit: true } : {})
    })
  }

  async initiateUpload(
    vaultId: string,
    body: CloudSyncUploadRequest
  ): Promise<CloudSyncUploadInitiationResponse> {
    return this.http.request({
      method: 'POST',
      path: `/api/v1/vaults/${encodeURIComponent(vaultId)}/uploads`,
      body,
      ...(body.operation_id ? { retryOnRateLimit: true } : {})
    })
  }

  async completeUpload(
    vaultId: string,
    uploadId: string
  ): Promise<CloudSyncUploadCompletionResponse> {
    return this.http.request({
      method: 'POST',
      path: `${this.uploadPath(vaultId, uploadId)}/complete`,
      timeoutMs: 300_000,
      ...(uploadId ? { retryOnRateLimit: true } : {})
    })
  }

  async abortUpload(vaultId: string, uploadId: string): Promise<void> {
    await this.http.request({
      method: 'DELETE',
      path: this.uploadPath(vaultId, uploadId)
    })
  }

  async listBackups(vaultId: string): Promise<CloudBackupSnapshotCollection> {
    return this.http.request({
      method: 'GET',
      path: `/api/v1/vaults/${encodeURIComponent(vaultId)}/backups`
    })
  }

  async backupSchedule(vaultId: string): Promise<CloudBackupScheduleResponse> {
    return this.http.request({
      method: 'GET',
      path: `/api/v1/vaults/${encodeURIComponent(vaultId)}/backup-schedule`
    })
  }

  async updateBackupSchedule(
    vaultId: string,
    enabled: boolean
  ): Promise<CloudBackupScheduleResponse> {
    return this.http.request({
      method: 'PUT',
      path: `/api/v1/vaults/${encodeURIComponent(vaultId)}/backup-schedule`,
      body: { enabled }
    })
  }

  async listBackupItems(
    vaultId: string,
    backupId: string
  ): Promise<CloudBackupSnapshotItemCollection> {
    return this.http.request({
      method: 'GET',
      path: `${this.backupPath(vaultId, backupId)}/items`
    })
  }

  async restoreBackupNote(
    vaultId: string,
    backupId: string,
    snapshotItemId: number,
    body: CloudBackupNoteRestoreRequest
  ): Promise<CloudBackupNoteRestoreResponse> {
    return this.http.request({
      method: 'POST',
      path: `${this.backupPath(vaultId, backupId)}/items/${encodeURIComponent(String(snapshotItemId))}/restore`,
      body
    })
  }

  async createBackup(vaultId: string, label?: string): Promise<CloudBackupSnapshotResponse> {
    return this.http.request({
      method: 'POST',
      path: `/api/v1/vaults/${encodeURIComponent(vaultId)}/backups`,
      body: label === undefined ? {} : { label }
    })
  }

  async deleteBackup(vaultId: string, backupId: string): Promise<void> {
    await this.http.request({
      method: 'DELETE',
      path: this.backupPath(vaultId, backupId)
    })
  }

  async createBackupRestore(
    vaultId: string,
    backupId: string,
    body: CloudBackupRestoreRequest
  ): Promise<CloudBackupRestoreResponse> {
    return this.http.request({
      method: 'POST',
      path: `${this.backupPath(vaultId, backupId)}/restores`,
      body
    })
  }

  async backupRestore(
    vaultId: string,
    backupId: string,
    restoreId: string
  ): Promise<CloudBackupRestoreResponse> {
    return this.http.request({
      method: 'GET',
      path: `${this.backupPath(vaultId, backupId)}/restores/${encodeURIComponent(restoreId)}`
    })
  }

  backupDownloadPath(vaultId: string, backupId: string): string {
    return `${this.backupPath(vaultId, backupId)}/download`
  }

  private backupPath(vaultId: string, backupId: string): string {
    return `/api/v1/vaults/${encodeURIComponent(vaultId)}/backups/${encodeURIComponent(backupId)}`
  }

  private uploadPath(vaultId: string, uploadId: string): string {
    return `/api/v1/vaults/${encodeURIComponent(vaultId)}/uploads/${encodeURIComponent(uploadId)}`
  }
}

function publishedNoteBody(input: CloudPublishNoteInput): { payload: string } | FormData {
  const { assets = [], appearance, ...note } = input
  const brandLogo = appearance?.logo
  const serializedAppearance =
    appearance === undefined
      ? undefined
      : {
          theme: appearance.theme,
          logo_action:
            appearance.logo === undefined ? 'keep' : appearance.logo === null ? 'remove' : 'replace'
        }
  const payload = JSON.stringify({
    ...note,
    ...(serializedAppearance === undefined ? {} : { appearance: serializedAppearance }),
    tikz_svgs: [],
    asset_refs: assets.map((asset) => asset.ref)
  })
  if (assets.length === 0 && (brandLogo === undefined || brandLogo === null)) {
    return { payload }
  }

  const form = new FormData()
  form.append('payload', payload)
  for (const asset of assets) {
    const bytes = Uint8Array.from(atob(asset.base64), (character) => character.charCodeAt(0))
    form.append('assets[]', new Blob([bytes], { type: asset.mime }), asset.name)
  }
  if (brandLogo !== undefined && brandLogo !== null) {
    const bytes = Uint8Array.from(atob(brandLogo.base64), (character) => character.charCodeAt(0))
    form.append('brand_logo', new Blob([bytes], { type: brandLogo.mime }), brandLogo.name)
  }
  return form
}

function encodeQuery(values: Record<string, boolean | number | string | undefined>): string {
  const entries = Object.entries(values).filter((entry): entry is [string, boolean | number | string] =>
    ['boolean', 'number', 'string'].includes(typeof entry[1])
  )
  if (entries.length === 0) return ''
  return `?${entries.map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`).join('&')}`
}
