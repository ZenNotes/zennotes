/**
 * The slice of the ZenNotes server API the `zn` CLI needs (#493).
 *
 * A deliberately smaller thing than the desktop app's RemoteServerClient:
 * no WebSocket watcher, no assets, no comments, no settings. A CLI command
 * runs once and exits, so there is nothing to keep in sync — and staying
 * fetch-only is what lets this ship inside the standalone `cli.js` bundle
 * (see the note in main/remote/connection.ts).
 *
 * Return types are the CLI's own NoteMeta / VaultTask rather than the app's
 * richer @shared/ipc ones. The server sends a superset of both, so the
 * commands keep printing exactly the fields they print for a local vault.
 */

import { remoteJsonRequest } from '../../main/remote/connection.js'
import type {
  NoteContent,
  NoteFolder,
  NoteMeta,
  VaultTask,
  VaultTextSearchMatch
} from '../../mcp/vault-ops.js'

/** `GET /api/vault`: the vault the server is serving, as the Go side names
 *  it (`root`, not `path`; mirrors `VaultInfo` in the Go vault package). */
export interface RemoteVaultInfo {
  root: string
  name: string
}

export interface RemoteAssetMeta {
  path: string
  name: string
  size: number
  updatedAt: number
}

export class CliRemoteClient {
  constructor(
    readonly baseUrl: string,
    readonly authToken: string | null
  ) {}

  private get<T>(path: string): Promise<T> {
    return remoteJsonRequest<T>(path, { baseUrl: this.baseUrl, authToken: this.authToken })
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return remoteJsonRequest<T>(path, {
      baseUrl: this.baseUrl,
      authToken: this.authToken,
      method: 'POST',
      body: body ?? {}
    })
  }

  /* --- reads --- */

  getCurrentVault(): Promise<RemoteVaultInfo | null> {
    return this.get<RemoteVaultInfo | null>('/api/vault')
  }

  /** The layout facts database path composition needs (#556). */
  getVaultSettings(): Promise<{
    primaryNotesLocation?: string
    systemFolderPaths?: Record<string, string> | null
  }> {
    return this.get('/api/vault/settings')
  }

  listNotes(): Promise<NoteMeta[]> {
    return this.get<NoteMeta[]>('/api/notes')
  }

  listFolders(): Promise<{ folder: NoteFolder; subpath: string }[]> {
    return this.get<{ folder: NoteFolder; subpath: string }[]>('/api/folders')
  }

  readNote(relPath: string): Promise<NoteContent> {
    return this.get<NoteContent>(`/api/notes/read?path=${encodeURIComponent(relPath)}`)
  }

  searchText(query: string): Promise<VaultTextSearchMatch[]> {
    const params = new URLSearchParams({ q: query, backend: 'auto' })
    return this.get<VaultTextSearchMatch[]>(`/api/search/text?${params.toString()}`)
  }

  scanTasks(opts?: { includeExcluded?: boolean }): Promise<VaultTask[]> {
    return this.get<VaultTask[]>(
      opts?.includeExcluded ? '/api/tasks?includeExcluded=1' : '/api/tasks'
    )
  }

  /** Every file under the vault's attachment directories, as the server
   *  lists them for the app's Assets view. */
  listAssets(): Promise<RemoteAssetMeta[]> {
    return this.get<RemoteAssetMeta[]>('/api/assets')
  }

  scanTasksForPath(
    relPath: string,
    opts?: { includeExcluded?: boolean }
  ): Promise<VaultTask[]> {
    const suffix = opts?.includeExcluded ? '&includeExcluded=1' : ''
    return this.get<VaultTask[]>(
      `/api/tasks/for?path=${encodeURIComponent(relPath)}${suffix}`
    )
  }

  /* --- writes --- */

  writeNote(relPath: string, body: string): Promise<NoteMeta> {
    return this.post<NoteMeta>('/api/notes/write', { path: relPath, body })
  }

  createNote(folder: NoteFolder, title?: string, subpath = ''): Promise<NoteMeta> {
    return this.post<NoteMeta>('/api/notes/create', { folder, title, subpath })
  }

  renameNote(relPath: string, nextTitle: string): Promise<NoteMeta> {
    return this.post<NoteMeta>('/api/notes/rename', { path: relPath, title: nextTitle })
  }

  moveNote(relPath: string, targetFolder: NoteFolder, targetSubpath: string): Promise<NoteMeta> {
    return this.post<NoteMeta>('/api/notes/move', { path: relPath, targetFolder, targetSubpath })
  }

  archiveNote(relPath: string): Promise<NoteMeta> {
    return this.post<NoteMeta>('/api/notes/archive', { path: relPath })
  }

  unarchiveNote(relPath: string): Promise<NoteMeta> {
    return this.post<NoteMeta>('/api/notes/unarchive', { path: relPath })
  }

  moveToTrash(relPath: string): Promise<NoteMeta> {
    return this.post<NoteMeta>('/api/notes/trash', { path: relPath })
  }

  restoreFromTrash(relPath: string): Promise<NoteMeta> {
    return this.post<NoteMeta>('/api/notes/restore', { path: relPath })
  }

  duplicateNote(relPath: string): Promise<NoteMeta> {
    return this.post<NoteMeta>('/api/notes/duplicate', { path: relPath })
  }

  async deleteNote(relPath: string): Promise<void> {
    await this.post<void>('/api/notes/delete', { path: relPath })
  }

  async emptyTrash(): Promise<void> {
    await this.post<void>('/api/notes/empty-trash')
  }

  async createFolder(folder: NoteFolder, subpath: string): Promise<void> {
    await this.post<void>('/api/folders/create', { folder, subpath })
  }

  async renameFolder(
    folder: NoteFolder,
    oldSubpath: string,
    newSubpath: string
  ): Promise<string> {
    const resp = await this.post<{ subpath: string }>('/api/folders/rename', {
      folder,
      oldSubpath,
      newSubpath
    })
    return resp.subpath
  }

  async deleteFolder(folder: NoteFolder, subpath: string): Promise<void> {
    await this.post<void>('/api/folders/delete', { folder, subpath })
  }
}
