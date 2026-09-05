import type {
  AssetMeta,
  DeletedAsset,
  DirectoryBrowseResult,
  FolderEntry,
  ImportedAsset,
  NoteComment,
  NoteCommentInput,
  NoteContent,
  NoteFolder,
  NoteMeta,
  ServerCapabilities,
  VaultChangeEvent,
  VaultDemoTourResult,
  VaultInfo,
  VaultSettings,
  VaultTextSearchBackendPreference,
  VaultTextSearchCapabilities,
  VaultTextSearchMatch,
  VaultTextSearchToolPaths
} from '@shared/ipc'
import type { VaultTask } from '@shared/tasks'
import type {
  CustomTemplateFile,
  WriteTemplateInput
} from '@zennotes/bridge-contract/templates'
import WebSocket from 'ws'
import {
  connectionErrorMessage,
  normalizeBaseUrl,
  requestErrorMessage
} from './connection'

export interface RemoteServerClientOptions {
  baseUrl: string
  authToken?: string | null
  /**
   * Called with the vault-relative path when the server answers 404 to a
   * request about it. The list this app shows is behind the server, so the
   * host re-pulls it (see `stalePathMessage`).
   */
  onStalePath?: (path: string) => void
}

type JsonRequestInit = Omit<RequestInit, 'body'> & { body?: unknown }

// Re-exported for the callers that grew up importing it from here.
export { connectionErrorMessage }

/** The server never answered: DNS/refused/timeout. The workspace may be
 *  fine; the network is not. Callers must never read this as "absent". */
import type {
  ApplyWorkflowInput,
  WorkflowFile,
  WorkflowRunReceipt,
  WorkflowRunSummary,
  WorkflowUndoResult,
  WriteWorkflowInput
} from '@zennotes/bridge-contract/workflows'
import { prepareWorkflowRun } from '@shared/workflows/prepare-run'
import { REMOTE_CHANGE_POLL_MS, stalePathMessage } from '@shared/remote-workspace-messages'

export class RemoteConnectionError extends Error {}

/** The server answered with a non-2xx status: it is alive and made a
 *  decision. `status` lets callers separate a 404 from an auth failure. */
export class RemoteRequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

export class RemoteServerClient {
  readonly baseUrl: string
  readonly authToken: string | null
  private readonly onStalePath: ((path: string) => void) | null

  constructor(options: RemoteServerClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl)
    this.authToken = options.authToken?.trim() || null
    this.onStalePath = options.onStalePath ?? null
  }

  async getCapabilities(): Promise<ServerCapabilities> {
    return this.jsonRequest<ServerCapabilities>('/api/capabilities')
  }

  async getCurrentVault(): Promise<VaultInfo | null> {
    return this.jsonRequest<VaultInfo | null>('/api/vault')
  }

  async getVaultSettings(): Promise<VaultSettings> {
    return this.jsonRequest<VaultSettings>('/api/vault/settings')
  }

  async setVaultSettings(next: VaultSettings): Promise<VaultSettings> {
    return this.jsonRequest<VaultSettings>('/api/vault/settings', {
      method: 'POST',
      body: next
    })
  }

  async selectVaultPath(path: string): Promise<VaultInfo> {
    return this.jsonRequest<VaultInfo>('/api/vault/select', {
      method: 'POST',
      body: { path }
    })
  }

  async browseDirectories(path = ''): Promise<DirectoryBrowseResult> {
    const query = path ? `?path=${encodeURIComponent(path)}` : ''
    return this.jsonRequest<DirectoryBrowseResult>(`/api/fs/browse${query}`)
  }

  async listNotes(): Promise<NoteMeta[]> {
    return this.jsonRequest<NoteMeta[]>('/api/notes')
  }

  async listFolders(): Promise<FolderEntry[]> {
    return this.jsonRequest<FolderEntry[]>('/api/folders')
  }

  async listAssets(): Promise<AssetMeta[]> {
    return this.jsonRequest<AssetMeta[]>('/api/assets')
  }

  async hasAssetsDir(): Promise<boolean> {
    return this.jsonRequest<{ exists: boolean }>('/api/assets/exists').then((resp) => resp.exists)
  }

  async generateDemoTour(): Promise<VaultDemoTourResult> {
    return this.jsonRequest<VaultDemoTourResult>('/api/demo/generate', { method: 'POST' })
  }

  async removeDemoTour(): Promise<VaultDemoTourResult> {
    return this.jsonRequest<VaultDemoTourResult>('/api/demo/remove', { method: 'POST' })
  }

  async getVaultTextSearchCapabilities(): Promise<VaultTextSearchCapabilities> {
    return this.jsonRequest<VaultTextSearchCapabilities>('/api/search/capabilities')
  }

  async searchVaultText(
    query: string,
    backend: VaultTextSearchBackendPreference = 'auto',
    paths: VaultTextSearchToolPaths = {}
  ): Promise<VaultTextSearchMatch[]> {
    const params = new URLSearchParams({ q: query, backend })
    if (paths.ripgrepPath) params.set('ripgrepPath', paths.ripgrepPath)
    if (paths.fzfPath) params.set('fzfPath', paths.fzfPath)
    return this.jsonRequest<VaultTextSearchMatch[]>(`/api/search/text?${params.toString()}`)
  }

  /** True when the connected server advertises the journalled workflow API
   *  from #608. Older servers stay read-only, exactly like the web client. */
  async supportsWorkflows(): Promise<boolean> {
    const caps = await this.getCapabilities()
    return (caps as { supportsWorkflows?: boolean } | null)?.supportsWorkflows === true
  }

  async listWorkflows(): Promise<WorkflowFile[]> {
    return this.jsonRequest<WorkflowFile[]>('/api/workflows')
  }

  async writeWorkflow(input: WriteWorkflowInput): Promise<WorkflowFile> {
    return this.jsonRequest<WorkflowFile>('/api/workflows/write', {
      method: 'POST',
      body: input as unknown as Record<string, unknown>
    })
  }

  async deleteWorkflow(sourcePath: string): Promise<void> {
    await this.jsonRequest('/api/workflows/delete', { method: 'POST', body: { sourcePath } })
  }

  /** Prepare on this side (reads through the server), apply transactionally on
   *  the server — the same split the web bridge ships for #608. */
  async applyWorkflow(input: ApplyWorkflowInput): Promise<WorkflowRunReceipt> {
    const settings = await this.getVaultSettings()
    const prepared = await prepareWorkflowRun(input, {
      read: async (path: string) => {
        try {
          return (await this.readNote(path)).body
        } catch {
          return null
        }
      },
      systemFolderDirs: settings.systemFolderPaths ?? {}
    })
    return this.jsonRequest<WorkflowRunReceipt>('/api/workflows/apply', {
      method: 'POST',
      body: prepared as unknown as Record<string, unknown>
    })
  }

  async undoWorkflowRun(runId: string): Promise<WorkflowUndoResult> {
    return this.jsonRequest<WorkflowUndoResult>('/api/workflows/undo', {
      method: 'POST',
      body: { runId }
    })
  }

  async listWorkflowRuns(): Promise<WorkflowRunSummary[]> {
    return this.jsonRequest<WorkflowRunSummary[]>('/api/workflows/runs')
  }

  async deleteWorkflowRuns(workflowId: string): Promise<number> {
    return this.jsonRequest<number>('/api/workflows/runs/delete', {
      method: 'POST',
      body: { workflowId }
    })
  }

  async listTemplates(): Promise<CustomTemplateFile[]> {
    return this.jsonRequest<CustomTemplateFile[]>('/api/templates')
  }

  async readTemplate(sourcePath: string): Promise<string> {
    const result = await this.jsonRequest<{ raw: string }>(
      `/api/templates/read?path=${encodeURIComponent(sourcePath)}`
    )
    return result.raw
  }

  async writeTemplate(input: WriteTemplateInput): Promise<CustomTemplateFile> {
    return this.jsonRequest<CustomTemplateFile>('/api/templates/write', {
      method: 'POST',
      body: input as unknown as Record<string, unknown>
    })
  }

  async deleteTemplate(sourcePath: string): Promise<void> {
    await this.jsonRequest('/api/templates/delete', { method: 'POST', body: { sourcePath } })
  }

  async readNote(relPath: string): Promise<NoteContent> {
    return this.jsonRequest<NoteContent>(`/api/notes/read?path=${encodeURIComponent(relPath)}`)
  }

  async readNoteComments(relPath: string): Promise<NoteComment[]> {
    return this.jsonRequest<NoteComment[]>(`/api/comments/read?path=${encodeURIComponent(relPath)}`)
  }

  async writeNoteComments(
    relPath: string,
    comments: NoteCommentInput[]
  ): Promise<NoteComment[]> {
    return this.jsonRequest<NoteComment[]>('/api/comments/write', {
      method: 'POST',
      body: { path: relPath, comments }
    })
  }

  async scanTasks(): Promise<VaultTask[]> {
    return this.jsonRequest<VaultTask[]>('/api/tasks')
  }

  async scanTasksForPath(relPath: string): Promise<VaultTask[]> {
    return this.jsonRequest<VaultTask[]>(`/api/tasks/for?path=${encodeURIComponent(relPath)}`)
  }

  async writeNote(relPath: string, body: string): Promise<NoteMeta> {
    return this.jsonRequest<NoteMeta>('/api/notes/write', {
      method: 'POST',
      body: { path: relPath, body }
    })
  }

  async createNote(folder: NoteFolder, title?: string, subpath = ''): Promise<NoteMeta> {
    return this.jsonRequest<NoteMeta>('/api/notes/create', {
      method: 'POST',
      body: { folder, title, subpath }
    })
  }

  async createExcalidraw(folder: NoteFolder, subpath = '', title?: string): Promise<NoteMeta> {
    return this.jsonRequest<NoteMeta>('/api/excalidraw/create', {
      method: 'POST',
      body: { folder, subpath, title }
    })
  }

  async renameNote(relPath: string, nextTitle: string): Promise<NoteMeta> {
    return this.jsonRequest<NoteMeta>('/api/notes/rename', {
      method: 'POST',
      body: { path: relPath, title: nextTitle }
    })
  }

  async deleteNote(relPath: string): Promise<void> {
    await this.jsonRequest<void>('/api/notes/delete', {
      method: 'POST',
      body: { path: relPath }
    })
  }

  async moveToTrash(relPath: string): Promise<NoteMeta> {
    return this.jsonRequest<NoteMeta>('/api/notes/trash', {
      method: 'POST',
      body: { path: relPath }
    })
  }

  async restoreFromTrash(relPath: string): Promise<NoteMeta> {
    return this.jsonRequest<NoteMeta>('/api/notes/restore', {
      method: 'POST',
      body: { path: relPath }
    })
  }

  async emptyTrash(): Promise<void> {
    await this.jsonRequest<void>('/api/notes/empty-trash', { method: 'POST' })
  }

  async archiveNote(relPath: string): Promise<NoteMeta> {
    return this.jsonRequest<NoteMeta>('/api/notes/archive', {
      method: 'POST',
      body: { path: relPath }
    })
  }

  async unarchiveNote(relPath: string): Promise<NoteMeta> {
    return this.jsonRequest<NoteMeta>('/api/notes/unarchive', {
      method: 'POST',
      body: { path: relPath }
    })
  }

  async duplicateNote(relPath: string): Promise<NoteMeta> {
    return this.jsonRequest<NoteMeta>('/api/notes/duplicate', {
      method: 'POST',
      body: { path: relPath }
    })
  }

  async moveNote(
    relPath: string,
    targetFolder: NoteFolder,
    targetSubpath: string
  ): Promise<NoteMeta> {
    return this.jsonRequest<NoteMeta>('/api/notes/move', {
      method: 'POST',
      body: { path: relPath, targetFolder, targetSubpath }
    })
  }

  async createFolder(folder: NoteFolder, subpath: string): Promise<void> {
    await this.jsonRequest<void>('/api/folders/create', {
      method: 'POST',
      body: { folder, subpath }
    })
  }

  async renameFolder(folder: NoteFolder, oldSubpath: string, newSubpath: string): Promise<string> {
    return this.jsonRequest<{ subpath: string }>('/api/folders/rename', {
      method: 'POST',
      body: { folder, oldSubpath, newSubpath }
    }).then((resp) => resp.subpath)
  }

  async deleteFolder(folder: NoteFolder, subpath: string): Promise<void> {
    await this.jsonRequest<void>('/api/folders/delete', {
      method: 'POST',
      body: { folder, subpath }
    })
  }

  async duplicateFolder(folder: NoteFolder, subpath: string): Promise<string> {
    return this.jsonRequest<{ subpath: string }>('/api/folders/duplicate', {
      method: 'POST',
      body: { folder, subpath }
    }).then((resp) => resp.subpath)
  }

  async renameAsset(relPath: string, nextName: string): Promise<AssetMeta> {
    return this.jsonRequest<AssetMeta>('/api/assets/rename', {
      method: 'POST',
      body: { path: relPath, name: nextName }
    })
  }

  async moveAsset(relPath: string, targetDir: string): Promise<AssetMeta> {
    return this.jsonRequest<AssetMeta>('/api/assets/move', {
      method: 'POST',
      body: { path: relPath, targetDir }
    })
  }

  async duplicateAsset(relPath: string): Promise<AssetMeta> {
    return this.jsonRequest<AssetMeta>('/api/assets/duplicate', {
      method: 'POST',
      body: { path: relPath }
    })
  }

  async deleteAsset(relPath: string): Promise<DeletedAsset> {
    return this.jsonRequest<DeletedAsset>('/api/assets/delete', {
      method: 'POST',
      body: { path: relPath }
    })
  }

  async listDeletedAssets(): Promise<DeletedAsset[]> {
    return this.jsonRequest<DeletedAsset[]>('/api/assets/deleted')
  }

  async restoreDeletedAsset(deleted: DeletedAsset): Promise<AssetMeta> {
    return this.jsonRequest<AssetMeta>('/api/assets/restore', {
      method: 'POST',
      body: deleted
    })
  }

  async purgeDeletedAsset(undoToken: string): Promise<void> {
    await this.jsonRequest<void>('/api/assets/purge', {
      method: 'POST',
      body: { undoToken }
    })
  }

  async emptyDeletedAssets(): Promise<void> {
    await this.jsonRequest<void>('/api/assets/empty-deleted', { method: 'POST' })
  }

  /** Multipart, not JSON: the payload is raw file bytes, and the server
   *  reads a `file` form part plus the owning note's path. A Blob input
   *  (fs.openAsBlob) streams from disk instead of sitting in memory, which
   *  is how dropped files of any size reach a remote vault. */
  async uploadAsset(
    notePath: string,
    filename: string,
    bytes: Uint8Array | Blob,
    mimeType = 'application/octet-stream'
  ): Promise<ImportedAsset> {
    const form = new FormData()
    form.append('notePath', notePath)
    // The cast narrows ArrayBufferLike to ArrayBuffer: every byte source
    // here (structured-clone paste bytes) is plain-buffer backed, which
    // BlobPart demands but the Uint8Array generic cannot promise.
    const blob =
      bytes instanceof Blob ? bytes : new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType })
    form.append('file', blob, filename)
    const headers = new Headers()
    if (this.authToken) {
      headers.set('Authorization', `Bearer ${this.authToken}`)
    }
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/api/assets/upload`, {
        method: 'POST',
        headers,
        body: form
      })
    } catch (error) {
      throw new RemoteConnectionError(connectionErrorMessage(this.baseUrl, error))
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new RemoteRequestError(
        requestErrorMessage(this.baseUrl, '/api/assets/upload', response, text),
        response.status
      )
    }
    return (await response.json()) as ImportedAsset
  }

  async fetchAssetResponse(assetPath: string): Promise<Response> {
    const headers = new Headers()
    if (this.authToken) {
      headers.set('Authorization', `Bearer ${this.authToken}`)
    }
    const response = await fetch(
      `${this.baseUrl}/api/assets/raw?path=${encodeURIComponent(assetPath)}`,
      { headers }
    )
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(
        `Remote asset request failed (${response.status} ${response.statusText}) for ${assetPath}${text ? `: ${text}` : ''}`
      )
    }
    return response
  }

  watchVaultChanges(
    onEvent: (event: VaultChangeEvent) => void,
    options: { onReconnect?: () => void; stableAfterMs?: number; pollWhileDownMs?: number } = {}
  ): () => void {
    const url = new URL('/api/watch', `${this.baseUrl}/`)
    const headers: Record<string, string> = {}
    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`
    }

    // The subscription must outlive any single socket: a laptop sleep, a
    // Wi-Fi switch, a server restart, or an idle proxy all kill the
    // connection without the user doing anything wrong. Every HTTP call
    // keeps working through such a gap, so a silently dead socket shows up
    // as "edits from my other device never arrive" — the app looks fine
    // and is quietly frozen in the past.
    let ws: WebSocket | null = null
    let stopped = false
    let reconnectTimer: NodeJS.Timeout | null = null
    let stableTimer: NodeJS.Timeout | null = null
    let failedAttempts = 0
    // How long a socket must stay up before it counts as a real session.
    const stableAfterMs = options.stableAfterMs ?? 15_000
    // Some hosts never let the socket through at all: a reverse proxy that
    // does not forward the Upgrade handshake answers every attempt with a
    // plain HTTP error, so the feed is not "briefly down", it is unavailable.
    // Left alone, this app then shows a vault frozen at connect time, and a
    // note another device renamed or trashed still lists under its old path
    // until an operation on it comes back 404 (#734). While the socket is
    // down, re-pull the vault on a timer instead; each tick is a gap the
    // caller closes the same way it closes a reconnect.
    const pollWhileDownMs = options.pollWhileDownMs ?? REMOTE_CHANGE_POLL_MS
    let pollTimer: NodeJS.Timeout | null = null
    let warnedAboutPolling = false
    const startPolling = (): void => {
      if (pollTimer || stopped) return
      if (!warnedAboutPolling) {
        warnedAboutPolling = true
        console.warn(
          `[remote] ${this.baseUrl}: the change feed at /api/watch is not staying connected (a proxy without WebSocket support?); refreshing every ${Math.round(pollWhileDownMs / 1000)}s instead`
        )
      }
      pollTimer = setInterval(() => {
        if (!stopped) options.onReconnect?.()
      }, pollWhileDownMs)
    }
    const stopPolling = (): void => {
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
    }

    const connect = (): void => {
      if (stopped) return
      const socket = new WebSocket(url, { headers })
      ws = socket

      socket.on('open', () => {
        // Events that fired while we were down are gone for good; the
        // caller re-pulls everything instead of trusting the resumed feed.
        // Only the very first attempt connecting cleanly has no gap.
        const hadGap = failedAttempts > 0
        stopPolling()
        // The failure counter resets only after the socket has stayed up for
        // a while, not on the handshake: a peer that accepts the upgrade and
        // immediately drops it (a misconfigured proxy, a crash-looping
        // server) would otherwise reconnect on a flat 1s delay forever, and
        // every cycle's onReconnect re-pulls the entire vault.
        if (stableTimer) clearTimeout(stableTimer)
        stableTimer = setTimeout(() => {
          if (!stopped && ws === socket) failedAttempts = 0
        }, stableAfterMs)
        if (hadGap) options.onReconnect?.()
      })

      socket.on('message', (data: WebSocket.RawData) => {
        const text =
          typeof data === 'string'
            ? data
            : data instanceof ArrayBuffer
              ? Buffer.from(data).toString('utf8')
              : Buffer.isBuffer(data)
                ? data.toString('utf8')
                : ''
        if (!text) return
        try {
          onEvent(JSON.parse(text) as VaultChangeEvent)
        } catch {
          // ignore malformed watcher payloads
        }
      })

      // `ws` is an EventEmitter: an 'error' with no listener throws an
      // uncaught exception in the main process (a server restart raises
      // ECONNRESET here). The close handler owns recovery.
      socket.on('error', () => {})

      socket.on('close', () => {
        if (stopped || ws !== socket) return
        if (stableTimer) {
          clearTimeout(stableTimer)
          stableTimer = null
        }
        ws = null
        const delay = Math.min(30_000, 1_000 * 2 ** failedAttempts)
        failedAttempts += 1
        startPolling()
        reconnectTimer = setTimeout(connect, delay)
      })
    }

    connect()

    return () => {
      stopped = true
      stopPolling()
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      if (stableTimer) {
        clearTimeout(stableTimer)
        stableTimer = null
      }
      try {
        ws?.close()
      } catch {
        // ignore close errors
      }
    }
  }

  private async jsonRequest<T>(path: string, init?: JsonRequestInit): Promise<T> {
    const headers = new Headers(init?.headers)
    if (this.authToken && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${this.authToken}`)
    }
    const hasBody = init?.body !== undefined
    if (hasBody && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }

    let response: Response
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        body: hasBody ? JSON.stringify(init!.body) : undefined
      })
    } catch (error) {
      throw new RemoteConnectionError(connectionErrorMessage(this.baseUrl, error))
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      // A 404 for a path this app asked to change means the list is behind
      // the server, not that the server is broken: another device moved,
      // renamed, or trashed the note and the change never arrived here
      // (#734). Say which path is gone and have the host re-pull the list.
      // Reads keep the plain answer: a 404 on `?path=` is how remote
      // databases learn a file is absent (#556), and that is not staleness.
      const stalePath = response.status === 404 ? requestedPath(init?.body) : null
      if (stalePath !== null) {
        this.onStalePath?.(stalePath)
        throw new RemoteRequestError(stalePathMessage(stalePath), response.status)
      }
      throw new RemoteRequestError(
        requestErrorMessage(this.baseUrl, path, response, text),
        response.status
      )
    }
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }
}

/** The vault-relative path a JSON request body names, when it names one. */
function requestedPath(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const path = (body as { path?: unknown }).path
  return typeof path === 'string' && path.length > 0 ? path : null
}
