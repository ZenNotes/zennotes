import type {
  AssetMeta,
  DirectoryBrowseResult,
  FolderEntry,
  ImportedAsset,
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
import WebSocket from 'ws'

export interface RemoteServerClientOptions {
  baseUrl: string
  authToken?: string | null
}

type JsonRequestInit = Omit<RequestInit, 'body'> & { body?: unknown }

export class RemoteServerClient {
  readonly baseUrl: string
  readonly authToken: string | null

  constructor(options: RemoteServerClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl)
    this.authToken = options.authToken?.trim() || null
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

  async readNote(relPath: string): Promise<NoteContent> {
    return this.jsonRequest<NoteContent>(`/api/notes/read?path=${encodeURIComponent(relPath)}`)
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

  watchVaultChanges(onEvent: (event: VaultChangeEvent) => void): () => void {
    const url = new URL('/api/watch', `${this.baseUrl}/`)
    const headers: Record<string, string> = {}
    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`
    }
    const ws = new WebSocket(url, { headers })

    ws.on('message', (data: WebSocket.RawData) => {
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

    return () => {
      try {
        ws.close()
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
      const message =
        error instanceof Error && error.message
          ? ` Could not reach the server: ${error.message}.`
          : ''
      throw new Error(
        `Could not connect to the ZenNotes server at ${this.baseUrl}. Make sure the server is running and the URL is correct.${message}`
      )
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      if (response.status === 401) {
        throw new Error(
          `The ZenNotes server rejected the connection. Check the auth token for ${this.baseUrl} and try again.`
        )
      }
      throw new Error(
        `Remote server request failed (${response.status} ${response.statusText}) for ${path}${text ? `: ${text}` : ''}`
      )
    }
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim()
  const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  return normalized.replace(/\/+$/, '')
}
