/**
 * HTTP client for a self-hosted ZenNotes server, the mobile counterpart of
 * `apps/desktop/src/main/remote/server-client.ts`. Endpoint strings and
 * request/response shapes are kept in sync with that file (there is no shared
 * client module upstream; desktop and web each carry their own copy).
 *
 * Every request goes through the host's HTTP, on the phones CapacitorHttp
 * (native URLSession), not webview fetch: native requests carry no Origin and are outside CORS, so the server
 * needs no ZENNOTES_ALLOWED_ORIGINS entry for the app, and the Bearer header
 * works for binary asset fetches too (an <img> tag could never send it).
 */
import { portableHost, type HttpTransportResponse as HttpResponse } from './host'
import type {
  AssetMeta,
  DeletedAsset,
  DirectoryBrowseResult,
  FolderEntry,
  NoteComment,
  NoteCommentInput,
  NoteContent,
  NoteFolder,
  NoteMeta,
  ServerCapabilities,
  VaultDemoTourResult,
  VaultInfo,
  VaultSettings,
  VaultTextSearchMatch
} from '@zennotes/shared-domain/ipc'
import type { VaultTask } from '@zennotes/shared-domain/tasks'
import { importedAssetFilename } from './imported-assets'

export interface RemoteClientOptions {
  baseUrl: string
  authToken?: string | null
}

const TIMEOUT_MS = 15000

export interface AssetUploadRequest {
  url: string
  fileName: string
  base64Data: string
  targetDir?: string
}

/**
 * The multipart upload for an attachment.
 *
 * This used to hand-build the body as one string, with the file part carrying
 * `Content-Transfer-Encoding: base64` and the base64 text as its content. That
 * header is a MIME construct: RFC 7578 dropped it from multipart/form-data, and
 * Go's `mime/multipart` (what the server parses with) does not honour it. The
 * server therefore wrote the base64 TEXT to disk as the file's bytes, so an
 * attachment arrived in `assets/` with the right name, about a third larger
 * than the original, and unreadable by anything (zennotesandroid#40; this app
 * carries the same client).
 *
 * The bytes have to stay base64 to cross the native bridge at all, since a
 * CapacitorHttp string body is written out as UTF-8 and would mangle anything
 * above 0x7F. `dataType: 'formData'` is the supported way through: both native
 * layers decode a `base64File` entry and write the raw bytes into the part
 * (Android `CapacitorHttpUrlConnection.writeFormDataRequestBody`, iOS
 * `CapacitorUrlRequest.getRequestDataFromFormData`), which is what the server
 * expects. The sibling direct-object upload already used the same mechanism
 * with `dataType: 'file'`.
 */
export function assetUploadOptions(request: AssetUploadRequest) {
  // Both native layers reuse the boundary from the header when it carries one,
  // so the body and the header cannot disagree.
  const boundary = `----ZenNotesUpload${Date.now().toString(16)}`
  return {
    url: request.url,
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    dataType: 'formData' as const,
    data: [
      { type: 'string', key: 'dir', value: request.targetDir ?? '' },
      {
        type: 'base64File',
        key: 'file',
        // Capacitor inserts this value directly into Content-Disposition on
        // both native platforms, so use the same safe name written to disk.
        fileName: importedAssetFilename(request.fileName),
        contentType: 'application/octet-stream',
        value: request.base64Data
      }
    ],
    connectTimeout: TIMEOUT_MS,
    readTimeout: TIMEOUT_MS
  }
}

/**
 * An HTTP answer outside 2xx, carrying the status the server actually sent.
 * Transport failures (no answer at all) stay plain Errors: the distinction is
 * load-bearing for the absence-aware database reader in remote-vault.ts,
 * which must never read "the request never arrived" as "the file is absent".
 */
export class RemoteRequestError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'RemoteRequestError'
    this.status = status
  }
}

/**
 * Transport-level failure message. iOS drops connections to local-network
 * hosts until the user grants the Local Network permission (the app declares
 * NSLocalNetworkUsageDescription so the prompt appears on first use), and a
 * denied prompt looks exactly like a server that is down, so the message says
 * where to turn it back on.
 */
export function connectionErrorMessage(baseUrl: string, error: unknown): string {
  const detail =
    error instanceof Error && error.message ? ` Could not reach the server: ${error.message}.` : ''
  return (
    `Could not connect to the ZenNotes server at ${baseUrl}. ` +
    `Make sure the server is running and the URL is correct.${detail}` +
    ` If the server is on your local network (e.g. your Mac), check that ZenNotes` +
    ` is allowed under Settings → Privacy & Security → Local Network.`
  )
}

export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim()
  const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  return normalized.replace(/\/+$/, '')
}

export class RemoteClient {
  readonly baseUrl: string
  readonly authToken: string | null

  constructor(options: RemoteClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl)
    this.authToken = options.authToken?.trim() || null
  }

  async getCapabilities(): Promise<ServerCapabilities> {
    return this.jsonRequest<ServerCapabilities>('GET', '/api/capabilities')
  }

  async getCurrentVault(): Promise<VaultInfo | null> {
    return this.jsonRequest<VaultInfo | null>('GET', '/api/vault')
  }

  async getVaultSettings(): Promise<VaultSettings> {
    return this.jsonRequest<VaultSettings>('GET', '/api/vault/settings')
  }

  async setVaultSettings(next: VaultSettings): Promise<VaultSettings> {
    return this.jsonRequest<VaultSettings>('POST', '/api/vault/settings', next)
  }

  async selectVaultPath(path: string): Promise<VaultInfo> {
    return this.jsonRequest<VaultInfo>('POST', '/api/vault/select', { path })
  }

  async browseDirectories(path = ''): Promise<DirectoryBrowseResult> {
    const query = path ? `?path=${encodeURIComponent(path)}` : ''
    return this.jsonRequest<DirectoryBrowseResult>('GET', `/api/fs/browse${query}`)
  }

  async listNotes(): Promise<NoteMeta[]> {
    return this.jsonRequest<NoteMeta[]>('GET', '/api/notes')
  }

  async listFolders(): Promise<FolderEntry[]> {
    return this.jsonRequest<FolderEntry[]>('GET', '/api/folders')
  }

  async listAssets(): Promise<AssetMeta[]> {
    return this.jsonRequest<AssetMeta[]>('GET', '/api/assets')
  }

  async hasAssetsDir(): Promise<boolean> {
    const resp = await this.jsonRequest<{ exists: boolean }>('GET', '/api/assets/exists')
    return resp.exists
  }

  async generateDemoTour(): Promise<VaultDemoTourResult> {
    return this.jsonRequest<VaultDemoTourResult>('POST', '/api/demo/generate')
  }

  async removeDemoTour(): Promise<VaultDemoTourResult> {
    return this.jsonRequest<VaultDemoTourResult>('POST', '/api/demo/remove')
  }

  async searchVaultText(query: string): Promise<VaultTextSearchMatch[]> {
    const params = new URLSearchParams({ q: query, backend: 'auto' })
    return this.jsonRequest<VaultTextSearchMatch[]>('GET', `/api/search/text?${params.toString()}`)
  }

  async readNote(relPath: string): Promise<NoteContent> {
    return this.jsonRequest<NoteContent>(
      'GET',
      `/api/notes/read?path=${encodeURIComponent(relPath)}`
    )
  }

  async readNoteComments(relPath: string): Promise<NoteComment[]> {
    return this.jsonRequest<NoteComment[]>(
      'GET',
      `/api/comments/read?path=${encodeURIComponent(relPath)}`
    )
  }

  async writeNoteComments(relPath: string, comments: NoteCommentInput[]): Promise<NoteComment[]> {
    return this.jsonRequest<NoteComment[]>('POST', '/api/comments/write', {
      path: relPath,
      comments
    })
  }

  async scanTasks(): Promise<VaultTask[]> {
    return this.jsonRequest<VaultTask[]>('GET', '/api/tasks')
  }

  async scanTasksForPath(relPath: string): Promise<VaultTask[]> {
    return this.jsonRequest<VaultTask[]>(
      'GET',
      `/api/tasks/for?path=${encodeURIComponent(relPath)}`
    )
  }

  async writeNote(relPath: string, body: string): Promise<NoteMeta> {
    return this.jsonRequest<NoteMeta>('POST', '/api/notes/write', { path: relPath, body })
  }

  async createNote(folder: NoteFolder, title?: string, subpath = ''): Promise<NoteMeta> {
    return this.jsonRequest<NoteMeta>('POST', '/api/notes/create', { folder, title, subpath })
  }

  async createExcalidraw(folder: NoteFolder, subpath = '', title?: string): Promise<NoteMeta> {
    return this.jsonRequest<NoteMeta>('POST', '/api/excalidraw/create', { folder, subpath, title })
  }

  async renameNote(relPath: string, nextTitle: string): Promise<NoteMeta> {
    return this.jsonRequest<NoteMeta>('POST', '/api/notes/rename', {
      path: relPath,
      title: nextTitle
    })
  }

  async deleteNote(relPath: string): Promise<void> {
    await this.jsonRequest<void>('POST', '/api/notes/delete', { path: relPath })
  }

  async moveToTrash(relPath: string): Promise<NoteMeta> {
    return this.jsonRequest<NoteMeta>('POST', '/api/notes/trash', { path: relPath })
  }

  async restoreFromTrash(relPath: string): Promise<NoteMeta> {
    return this.jsonRequest<NoteMeta>('POST', '/api/notes/restore', { path: relPath })
  }

  async emptyTrash(): Promise<void> {
    await this.jsonRequest<void>('POST', '/api/notes/empty-trash')
  }

  async archiveNote(relPath: string): Promise<NoteMeta> {
    return this.jsonRequest<NoteMeta>('POST', '/api/notes/archive', { path: relPath })
  }

  async unarchiveNote(relPath: string): Promise<NoteMeta> {
    return this.jsonRequest<NoteMeta>('POST', '/api/notes/unarchive', { path: relPath })
  }

  async duplicateNote(relPath: string): Promise<NoteMeta> {
    return this.jsonRequest<NoteMeta>('POST', '/api/notes/duplicate', { path: relPath })
  }

  async moveNote(
    relPath: string,
    targetFolder: NoteFolder,
    targetSubpath: string
  ): Promise<NoteMeta> {
    return this.jsonRequest<NoteMeta>('POST', '/api/notes/move', {
      path: relPath,
      targetFolder,
      targetSubpath
    })
  }

  async createFolder(folder: NoteFolder, subpath: string): Promise<void> {
    await this.jsonRequest<void>('POST', '/api/folders/create', { folder, subpath })
  }

  async renameFolder(folder: NoteFolder, oldSubpath: string, newSubpath: string): Promise<string> {
    const resp = await this.jsonRequest<{ subpath: string }>('POST', '/api/folders/rename', {
      folder,
      oldSubpath,
      newSubpath
    })
    return resp.subpath
  }

  async deleteFolder(folder: NoteFolder, subpath: string): Promise<void> {
    await this.jsonRequest<void>('POST', '/api/folders/delete', { folder, subpath })
  }

  async duplicateFolder(folder: NoteFolder, subpath: string): Promise<string> {
    const resp = await this.jsonRequest<{ subpath: string }>('POST', '/api/folders/duplicate', {
      folder,
      subpath
    })
    return resp.subpath
  }

  async renameAsset(relPath: string, nextName: string): Promise<AssetMeta> {
    return this.jsonRequest<AssetMeta>('POST', '/api/assets/rename', {
      path: relPath,
      name: nextName
    })
  }

  async moveAsset(relPath: string, targetDir: string): Promise<AssetMeta> {
    return this.jsonRequest<AssetMeta>('POST', '/api/assets/move', {
      path: relPath,
      targetDir
    })
  }

  // The asset-mutation family the server grew in 2.24, including its
  // deleted-assets store. Gated by ServerCapabilities.supportsAssetOps at the
  // call site (RemoteVault): an older server answers 404 for all of these,
  // and "the route is missing" is worth saying out loud rather than showing
  // as a bare failure.

  async duplicateAsset(relPath: string): Promise<AssetMeta> {
    return this.jsonRequest<AssetMeta>('POST', '/api/assets/duplicate', { path: relPath })
  }

  async deleteAsset(relPath: string): Promise<DeletedAsset> {
    return this.jsonRequest<DeletedAsset>('POST', '/api/assets/delete', { path: relPath })
  }

  async listDeletedAssets(): Promise<DeletedAsset[]> {
    return this.jsonRequest<DeletedAsset[]>('GET', '/api/assets/deleted')
  }

  async restoreDeletedAsset(deleted: DeletedAsset): Promise<AssetMeta> {
    return this.jsonRequest<AssetMeta>('POST', '/api/assets/restore', deleted)
  }

  async purgeDeletedAsset(undoToken: string): Promise<void> {
    await this.jsonRequest<void>('POST', '/api/assets/purge', { undoToken })
  }

  async emptyDeletedAssets(): Promise<void> {
    await this.jsonRequest<void>('POST', '/api/assets/empty-deleted')
  }

  /** Raw asset bytes as base64 (native request, the Bearer header works). */
  async fetchAssetBase64(assetPath: string): Promise<{ base64: string; mimeType: string }> {
    let response: HttpResponse
    try {
      response = await portableHost().http.request({
        method: 'GET',
        url: `${this.baseUrl}/api/assets/raw?path=${encodeURIComponent(assetPath)}`,
        headers: this.headers(),
        responseType: 'blob',
        connectTimeout: TIMEOUT_MS,
        readTimeout: TIMEOUT_MS
      })
    } catch (error) {
      throw new Error(connectionErrorMessage(this.baseUrl, error))
    }
    if (response.status < 200 || response.status >= 300 || typeof response.data !== 'string') {
      throw new Error(`Remote asset request failed (${response.status}) for ${assetPath}`)
    }
    const contentType =
      (response.headers?.['Content-Type'] ?? response.headers?.['content-type'] ?? '')
        .split(';')[0]
        .trim() || 'application/octet-stream'
    return { base64: response.data, mimeType: contentType }
  }

  async uploadAsset(fileName: string, base64Data: string, targetDir = ''): Promise<AssetMeta> {
    const options = assetUploadOptions({
      url: `${this.baseUrl}/api/assets/upload`,
      fileName,
      base64Data,
      targetDir
    })
    let response: HttpResponse
    try {
      response = await portableHost().http.request({
        method: 'POST',
        ...options,
        headers: { ...this.headers(), ...options.headers }
      })
    } catch (error) {
      throw new Error(connectionErrorMessage(this.baseUrl, error))
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Asset upload failed (${response.status}) for ${fileName}`)
    }
    return (
      typeof response.data === 'string' ? JSON.parse(response.data) : response.data
    ) as AssetMeta
  }

  private headers(): Record<string, string> {
    return this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {}
  }

  private async jsonRequest<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let response: HttpResponse
    try {
      response = await portableHost().http.request({
        url: `${this.baseUrl}${path}`,
        method,
        headers: {
          ...this.headers(),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
        },
        data: body,
        connectTimeout: TIMEOUT_MS,
        readTimeout: TIMEOUT_MS
      })
    } catch (error) {
      throw new Error(connectionErrorMessage(this.baseUrl, error))
    }
    if (response.status === 401) {
      throw new RemoteRequestError(
        `The ZenNotes server rejected the connection. Check the auth token for ${this.baseUrl} and try again.`,
        response.status
      )
    }
    if (response.status < 200 || response.status >= 300) {
      const text = typeof response.data === 'string' ? response.data : ''
      throw new RemoteRequestError(
        `Remote server request failed (${response.status}) for ${path}${text ? `: ${text}` : ''}`,
        response.status
      )
    }
    if (response.status === 204 || response.data === undefined || response.data === '') {
      return undefined as T
    }
    return (
      typeof response.data === 'string' ? JSON.parse(response.data) : response.data
    ) as T
  }
}
