/**
 * A vault backed by a self-hosted ZenNotes server instead of the on-device
 * filesystem: the mobile analog of the desktop main process proxying its
 * vault IPC to RemoteServerClient. Exposes the same surface the bridge calls
 * on MobileVault (see mobile-bridge.ts `activeVault()`), so remote mode is a
 * swap of the backend, not a second bridge.
 *
 * Change events: the server's fsnotify WebSocket needs an Authorization
 * header the webview's WebSocket cannot send, so v1 mirrors the local vault's
 * model instead: every mutating call emits its own VaultChangeEvent, and
 * `rescan()` (app foreground) diffs a listNotes snapshot exactly like
 * MobileVault.rescan. Ops the server has no endpoint for (asset delete/
 * duplicate/undo, custom templates) throw a friendly message; the store
 * already disables those affordances when workspaceMode === 'remote'.
 */
import { bytesToBase64 } from './base64'
import type {
  AssetMeta,
  DeletedAsset,
  FolderEntry,
  NoteComment,
  NoteCommentInput,
  NoteContent,
  NoteFolder,
  NoteMeta,
  PastedImageInput,
  ServerCapabilities,
  VaultDemoTourResult,
  VaultInfo,
  VaultSettings,
  VaultTextSearchMatch
} from '@zennotes/shared-domain/ipc'
import type { VaultTask } from '@zennotes/shared-domain/tasks'
import type { CustomTemplateFile, WriteTemplateInput } from '@zennotes/bridge-contract/templates'
import type { ImportedAsset } from '@zennotes/shared-domain/ipc'
import { createAbsenceAwareReader } from '@zennotes/shared-domain/remote-absence'
import { pastedImageFilename } from '@zennotes/shared-domain/pasted-image'
import { emitVaultChange } from './events'
import { importedAssetFilename, importedAssetMarkdown } from './imported-assets'
import { classifyImportedAsset } from './vault-core'
import { RemoteClient, RemoteRequestError } from './remote-client'

function remoteOnly(what: string): never {
  throw new Error(`${what} is not available for remote vaults yet. Manage it on the server.`)
}

export class RemoteVault {
  readonly client: RemoteClient
  readonly name: string
  /** Keys the per-connection workspace-state slot in localStorage. */
  private readonly stateKey: string
  /** What this server said it can do, from the connect handshake. Null when
   *  the server predates /capabilities entirely. */
  private readonly capabilities: ServerCapabilities | null

  /** Minimal stand-in for MobileVault.fs, the database layer reads raw vault
   *  files through it (/api/notes/read accepts any vault path, same as the
   *  web bridge), and the foreground-rescan hook checks isCloud/rootUri. */
  readonly fs: {
    readonly isCloud: boolean
    readonly rootUri: string | null
    readTextOrNull(relPath: string): Promise<string | null>
  }

  constructor(
    client: RemoteClient,
    info: VaultInfo | null,
    profileKey: string,
    capabilities: ServerCapabilities | null = null
  ) {
    this.client = client
    this.name = info?.name ?? 'Remote Vault'
    this.stateKey = `zn-remote-workspace-state:${profileKey}`
    this.capabilities = capabilities
    this.fs = {
      isCloud: false,
      rootUri: null,
      // 404 always means absent. Any other status means absent only if this
      // server cannot answer 404 for a missing file (pre-2.20.2), which the
      // reader settles by probing it once. `openDatabase` reads an absent
      // schema.json as "bare CSV, adopt it" and writes an inferred schema
      // over whatever was there: so a 500, an auth rejection, or a dropped
      // connection must surface as errors, never read as absence.
      readTextOrNull: createAbsenceAwareReader({
        read: async (relPath) => (await client.readNote(relPath)).body,
        statusOf: (error) => (error instanceof RemoteRequestError ? error.status : null),
        serverReportsMissingAsNotFound: () => capabilities?.reportsMissingAsNotFound === true
      })
    }
  }

  // ---- settings -------------------------------------------------------

  getVaultSettings(): Promise<VaultSettings> {
    return this.client.getVaultSettings()
  }

  async setVaultSettings(next: VaultSettings): Promise<VaultSettings> {
    const saved = await this.client.setVaultSettings(next)
    emitVaultChange({
      kind: 'change',
      path: '.zennotes/vault.json',
      folder: 'inbox',
      scope: 'vault-settings'
    })
    return saved
  }

  async rootContentHiddenByInboxMode(): Promise<boolean> {
    // The server owns the on-disk layout; primaryNotesLocation is the only
    // signal we have from here.
    const settings = await this.getVaultSettings()
    return settings.primaryNotesLocation === 'inbox'
  }

  // ---- notes ----------------------------------------------------------

  listNotes(): Promise<NoteMeta[]> {
    return this.client.listNotes()
  }

  listFolders(): Promise<FolderEntry[]> {
    return this.client.listFolders()
  }

  readNote(relPath: string): Promise<NoteContent> {
    return this.client.readNote(relPath)
  }

  async writeNote(relPath: string, body: string): Promise<NoteMeta> {
    const meta = await this.client.writeNote(relPath, body)
    emitVaultChange({
      kind: 'change',
      path: meta.path,
      folder: meta.folder,
      scope: /(^|\/)[^/]+\.base\//.test(meta.path) ? 'database' : 'content'
    })
    return meta
  }

  async appendToNote(relPath: string, body: string, position: 'start' | 'end'): Promise<NoteMeta> {
    const current = await this.readNote(relPath)
    const existing = current.body ?? ''
    const next =
      position === 'start'
        ? `${body.replace(/\s+$/u, '')}\n\n${existing.replace(/^\s+/u, '')}`
        : `${existing.replace(/\s+$/u, '')}\n\n${body.replace(/\s+$/u, '')}\n`
    return this.writeNote(relPath, next)
  }

  async createNote(folder: NoteFolder, title?: string, subpath = ''): Promise<NoteMeta> {
    const meta = await this.client.createNote(folder, title, subpath)
    emitVaultChange({ kind: 'add', path: meta.path, folder: meta.folder, scope: 'content' })
    return meta
  }

  async createExcalidraw(folder: NoteFolder, subpath = '', title?: string): Promise<NoteMeta> {
    const meta = await this.client.createExcalidraw(folder, subpath, title)
    emitVaultChange({ kind: 'add', path: meta.path, folder: meta.folder, scope: 'content' })
    return meta
  }

  async renameNote(relPath: string, nextTitle: string): Promise<NoteMeta> {
    const meta = await this.client.renameNote(relPath, nextTitle)
    emitVaultChange({ kind: 'unlink', path: relPath, folder: meta.folder, scope: 'content' })
    emitVaultChange({ kind: 'add', path: meta.path, folder: meta.folder, scope: 'content' })
    return meta
  }

  async deleteNote(relPath: string): Promise<void> {
    await this.client.deleteNote(relPath)
    emitVaultChange({ kind: 'unlink', path: relPath, folder: 'trash', scope: 'content' })
  }

  async moveToTrash(relPath: string): Promise<NoteMeta> {
    const meta = await this.client.moveToTrash(relPath)
    emitVaultChange({ kind: 'unlink', path: relPath, folder: meta.folder, scope: 'content' })
    emitVaultChange({ kind: 'add', path: meta.path, folder: 'trash', scope: 'content' })
    return meta
  }

  async restoreFromTrash(relPath: string): Promise<NoteMeta> {
    const meta = await this.client.restoreFromTrash(relPath)
    emitVaultChange({ kind: 'unlink', path: relPath, folder: 'trash', scope: 'content' })
    emitVaultChange({ kind: 'add', path: meta.path, folder: meta.folder, scope: 'content' })
    return meta
  }

  async emptyTrash(): Promise<void> {
    await this.client.emptyTrash()
    emitVaultChange({ kind: 'unlink', path: 'trash', folder: 'trash', scope: 'folder' })
  }

  async archiveNote(relPath: string): Promise<NoteMeta> {
    const meta = await this.client.archiveNote(relPath)
    emitVaultChange({ kind: 'unlink', path: relPath, folder: 'inbox', scope: 'content' })
    emitVaultChange({ kind: 'add', path: meta.path, folder: meta.folder, scope: 'content' })
    return meta
  }

  async unarchiveNote(relPath: string): Promise<NoteMeta> {
    const meta = await this.client.unarchiveNote(relPath)
    emitVaultChange({ kind: 'unlink', path: relPath, folder: 'archive', scope: 'content' })
    emitVaultChange({ kind: 'add', path: meta.path, folder: meta.folder, scope: 'content' })
    return meta
  }

  async duplicateNote(relPath: string): Promise<NoteMeta> {
    const meta = await this.client.duplicateNote(relPath)
    emitVaultChange({ kind: 'add', path: meta.path, folder: meta.folder, scope: 'content' })
    return meta
  }

  async moveNote(
    relPath: string,
    targetFolder: NoteFolder,
    targetSubpath: string
  ): Promise<NoteMeta> {
    const meta = await this.client.moveNote(relPath, targetFolder, targetSubpath)
    emitVaultChange({ kind: 'unlink', path: relPath, folder: meta.folder, scope: 'content' })
    emitVaultChange({ kind: 'add', path: meta.path, folder: targetFolder, scope: 'content' })
    return meta
  }

  // ---- folders --------------------------------------------------------

  async createFolder(folder: NoteFolder, subpath: string): Promise<void> {
    await this.client.createFolder(folder, subpath)
    emitVaultChange({ kind: 'add', path: subpath, folder, scope: 'folder' })
  }

  async renameFolder(folder: NoteFolder, oldSubpath: string, newSubpath: string): Promise<string> {
    const subpath = await this.client.renameFolder(folder, oldSubpath, newSubpath)
    emitVaultChange({ kind: 'unlink', path: oldSubpath, folder, scope: 'folder' })
    emitVaultChange({ kind: 'add', path: subpath, folder, scope: 'folder' })
    return subpath
  }

  async deleteFolder(folder: NoteFolder, subpath: string): Promise<void> {
    await this.client.deleteFolder(folder, subpath)
    emitVaultChange({ kind: 'unlink', path: subpath, folder, scope: 'folder' })
  }

  async duplicateFolder(folder: NoteFolder, subpath: string): Promise<string> {
    const dest = await this.client.duplicateFolder(folder, subpath)
    emitVaultChange({ kind: 'add', path: dest, folder, scope: 'folder' })
    return dest
  }

  // ---- comments -------------------------------------------------------

  readNoteComments(relPath: string): Promise<NoteComment[]> {
    return this.client.readNoteComments(relPath)
  }

  async writeNoteComments(relPath: string, inputs: NoteCommentInput[]): Promise<NoteComment[]> {
    const comments = await this.client.writeNoteComments(relPath, inputs)
    emitVaultChange({ kind: 'change', path: relPath, folder: 'inbox', scope: 'comments' })
    return comments
  }

  // ---- workspace state (kept device-local, per connection) -------------

  async readWorkspaceState(): Promise<string | null> {
    return localStorage.getItem(this.stateKey)
  }

  async writeWorkspaceState(json: string): Promise<void> {
    localStorage.setItem(this.stateKey, json)
  }

  // ---- search / tasks -------------------------------------------------

  searchVaultText(query: string, _limit = 80): Promise<VaultTextSearchMatch[]> {
    return this.client.searchVaultText(query)
  }

  scanTasks(): Promise<VaultTask[]> {
    return this.client.scanTasks()
  }

  scanTasksForPath(relPath: string): Promise<VaultTask[]> {
    return this.client.scanTasksForPath(relPath)
  }

  // ---- templates (no server endpoints) --------------------------------

  async listTemplates(): Promise<CustomTemplateFile[]> {
    return []
  }

  async readTemplate(_sourcePath: string): Promise<string> {
    return remoteOnly('Reading custom templates')
  }

  async writeTemplate(_input: WriteTemplateInput): Promise<CustomTemplateFile> {
    return remoteOnly('Saving custom templates')
  }

  async deleteTemplate(_sourcePath: string): Promise<void> {
    remoteOnly('Deleting custom templates')
  }

  // ---- demo tour ------------------------------------------------------

  async generateDemoTour(): Promise<VaultDemoTourResult> {
    const result = await this.client.generateDemoTour()
    await this.rescan()
    return result
  }

  async removeDemoTour(): Promise<VaultDemoTourResult> {
    const result = await this.client.removeDemoTour()
    await this.rescan()
    return result
  }

  // ---- assets ---------------------------------------------------------

  listAssets(): Promise<AssetMeta[]> {
    return this.client.listAssets()
  }

  hasAssetsDir(): Promise<boolean> {
    return this.client.hasAssetsDir()
  }

  async importPastedImage(input: PastedImageInput): Promise<ImportedAsset> {
    const bytes =
      input.data instanceof Uint8Array ? input.data : new Uint8Array(input.data as ArrayBuffer)
    // The shared namer, not a local guess: the old one wrote every non-PNG,
    // non-GIF paste as .jpg, and passed the suggested name through unscrubbed
    // into a filename it then embeds as `![[...]]`, a name carrying [ ] # ^
    // broke its own wikilink (the bug upstream fixed for web in 80303bb).
    const filename = pastedImageFilename(
      { mimeType: input.mimeType, suggestedName: input.suggestedName },
      new Date()
    )
    const meta = await this.client.uploadAsset(filename, bytesToBase64(bytes), 'assets')
    emitVaultChange({ kind: 'add', path: meta.path, folder: 'inbox', scope: 'content' })
    return { name: meta.name, path: meta.path, markdown: `![[${meta.path}]]`, kind: 'image' }
  }

  async importDroppedFile(_notePath: string, file: File): Promise<ImportedAsset> {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const meta = await this.client.uploadAsset(
      importedAssetFilename(file.name),
      bytesToBase64(bytes),
      'assets'
    )
    // The same rule as a local vault, so a remote vault embeds a video too.
    const kind = classifyImportedAsset(meta.name)
    emitVaultChange({ kind: 'add', path: meta.path, folder: 'inbox', scope: 'content' })
    return {
      name: meta.name,
      path: meta.path,
      markdown: importedAssetMarkdown(meta.path, meta.name, kind),
      kind
    }
  }

  async renameAsset(relPath: string, nextName: string): Promise<AssetMeta> {
    const meta = await this.client.renameAsset(relPath, nextName)
    emitVaultChange({ kind: 'change', path: meta.path, folder: 'inbox', scope: 'content' })
    return meta
  }

  async moveAsset(relPath: string, targetDir: string): Promise<AssetMeta> {
    const meta = await this.client.moveAsset(relPath, targetDir)
    emitVaultChange({ kind: 'change', path: meta.path, folder: 'inbox', scope: 'content' })
    return meta
  }

  /** The asset-mutation family arrived in server 2.24 (upstream bb58a72).
   *  Against an older server every route below 404s, so say which half is
   *  behind rather than letting a bare failure read as a broken app. */
  private requireAssetOps(what: string): void {
    if (this.capabilities?.supportsAssetOps) return
    throw new Error(
      `${what} needs ZenNotes server 2.24 or newer. Update the server for ${this.client.baseUrl} and reconnect.`
    )
  }

  async duplicateAsset(relPath: string): Promise<AssetMeta> {
    this.requireAssetOps('Duplicating assets')
    const meta = await this.client.duplicateAsset(relPath)
    emitVaultChange({ kind: 'add', path: meta.path, folder: 'inbox', scope: 'content' })
    return meta
  }

  async deleteAsset(relPath: string): Promise<DeletedAsset> {
    this.requireAssetOps('Deleting assets')
    const deleted = await this.client.deleteAsset(relPath)
    emitVaultChange({ kind: 'unlink', path: deleted.path, folder: 'inbox', scope: 'content' })
    return deleted
  }

  async restoreDeletedAsset(asset: DeletedAsset): Promise<AssetMeta> {
    this.requireAssetOps('Restoring assets')
    const meta = await this.client.restoreDeletedAsset(asset)
    emitVaultChange({ kind: 'add', path: meta.path, folder: 'inbox', scope: 'content' })
    return meta
  }

  /** Empty rather than an error on an older server: the Trash view asks for
   *  this on open, and a server with no store genuinely holds nothing. */
  async listDeletedAssets(): Promise<DeletedAsset[]> {
    if (!this.capabilities?.supportsAssetOps) return []
    return this.client.listDeletedAssets()
  }

  async purgeDeletedAsset(undoToken: string): Promise<void> {
    this.requireAssetOps('Purging deleted assets')
    await this.client.purgeDeletedAsset(undoToken)
  }

  async emptyDeletedAssets(): Promise<void> {
    this.requireAssetOps('Emptying deleted assets')
    await this.client.emptyDeletedAssets()
  }

  // ---- freshness ------------------------------------------------------

  /** Announce a change-feed gap on app foreground, same shape as
   *  MobileVault.rescan, standing in for the file watcher this build has no
   *  way to subscribe to. */
  async rescan(): Promise<void> {
    // One 'resync' rather than a per-note diff, see MobileVault.rescan for
    // why. It matters more here: the server's fsnotify feed is a WebSocket
    // this app can never subscribe to (the Authorization header cannot ride a
    // WebView WebSocket), so a remote vault gets no live events at all and
    // every other client's writes land silently.
    emitVaultChange({ kind: 'change', path: '', folder: 'inbox', scope: 'resync' })
  }
}
