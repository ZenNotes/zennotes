import type {
  CloudBackupItemsQuery,
  CloudBackupSnapshotItem,
  CloudEncryptionKeyset,
  CloudEncryptionKeysetCreate,
  CloudEncryptionKeysetResponse,
  CloudEncryptionKeysetUpdate,
  CloudBackupNoteRestoreRequest,
  CloudBackupNoteRestoreResponse,
  CloudBackupRestoreRequest,
  CloudBackupRestoreResponse,
  CloudBackupScheduleResponse,
  CloudBackupSnapshotCollection,
  CloudBackupSnapshotItemCollection,
  CloudBackupSnapshotResponse,
  CloudPublishAppearanceInput,
  CloudPublishedNoteCollection,
  CloudPublishedNoteResult,
  CloudPublishEncodedAsset,
  CloudPublishUploadRequest,
  CloudPublishUploadResponse,
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
import type { CloudKeysetApi } from './cloud-e2ee-account'
import { cloudProtocolError } from './cloud-error-copy'
import {
  CLOUD_E2EE_HEADER,
  CLOUD_E2EE_HEADER_VALUE,
  CloudVaultCipher,
  ENCRYPTED_VAULT_PLACEHOLDER_NAME,
  type CloudVaultCipherSource,
  withoutClientHints
} from './cloud-e2ee-vault'

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

/** The note a publish sends, without its attachments. */
export interface CloudPublishNoteFields {
  note_path: string
  title: string
  markdown: string
  appearance?: CloudPublishAppearanceInput
}

/**
 * A publish as sent to the service: the attachments either ride inside the
 * request (multipart, the one-request path) or were staged ahead of it and are
 * named by the upload's id.
 */
export type CloudPublishRequest =
  | (CloudPublishNoteFields & { assets?: CloudPublishEncodedAsset[] })
  | (CloudPublishNoteFields & { upload_id: string; asset_refs: string[] })

export interface CloudSyncHttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  body?: unknown
  timeoutMs?: number
  signal?: AbortSignal
  /** Only for explicitly idempotent JSON operations with stable operation/session IDs.
   * GETs are replayable by default. Other requests are never retried implicitly.
   * A replayable request is also sent again after a transport failure where the
   * host opts in (CloudSyncRateLimitOptions.transportRetryDelaysMs). */
  retryOnRateLimit?: boolean
  /** False where the service may still be working on a request that got no
   * answer, so sending it again would race the first attempt. */
  retryOnTransportFailure?: boolean
  /** Extra request headers; transports forward them. */
  headers?: Record<string, string>
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
  /**
   * The host decrypts every path an encrypted vault's bytes can take,
   * including its streamed uploads and downloads. Only then does the client
   * tell the service it may serve encrypted vaults (docs/specs/cloud-e2ee.md).
   */
  endToEndEncryption?: boolean
  /** Required with endToEndEncryption: where each vault's cipher comes from. */
  vaultCiphers?: CloudVaultCipherSource
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
    if (options.endToEndEncryption && !options.vaultCiphers) {
      throw new Error('End-to-end encryption needs a source of vault ciphers.')
    }
  }

  /** Every request goes through here, so the encryption header is never forgotten. */
  private send<Response>(request: CloudSyncHttpRequest): Promise<Response> {
    if (!this.options.endToEndEncryption) return this.http.request<Response>(request)
    return this.http.request<Response>({
      ...request,
      headers: { ...request.headers, [CLOUD_E2EE_HEADER]: CLOUD_E2EE_HEADER_VALUE }
    })
  }

  /**
   * The cipher for an encrypted vault, or null for a readable one. Throws when
   * the vault is encrypted and this device is locked, before any request.
   */
  protected async vaultCipher(vaultId: string): Promise<CloudVaultCipher | null> {
    if (!this.options.endToEndEncryption || !this.options.vaultCiphers) return null
    return this.options.vaultCiphers.forVault(vaultId)
  }

  async listVaults(): Promise<CloudSyncVaultCollection> {
    return this.send({ method: 'GET', path: '/api/v1/vaults' })
  }

  async account(): Promise<CloudServiceAccountResponse> {
    const response = await this.send<CloudServiceAccountResponse>({ method: 'GET', path: '/api/v1/account' })
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
      throw cloudProtocolError('This Cloud server needs content-reference support before this streaming host can sync.')
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
      if (options.contentMode || (this.options.contentReferences && !metadataOnly)) throw cloudProtocolError('Negotiate Cloud content references before using the reference protocol.')
      return {}
    }
    const inline = options.maxInlineBytes ?? this.options.maxInlineBytes ?? 262_144
    const response = options.maxResponseBytes ?? Math.max(65_536, Math.min(this.bootstrapContentPageBytes ?? 16_777_216, 33_554_432))
    if (!Number.isInteger(inline) || inline < 0 || inline > 1_048_576 ||
        !Number.isInteger(response) || response < 65_536 || response > 33_554_432) {
      throw cloudProtocolError('Invalid Cloud content response budgets.')
    }
    return { content_mode: 'references', max_inline_bytes: inline, max_response_bytes: response }
  }

  async createVault(name: string): Promise<CloudSyncVaultResponse> {
    return this.send({
      method: 'POST',
      path: '/api/v1/vaults',
      body: { name }
    })
  }

  /** Creates an end-to-end encrypted vault: a fresh vault key sealed under the account key, and the real name sealed. */
  async createEncryptedVault(
    name: string,
    accountKey: Uint8Array,
    accountKeyVersion: number
  ): Promise<CloudSyncVaultResponse> {
    if (!this.options.endToEndEncryption) throw new Error("This version of ZenNotes can't use end-to-end encryption. Update ZenNotes to the latest version.")
    return this.send({
      method: 'POST',
      path: '/api/v1/vaults',
      body: {
        name: ENCRYPTED_VAULT_PLACEHOLDER_NAME,
        encryption: await CloudVaultCipher.prepareVault(name, accountKey, accountKeyVersion)
      }
    })
  }

  /** Points a readable vault at the encrypted vault that replaces it; the service then deletes it. */
  async supersedeVault(vaultId: string, successorVaultId: string): Promise<void> {
    await this.send({
      method: 'POST',
      path: `/api/v1/vaults/${encodeURIComponent(vaultId)}/supersede`,
      body: { successor_vault_id: successorVaultId }
    })
  }

  async getKeyset(): Promise<CloudEncryptionKeyset | null> {
    try {
      return (await this.send<CloudEncryptionKeysetResponse>({ method: 'GET', path: '/api/v1/encryption/keyset' })).data
    } catch (error) {
      const failure = error as { status?: number; code?: string | null }
      if (failure.status === 404 || failure.code === 'KEYSET_NOT_FOUND') return null
      throw error
    }
  }

  async createKeyset(body: CloudEncryptionKeysetCreate): Promise<CloudEncryptionKeyset> {
    return (await this.send<CloudEncryptionKeysetResponse>({ method: 'POST', path: '/api/v1/encryption/keyset', body })).data
  }

  async updateKeyset(body: CloudEncryptionKeysetUpdate): Promise<CloudEncryptionKeyset> {
    return (await this.send<CloudEncryptionKeysetResponse>({ method: 'PUT', path: '/api/v1/encryption/keyset', body })).data
  }

  /** The keyset calls in the shape the account functions take. */
  keysetApi(): CloudKeysetApi {
    return {
      getKeyset: () => this.getKeyset(),
      createKeyset: (body) => this.createKeyset(body),
      updateKeyset: (body) => this.updateKeyset(body)
    }
  }

  async deleteVault(vaultId: string): Promise<void> {
    await this.send({
      method: 'DELETE',
      path: `/api/v1/vaults/${encodeURIComponent(vaultId)}`
    })
  }

  async listPublishedNotes(): Promise<CloudPublishedNoteCollection> {
    return this.send({ method: 'GET', path: '/api/v1/shares' })
  }

  async publishNote(input: CloudPublishRequest): Promise<CloudPublishedNoteResult> {
    return this.send({
      method: 'POST',
      path: '/api/v1/shares',
      body: publishedNoteBody(input),
      timeoutMs: 300_000
    })
  }

  /** Stage a publish's attachments: answers one presigned PUT per file, or 404
   * where the service has no staged uploads. */
  async createPublishUpload(body: CloudPublishUploadRequest): Promise<CloudPublishUploadResponse> {
    return this.send({ method: 'POST', path: '/api/v1/shares/uploads', body })
  }

  async abortPublishUpload(uploadId: string): Promise<void> {
    await this.send({
      method: 'DELETE',
      path: `/api/v1/shares/uploads/${encodeURIComponent(uploadId)}`
    })
  }

  async updatePublishedNote(
    shareId: number,
    input: CloudPublishRequest
  ): Promise<CloudPublishedNoteResult> {
    return this.send({
      method: 'PUT',
      path: `/api/v1/shares/${encodeURIComponent(String(shareId))}`,
      body: publishedNoteBody(input),
      timeoutMs: 300_000
    })
  }

  async unpublishNote(shareId: number): Promise<void> {
    await this.send({
      method: 'DELETE',
      path: `/api/v1/shares/${encodeURIComponent(String(shareId))}`
    })
  }

  async manifest(
    vaultId: string,
    options: { includeContent?: boolean; page?: number; perPage?: number } & CloudSyncContentRequestOptions = {}
  ): Promise<CloudSyncManifestResponse> {
    const cipher = await this.vaultCipher(vaultId)
    const query = encodeQuery({
      include_content: options.includeContent,
      page: options.page,
      per_page: options.perPage,
      ...this.contentQuery(options, options.includeContent === false)
    })
    const response = await this.send<CloudSyncManifestResponse>({
      method: 'GET',
      path: `/api/v1/vaults/${encodeURIComponent(vaultId)}/manifest${query}`
    })
    if (!cipher) return response
    return { ...response, data: await Promise.all(response.data.map((item) => cipher.openManifestItem(item))) }
  }

  async changes(vaultId: string, after: number, limit = 100, options: CloudSyncContentRequestOptions = {}): Promise<CloudSyncChangeResponse> {
    const cipher = await this.vaultCipher(vaultId)
    const response = await this.send<CloudSyncChangeResponse>({
      method: 'GET',
      path: `/api/v1/vaults/${encodeURIComponent(vaultId)}/changes${encodeQuery({ after, limit, ...this.contentQuery(options) })}`
    })
    if (!cipher) return response
    return { ...response, data: await Promise.all(response.data.map((change) => cipher.openChange(change))) }
  }

  async revision(
    vaultId: string,
    itemId: string,
    revision: number,
    options: CloudSyncContentRequestOptions = {}
  ): Promise<CloudSyncRevisionResponse> {
    const cipher = await this.vaultCipher(vaultId)
    const response = await this.send<CloudSyncRevisionResponse>({
      method: 'GET',
      path: `/api/v1/vaults/${encodeURIComponent(vaultId)}/items/${encodeURIComponent(itemId)}/revisions/${encodeURIComponent(String(revision))}${encodeQuery(this.contentQuery(options))}`
    })
    return cipher ? { ...response, data: await cipher.openRevision(response.data) } : response
  }

  /** The coordinator asks for this before staging an `encrypted` reference. */
  async contentDecryptor(vaultId: string): Promise<CloudVaultCipher | null> {
    return this.vaultCipher(vaultId)
  }

  async download(vaultId: string, itemId: string, revision: number): Promise<CloudSyncDownloadResponse> {
    if (!this.referencesActive) throw cloudProtocolError('Negotiate Cloud content references before downloading revisions.')
    return this.send({ method: 'GET',
      path: `/api/v1/vaults/${encodeURIComponent(vaultId)}/items/${encodeURIComponent(itemId)}/revisions/${encodeURIComponent(String(revision))}/download`
    })
  }

  async mutate(
    vaultId: string,
    body: CloudSyncMutationRequest
  ): Promise<CloudSyncMutationResponse> {
    const cipher = await this.vaultCipher(vaultId)
    const mutations = cipher
      ? await Promise.all(body.mutations.map((mutation) => cipher.encryptMutation(mutation)))
      : body.mutations.map(withoutClientHints)
    const response = await this.send<CloudSyncMutationResponse>({
      method: 'POST',
      path: `/api/v1/vaults/${encodeURIComponent(vaultId)}/mutations`,
      body: { mutations },
      ...(body.mutations.length > 0 && body.mutations.every((mutation) => mutation.operation_id)
        ? { retryOnRateLimit: true } : {})
    })
    return cipher ? cipher.openMutationResponse(response) : response
  }

  async initiateUpload(
    vaultId: string,
    body: CloudSyncUploadRequest
  ): Promise<CloudSyncUploadInitiationResponse> {
    const cipher = await this.vaultCipher(vaultId)
    if (cipher && (body.content.encoding !== 'aes-gcm' || !body.meta)) {
      // The host seals streamed uploads itself; refusing here keeps a host bug
      // from sending a readable file into an encrypted vault.
      throw cloudProtocolError('Encrypted vaults accept only encrypted uploads.')
    }
    return this.send({
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
    const cipher = await this.vaultCipher(vaultId)
    const response = await this.send<CloudSyncUploadCompletionResponse>({
      method: 'POST',
      path: `${this.uploadPath(vaultId, uploadId)}/complete`,
      timeoutMs: 300_000,
      // The service hashes the whole object before it answers; a second
      // completion sent while that runs is refused. Hosts retry it themselves.
      retryOnTransportFailure: false,
      ...(uploadId ? { retryOnRateLimit: true } : {})
    })
    if (!cipher) return response
    return { data: { ...response.data, result: await cipher.openMutationResponse(response.data.result) } }
  }

  async abortUpload(vaultId: string, uploadId: string): Promise<void> {
    await this.send({
      method: 'DELETE',
      path: this.uploadPath(vaultId, uploadId)
    })
  }

  async listBackups(vaultId: string): Promise<CloudBackupSnapshotCollection> {
    return this.send({
      method: 'GET',
      path: `/api/v1/vaults/${encodeURIComponent(vaultId)}/backups`
    })
  }

  async backupSchedule(vaultId: string): Promise<CloudBackupScheduleResponse> {
    return this.send({
      method: 'GET',
      path: `/api/v1/vaults/${encodeURIComponent(vaultId)}/backup-schedule`
    })
  }

  async updateBackupSchedule(
    vaultId: string,
    enabled: boolean
  ): Promise<CloudBackupScheduleResponse> {
    return this.send({
      method: 'PUT',
      path: `/api/v1/vaults/${encodeURIComponent(vaultId)}/backup-schedule`,
      body: { enabled }
    })
  }

  async listBackupItems(
    vaultId: string,
    backupId: string,
    query: CloudBackupItemsQuery = {}
  ): Promise<CloudBackupSnapshotItemCollection> {
    const search = query.search?.trim()
    const cipher = await this.vaultCipher(vaultId)
    const page = (number: number | undefined, text: string | undefined, perPage?: number) =>
      this.send<CloudBackupSnapshotItemCollection>({
        method: 'GET',
        path: `${this.backupPath(vaultId, backupId)}/items${encodeQuery({ page: number, per_page: perPage, search: text || undefined })}`
      })
    if (!cipher) return page(query.page, search)

    const open = (items: CloudBackupSnapshotItem[]) => Promise.all(items.map((item) => cipher.openBackupItem(item)))
    if (!search) {
      const response = await page(query.page, undefined)
      return { ...response, data: await open(response.data) }
    }
    // The service cannot read an encrypted vault's names, so it cannot search
    // them: read every page and search the decrypted names here.
    const needle = search.toLowerCase()
    const matches: CloudBackupSnapshotItem[] = []
    // The service pages an encrypted backup up to 500 items at a time, so a
    // search reads a large backup without running into the sync rate limit.
    for (let number = 1, last = 1; number <= last; number++) {
      const response = await page(number, undefined, 500)
      matches.push(...(await open(response.data)).filter((item) => item.path.toLowerCase().includes(needle)))
      last = response.meta?.last_page ?? 1
    }
    return { data: matches, meta: { current_page: 1, last_page: 1, per_page: Math.max(matches.length, 1), total: matches.length } }
  }

  async restoreBackupNote(
    vaultId: string,
    backupId: string,
    snapshotItemId: number,
    body: CloudBackupNoteRestoreRequest
  ): Promise<CloudBackupNoteRestoreResponse> {
    const cipher = await this.vaultCipher(vaultId)
    const response = await this.send<CloudBackupNoteRestoreResponse>({
      method: 'POST',
      path: `${this.backupPath(vaultId, backupId)}/items/${encodeURIComponent(String(snapshotItemId))}/restore`,
      body
    })
    return cipher ? { data: await cipher.openNoteRestore(response.data) } : response
  }

  async createBackup(vaultId: string, label?: string): Promise<CloudBackupSnapshotResponse> {
    return this.send({
      method: 'POST',
      path: `/api/v1/vaults/${encodeURIComponent(vaultId)}/backups`,
      body: label === undefined ? {} : { label }
    })
  }

  async deleteBackup(vaultId: string, backupId: string): Promise<void> {
    await this.send({
      method: 'DELETE',
      path: this.backupPath(vaultId, backupId)
    })
  }

  async createBackupRestore(
    vaultId: string,
    backupId: string,
    body: CloudBackupRestoreRequest
  ): Promise<CloudBackupRestoreResponse> {
    return this.send({
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
    return this.send({
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

function publishedNoteBody(input: CloudPublishRequest): { payload: string } | FormData {
  if ('upload_id' in input) {
    // The files are already in storage; the publish names them and their upload.
    const { upload_id, asset_refs, appearance, ...note } = input
    if (appearance?.logo) throw cloudProtocolError('A staged publish cannot replace the logo.')
    return {
      payload: JSON.stringify({
        ...note,
        ...(appearance === undefined
          ? {}
          : { appearance: { theme: appearance.theme, logo_action: appearance.logo === null ? 'remove' : 'keep' } }),
        tikz_svgs: [],
        asset_refs,
        upload_id
      })
    }
  }

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
