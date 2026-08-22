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
  CloudSyncManifestResponse,
  CloudSyncMutationRequest,
  CloudSyncMutationResponse,
  CloudSyncUploadCompletionResponse,
  CloudSyncUploadInitiationResponse,
  CloudSyncUploadRequest,
  CloudSyncVaultCollection,
  CloudSyncVaultResponse
} from '@zennotes/bridge-contract/cloud-sync'

export interface CloudSyncHttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  body?: unknown
  timeoutMs?: number
}

export interface CloudSyncHttpTransport {
  request<Response>(request: CloudSyncHttpRequest): Promise<Response>
}

/** Typed API surface shared by Electron and both Capacitor shells. */
export class CloudSyncApiClient {
  constructor(private readonly http: CloudSyncHttpTransport) {}

  async listVaults(): Promise<CloudSyncVaultCollection> {
    return this.http.request({ method: 'GET', path: '/api/v1/vaults' })
  }

  async account(): Promise<CloudServiceAccountResponse> {
    return this.http.request({ method: 'GET', path: '/api/v1/account' })
  }

  async createVault(name: string): Promise<CloudSyncVaultResponse> {
    return this.http.request({ method: 'POST', path: '/api/v1/vaults', body: { name } })
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
      body: publishedNoteBody(input)
    })
  }

  async updatePublishedNote(
    shareId: number,
    input: CloudPublishNoteInput
  ): Promise<CloudPublishedNoteResult> {
    return this.http.request({
      method: 'PUT',
      path: `/api/v1/shares/${encodeURIComponent(String(shareId))}`,
      body: publishedNoteBody(input)
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
    options: { includeContent?: boolean; page?: number; perPage?: number } = {}
  ): Promise<CloudSyncManifestResponse> {
    const query = encodeQuery({
      include_content: options.includeContent,
      page: options.page,
      per_page: options.perPage
    })
    return this.http.request({
      method: 'GET',
      path: `/api/v1/vaults/${encodeURIComponent(vaultId)}/manifest${query}`
    })
  }

  async changes(
    vaultId: string,
    after: number,
    limit = 100
  ): Promise<CloudSyncChangeResponse> {
    return this.http.request({
      method: 'GET',
      path: `/api/v1/vaults/${encodeURIComponent(vaultId)}/changes${encodeQuery({ after, limit })}`
    })
  }

  async mutate(
    vaultId: string,
    body: CloudSyncMutationRequest
  ): Promise<CloudSyncMutationResponse> {
    return this.http.request({
      method: 'POST',
      path: `/api/v1/vaults/${encodeURIComponent(vaultId)}/mutations`,
      body
    })
  }

  async initiateUpload(
    vaultId: string,
    body: CloudSyncUploadRequest
  ): Promise<CloudSyncUploadInitiationResponse> {
    return this.http.request({
      method: 'POST',
      path: `/api/v1/vaults/${encodeURIComponent(vaultId)}/uploads`,
      body
    })
  }

  async completeUpload(
    vaultId: string,
    uploadId: string
  ): Promise<CloudSyncUploadCompletionResponse> {
    return this.http.request({
      method: 'POST',
      path: `${this.uploadPath(vaultId, uploadId)}/complete`,
      timeoutMs: 300_000
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
  const serializedAppearance = appearance === undefined
    ? undefined
    : {
        theme: appearance.theme,
        logo_action: appearance.logo === undefined
          ? 'keep'
          : appearance.logo === null
            ? 'remove'
            : 'replace'
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

function encodeQuery(values: Record<string, boolean | number | undefined>): string {
  const entries = Object.entries(values).filter((entry): entry is [string, boolean | number] =>
    ['boolean', 'number'].includes(typeof entry[1])
  )
  if (entries.length === 0) return ''
  return `?${entries.map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`).join('&')}`
}
