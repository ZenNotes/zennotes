import type { ZenPlatform } from './platform.js'
import type {
  AppUpdateState,
  AssetMeta,
  CliInstallStatus,
  CliInstallRequest,
  CliUpdateCheckRequest,
  CliUpdateState,
  DeletedAsset,
  ExternalFileContent,
  ExternalFileLink,
  FolderEntry,
  ImportedAsset,
  LinkMetadata,
  LocalVaultEntry,
  MoveExternalFileResult,
  ListNotesPageRequest,
  ListNotesPageResponse,
  NoteComment,
  NoteCommentInput,
  AgentEditRecord,
  AgentEditSummary,
  NoteContent,
  NoteFolder,
  NoteMeta,
  PastedImageInput,
  RaycastExtensionStatus,
  DirectoryBrowseResult,
  RemoteWorkspaceInfo,
  RemoteWorkspaceProfile,
  RemoteWorkspaceProfileInput,
  ServerCapabilities,
  ServerSessionStatus,
  VaultSettings,
  TikzRenderResponse,
  TraySyncStatus,
  VaultChangeEvent,
  VaultDemoTourResult,
  VaultInfo,
  VaultTextSearchBackendPreference,
  VaultTextSearchCapabilities,
  VaultTextSearchMatch,
  VaultTextSearchToolPaths
} from './ipc.js'
import type { CustomTemplateFile, WriteTemplateInput } from './templates.js'
import type {
  UnsplashKeyCheck,
  UnsplashKeySaveResult,
  UnsplashKeyStatus,
  UnsplashSearchResult
} from './unsplash.js'
import type {
  CloudAccountConnectResult,
  CloudAccountStatus,
  CloudBackupItemsPage,
  CloudBackupItemsQuery,
  CloudBackupNoteRestoreResult,
  CloudBackupRestoreResult,
  CloudBackupSchedule,
  CloudBackupSnapshot,
  CloudBackupSnapshotItem,
  CloudEncryptionRecoveryPrompt,
  CloudEncryptionSecretInput,
  CloudEncryptionStatus,
  CloudPublishedNote,
  CloudPublishedNoteResult,
  CloudPublishNoteInput,
  CloudServiceAccount,
  CloudSyncBootstrapConflict,
  CloudSyncBootstrapConflictDetails,
  CloudSyncBootstrapConflictResolution,
  CloudSyncPendingConflictDetails,
  CloudSyncPendingConflictResolution,
  CloudSyncRunSummary,
  CloudSyncSettingsChoice,
  CloudSyncSettingsConflict,
  CloudSyncVault,
  CloudVaultLink
} from './cloud-sync.js'
import type {
  ApplyWorkflowInput,
  ExportWorkflowInput,
  ImportedWorkflowFile,
  WorkflowFile,
  WorkflowRunReceipt,
  WorkflowRunSummary,
  WorkflowUndoResult,
  WriteWorkflowInput
} from './workflows.js'
import type { VaultTask } from './tasks.js'
import type {
  DatabaseDoc,
  DatabaseSeed,
  DatabaseSidecar,
  DatabaseSummary,
  DbRow
} from './databases.js'
import type {
  McpClientId,
  McpClientStatus,
  McpInstructionsPayload,
  McpServerRuntime,
  McpServerTokenState
} from './mcp-clients.js'
import type { AppConfigPortable } from './app-config.js'
import type { ExternalUrlResult } from './application-links.js'
import type { CustomTheme } from './custom-themes.js'
import type { Override } from './overrides.js'
import type {
  CustomCodeLanguage,
  CustomCodeLanguageInstallInput,
  CustomCodeLanguageUpdateInput
} from './custom-code-languages.js'

export interface ZenCapabilities {
  supportsUpdater: boolean
  supportsNativeMenus: boolean
  supportsFloatingWindows: boolean
  supportsLocalFilesystemPickers: boolean
  supportsRemoteWorkspace: boolean
  supportsCloudSync?: boolean
  supportsCliInstall: boolean
  /** Custom templates require local-filesystem CRUD; false on web/remote. */
  supportsCustomTemplates: boolean
  supportsCustomCodeLanguages?: boolean
  /** Local desktop support, or a web client paired with a server that owns
   *  workflow files and journalled apply/undo. */
  supportsWorkflows?: boolean
  /** Grammar and spelling with Harper: the host can serve the wasm to
   *  Harper's worker and ships it. Absent on hosts that have not verified
   *  that yet (the mobile shells), which hides the setting there. */
  supportsHarper?: boolean
  /** The host can keep per-note undo history between launches, somewhere
   *  machine-local that is not the vault (`readNoteUndoHistory` and friends).
   *  Absent everywhere but the desktop app, which hides the setting. (#793) */
  supportsUndoFile?: boolean
  /** The host can read and write agent edit records for a local vault
   *  (`listAgentEdits` and friends), so assistant edits made through MCP can
   *  be reviewed. Absent where records are not reachable yet (the web client
   *  and the phones), which hides the review. */
  supportsAgentEditReview?: boolean
  /** The host can save a readable archive of an end-to-end encrypted vault's
   *  backup: the desktop app opens the service's archive item by item. The
   *  phones refuse it, so where this is absent Settings says where to save
   *  one instead of offering a button that can only fail. */
  supportsEncryptedBackupArchive?: boolean
}

export interface ZenAppInfo {
  name: string
  productName: string
  version: string
  description: string
  homepage?: string
  /** Legacy renderer family. Use hostKind to distinguish native mobile shells. */
  runtime: 'desktop' | 'web'
  hostKind?: 'desktop' | 'browser' | 'ios' | 'android'
  /** The details a bug report needs beside the version, read by `:version`
   *  and Settings > About (#814). Each host fills in what it knows; a field
   *  it cannot answer is left out of the report, never guessed. */
  arch?: string
  /** Operating system name and version, e.g. `macOS 26.0`, `Ubuntu 24.04.1 LTS (kernel 6.8.0)`. */
  os?: string
  /** What runs the renderer, e.g. `Electron 38.1.0 (Chromium 140.0.7339.133, Node 22.19.0)`. */
  engine?: string
  /** How this copy was installed, e.g. `AppImage`, `deb package`, `package manager or tarball`. */
  install?: string
}

export interface ZenBridge {
  getCapabilities(): ZenCapabilities
  getAppInfo(): ZenAppInfo

  platform(): Promise<ZenPlatform>
  platformSync(): ZenPlatform
  listSystemFonts(): Promise<string[]>
  getAppIconDataUrl(): Promise<string | null>
  zoomInApp(): Promise<number>
  zoomOutApp(): Promise<number>
  resetAppZoom(): Promise<number>
  getAppUpdateState(): Promise<AppUpdateState>
  checkForAppUpdates(): Promise<AppUpdateState>
  /** The desktop app's anonymous install/update count: one message to
   *  zennotes.org with the event, version, OS, architecture and install kind,
   *  no identifier. The caller checks the setting; the host refuses
   *  development builds and test runs, and sends each event once per run. */
  sendUsageCount?(event: 'install' | 'update'): Promise<void>
  /** Unsplash photo search for the cover picker, sent straight to
   *  api.unsplash.com with the person's own access key. A host without it
   *  shows no Unsplash tab. Never rejects: a failure comes back as its reason. */
  searchUnsplash?(query: string, page: number): Promise<UnsplashSearchResult>
  /** Unsplash's download tracking: a photo became a cover. Fire and forget. */
  trackUnsplashDownload?(downloadLocation: string): Promise<void>
  /** Whether an Unsplash access key is set. The key itself never crosses
   *  the bridge: the host keeps it and answers only this. */
  getUnsplashKeyStatus?(): Promise<UnsplashKeyStatus>
  /** Check a pasted access key with one request, then keep it unless
   *  Unsplash refused it. */
  saveUnsplashKey?(key: string): Promise<UnsplashKeySaveResult>
  /** One request with the saved key. */
  testUnsplashKey?(): Promise<UnsplashKeyCheck>
  clearUnsplashKey?(): Promise<void>
  checkForAppUpdatesWithUi(): Promise<void>
  downloadAppUpdate(): Promise<AppUpdateState>
  installAppUpdate(): Promise<void>
  getCloudAccountStatus(): Promise<CloudAccountStatus>
  connectCloudAccount(baseUrl?: string): Promise<CloudAccountConnectResult>
  logoutCloudAccount(): Promise<CloudAccountStatus>
  onCloudAccountChange(cb: (status: CloudAccountStatus) => void): () => void
  getCloudServiceAccount(): Promise<CloudServiceAccount>
  listCloudPublishedNotes(): Promise<CloudPublishedNote[]>
  publishCloudNote(input: CloudPublishNoteInput): Promise<CloudPublishedNoteResult>
  updateCloudPublishedNote(
    shareId: number,
    input: CloudPublishNoteInput
  ): Promise<CloudPublishedNoteResult>
  unpublishCloudNote(shareId: number): Promise<void>
  listCloudVaults(): Promise<CloudSyncVault[]>
  getCloudVaultLink(): Promise<CloudVaultLink | null>
  linkCloudVault(vaultId: string): Promise<CloudVaultLink>
  createAndLinkCloudVault(name: string, options?: { encrypted?: boolean }): Promise<CloudVaultLink>
  /** End-to-end encryption; hosts that cannot open encrypted vaults leave these out. */
  getCloudEncryptionStatus?(): Promise<CloudEncryptionStatus>
  prepareCloudEncryptionSetup?(passphrase: string): Promise<CloudEncryptionRecoveryPrompt>
  finishCloudEncryptionSetup?(setupId: string): Promise<void>
  unlockCloudEncryption?(secret: CloudEncryptionSecretInput): Promise<void>
  changeCloudEncryptionPassphrase?(
    current: CloudEncryptionSecretInput,
    next: string
  ): Promise<void>
  prepareNewCloudRecoveryKey?(
    current: CloudEncryptionSecretInput
  ): Promise<CloudEncryptionRecoveryPrompt>
  finishNewCloudRecoveryKey?(setupId: string): Promise<void>
  lockCloudEncryption?(): Promise<void>
  /** Moves the linked readable Cloud vault into a new end-to-end encrypted one. */
  encryptCloudVault?(): Promise<CloudVaultLink>
  unlinkCloudVault(): Promise<void>
  deleteCloudVault(): Promise<void>
  syncCloudVault(): Promise<CloudSyncRunSummary>
  hasCloudVaultChanges?(): Promise<boolean>
  /** Hosts with multiple workspace windows coordinate draft saves before sync. */
  onCloudSyncWindow?(handlers: import('./cloud-sync.js').CloudSyncWindowHandlers): () => void
  getCloudBootstrapConflict(
    conflict: CloudSyncBootstrapConflict
  ): Promise<CloudSyncBootstrapConflictDetails>
  resolveCloudBootstrapConflict(resolution: CloudSyncBootstrapConflictResolution): Promise<void>
  getCloudConflict(conflictId: string, reviewId?: string): Promise<CloudSyncPendingConflictDetails>
  releaseCloudConflictReview?(conflictId: string, reviewId: string): Promise<void>
  saveCloudConflictDraft(conflictId: string, draftText: string | null): Promise<void>
  resolveCloudConflict(resolution: CloudSyncPendingConflictResolution): Promise<void>
  getCloudSettingsConflict(): Promise<CloudSyncSettingsConflict | null>
  resolveCloudSettingsConflict(choice: CloudSyncSettingsChoice): Promise<void>
  listCloudBackups(): Promise<CloudBackupSnapshot[]>
  getCloudBackupSchedule(): Promise<CloudBackupSchedule>
  updateCloudBackupSchedule(enabled: boolean): Promise<CloudBackupSchedule>
  listCloudBackupItems(backupId: string): Promise<CloudBackupSnapshotItem[]>
  /** One page of a backup's notes, searched by path on the service. Hosts
   *  without it list the first page alone, and Settings filters that page. */
  listCloudBackupItemsPage?(
    backupId: string,
    query: CloudBackupItemsQuery
  ): Promise<CloudBackupItemsPage>
  createCloudBackup(label?: string): Promise<CloudBackupSnapshot>
  downloadCloudBackup(backupId: string): Promise<void>
  deleteCloudBackup(backupId: string): Promise<void>
  restoreCloudBackup(backupId: string): Promise<CloudBackupRestoreResult>
  restoreCloudBackupNote(
    backupId: string,
    snapshotItemId: number
  ): Promise<CloudBackupNoteRestoreResult>
  getServerCapabilities(): Promise<ServerCapabilities | null>
  getServerSession(): Promise<ServerSessionStatus>
  loginServerSession(token: string): Promise<ServerSessionStatus>
  logoutServerSession(): Promise<ServerSessionStatus>
  getRemoteWorkspaceInfo(): Promise<RemoteWorkspaceInfo | null>
  connectRemoteWorkspace(
    baseUrl: string,
    authToken?: string | null
  ): Promise<{ vault: VaultInfo | null; capabilities: ServerCapabilities }>
  disconnectRemoteWorkspace(): Promise<VaultInfo | null>
  /** Re-attempt the workspace configured on disk (used by the reconnect
   *  screen when the server was unreachable at boot). Resolves with the
   *  vault on success, null when the workspace still cannot be loaded. */
  retryWorkspaceBoot(): Promise<VaultInfo | null>
  listRemoteWorkspaceProfiles(): Promise<RemoteWorkspaceProfile[]>
  saveRemoteWorkspaceProfile(input: RemoteWorkspaceProfileInput): Promise<RemoteWorkspaceProfile>
  deleteRemoteWorkspaceProfile(id: string): Promise<void>
  connectRemoteWorkspaceProfile(
    id: string
  ): Promise<{ vault: VaultInfo | null; capabilities: ServerCapabilities }>

  getCurrentVault(): Promise<VaultInfo | null>
  listLocalVaults(): Promise<LocalVaultEntry[]>
  openLocalVault(root: string): Promise<VaultInfo | null>
  closeVault(): Promise<VaultInfo | null>
  pickVault(): Promise<VaultInfo | null>
  selectVaultPath(path: string): Promise<VaultInfo>
  browseServerDirectories(path?: string): Promise<DirectoryBrowseResult>
  getVaultSettings(): Promise<VaultSettings>
  setVaultSettings(next: VaultSettings): Promise<VaultSettings>
  /** Read the current vault's `.zennotes/workspace.json` (open tabs, layout,
   *  cursor) as a raw JSON string, or null when absent. Syncs with the vault. (#292) */
  readWorkspaceState(): Promise<string | null>
  /** Write the current vault's `.zennotes/workspace.json` (raw JSON string). (#292) */
  writeWorkspaceState(json: string): Promise<void>
  /** Undo history saved for a note of the current vault, or null. Opaque JSON
   *  the renderer wrote earlier; it lives with the app, not in the vault, and
   *  never syncs. Only on hosts with `supportsUndoFile`. (#793) */
  readNoteUndoHistory?(path: string): Promise<string | null>
  /** Save a note's undo history, or forget it with `null`. (#793) */
  writeNoteUndoHistory?(path: string, json: string | null): Promise<void>
  /** Forget every saved undo history, in every vault. (#793) */
  clearNoteUndoHistories?(): Promise<void>
  /** True when the vault is in `inbox` mode but its root holds notes that only
   *  `root` mode would surface (drives the "Switch to Vault root" banner). */
  rootContentHiddenByInboxMode(): Promise<boolean>

  listNotes(): Promise<NoteMeta[]>
  listNotesPage?(request: ListNotesPageRequest): Promise<ListNotesPageResponse>
  listFolders(): Promise<FolderEntry[]>
  listAssets(): Promise<AssetMeta[]>
  hasAssetsDir(): Promise<boolean>
  generateDemoTour(): Promise<VaultDemoTourResult>
  removeDemoTour(): Promise<VaultDemoTourResult>
  /**
   * Raw contents of every `.zennotes/workflows/*.md` file, newest name order.
   * Parsing lives in `@shared/workflows/parse` so the format has one home, the
   * same split the templates API uses. Returns [] where the host cannot reach
   * workflow storage (older web servers and remote desktop workspaces).
   */
  listWorkflows(): Promise<WorkflowFile[]>
  /** Create or overwrite a workflow file; returns the saved file. */
  writeWorkflow(input: WriteWorkflowInput): Promise<WorkflowFile>
  deleteWorkflow(sourcePath: string): Promise<void>
  /**
   * Save a copy of a workflow file anywhere on disk, through a native save
   * dialog. Resolves with the chosen path, or null when the dialog is
   * cancelled.
   *
   * Optional because it needs a filesystem: web and remote workspaces have
   * none, and the view hides the affordance rather than offering one that
   * fails. Sharing there is the clipboard, which needs no bridge at all.
   */
  exportWorkflow?(input: ExportWorkflowInput): Promise<string | null>
  /**
   * Read a workflow file the user picks in a native open dialog. Resolves with
   * null when the dialog is cancelled.
   *
   * Reading is ALL this does. The file is untrusted text until the renderer has
   * parsed, validated and shown it (`@shared/workflows/share`), and nothing
   * reaches `.zennotes/workflows` except through `writeWorkflow` afterwards.
   */
  importWorkflowFile?(): Promise<ImportedWorkflowFile | null>
  /**
   * Execute a plan's ops. The ONLY place in the product that writes on a
   * workflow's behalf, so every guarantee (journal, atomicity, whole-run
   * rollback) lives behind this one call.
   */
  applyWorkflow(input: ApplyWorkflowInput): Promise<WorkflowRunReceipt>
  undoWorkflowRun(runId: string): Promise<WorkflowUndoResult>
  listWorkflowRuns(): Promise<WorkflowRunSummary[]>
  /** Remove every run ledger a workflow left behind; resolves to how many.
   *  Exists for the guided tutorial's leave-no-trace cleanup. */
  deleteWorkflowRuns(workflowId: string): Promise<number>
  listTemplates(): Promise<CustomTemplateFile[]>
  readTemplate(sourcePath: string): Promise<string>
  writeTemplate(input: WriteTemplateInput): Promise<CustomTemplateFile>
  deleteTemplate(sourcePath: string): Promise<void>
  getVaultTextSearchCapabilities(
    paths?: VaultTextSearchToolPaths
  ): Promise<VaultTextSearchCapabilities>
  searchVaultText(
    query: string,
    backend?: VaultTextSearchBackendPreference,
    paths?: VaultTextSearchToolPaths
  ): Promise<VaultTextSearchMatch[]>
  readNote(relPath: string): Promise<NoteContent>
  readNoteComments(relPath: string): Promise<NoteComment[]>
  writeNoteComments(relPath: string, comments: NoteCommentInput[]): Promise<NoteComment[]>
  /** Notes with assistant edits to review, newest first. Only on hosts with
   *  `supportsAgentEditReview`. */
  listAgentEdits?(): Promise<AgentEditSummary[]>
  /** A note's agent edit record, or null when there is none. */
  readAgentEdit?(relPath: string): Promise<AgentEditRecord | null>
  /** Save a review's progress, or delete the record with `null`. */
  writeAgentEdit?(relPath: string, record: AgentEditRecord | null): Promise<void>
  scanTasks(): Promise<VaultTask[]>
  scanTasksForPath(relPath: string): Promise<VaultTask[]>
  /** Resolves to null when the `.csv` no longer exists (e.g. a stale tab). */
  openDatabase(relPath: string): Promise<DatabaseDoc | null>
  writeDatabaseRows(relPath: string, rows: DbRow[]): Promise<DatabaseDoc>
  writeDatabaseSchema(relPath: string, sidecar: DatabaseSidecar, rows: DbRow[]): Promise<DatabaseDoc>
  /** Create a `<title>.base` database under `folder`/`subpath`. Empty (an `id`
   *  + `Name` grid) by default; with a `seed`, its columns and rows become
   *  the initial contents, typed the way an adopted CSV would be (#832).
   *  The resolved doc's `title` may carry a collision suffix (`Name 2`). */
  createDatabase(
    folder: NoteFolder,
    subpath: string,
    title?: string,
    seed?: DatabaseSeed
  ): Promise<DatabaseDoc>
  /** Rename a database's `.base` folder; resolves to the new `data.csv` path. */
  renameDatabase(csvPath: string, newTitle: string): Promise<string>
  /** Create a record's "page" note (returns its vault-relative path). */
  createRecordPage(csvPath: string, title: string, body: string): Promise<string>
  listDatabases(): Promise<DatabaseSummary[]>
  writeNote(relPath: string, body: string): Promise<NoteMeta>
  appendToNote(relPath: string, body: string, position: 'start' | 'end'): Promise<NoteMeta>
  createNote(folder: NoteFolder, title?: string, subpath?: string): Promise<NoteMeta>
  /** Create a new `.excalidraw` drawing seeded with an empty scene. */
  createExcalidraw(folder: NoteFolder, subpath?: string, title?: string): Promise<NoteMeta>
  /** Convert an Obsidian Excalidraw markdown drawing into a native `.excalidraw`. (#266) */
  convertObsidianExcalidraw?(relPath: string): Promise<NoteMeta>
  renameNote(relPath: string, nextTitle: string): Promise<NoteMeta>
  deleteNote(relPath: string): Promise<void>
  moveToTrash(relPath: string): Promise<NoteMeta>
  restoreFromTrash(relPath: string): Promise<NoteMeta>
  emptyTrash(): Promise<void>
  archiveNote(relPath: string): Promise<NoteMeta>
  unarchiveNote(relPath: string): Promise<NoteMeta>
  duplicateNote(relPath: string): Promise<NoteMeta>
  exportNotePdf(relPath: string): Promise<string | null>
  /** Export as a Word document with real Word styles; resolves to the saved
   *  path, or null when the dialog was cancelled. Desktop, local vaults. */
  exportNoteDocx(relPath: string): Promise<string | null>
  revealNote(relPath: string): Promise<void>
  /** Reveal the original target of a symlinked note in the OS file manager. */
  revealNoteTarget(relPath: string): Promise<void>
  /** Reveal an arbitrary file path in the OS file manager (desktop only). */
  revealFilePath(absPath: string): Promise<void>
  /**
   * Open a file that lives outside the vault with the OS default app (desktop
   * only). Accepts a raw markdown-link href: a `file://` URL, a `~/…` home path,
   * or an absolute path. Returns `{ ok: false, error }` on the web (no OS) or
   * when the open fails, so callers can surface a message.
   */
  openExternalFile(href: string): Promise<{ ok: boolean; error?: string }>
  /** Open a URL through the host after checking enabled application schemes. */
  openExternalUrl(url: string): Promise<ExternalUrlResult>
  /**
   * Open a VAULT asset (vault-relative path) with the OS default app. Unlike
   * `openExternalFile` this resolves against the vault the host actually has:
   * a local vault opens the file in place, a remote workspace downloads the
   * asset to a temp file first — the server's absolute path does not exist on
   * this machine. Returns `{ ok: false, error }` on the web or on failure.
   */
  openAssetExternally(relPath: string): Promise<{ ok: boolean; error?: string }>
  /**
   * Fetch open-graph metadata for a URL to render a bookmark card. Desktop
   * fetches and parses the page in the main process; the web build returns a
   * minimal record. Never throws — `ok: false` on failure.
   */
  fetchLinkMetadata(url: string): Promise<LinkMetadata>
  moveNote(relPath: string, targetFolder: NoteFolder, targetSubpath: string): Promise<NoteMeta>
  importFilesToNote(notePath: string, sourcePaths: string[]): Promise<ImportedAsset[]>
  importPastedImage(input: PastedImageInput): Promise<ImportedAsset>
  /** Read an asset from the active vault without exposing a host filesystem path. */
  readVaultAssetBase64(assetPath: string): Promise<string>
  renameAsset(relPath: string, nextName: string): Promise<AssetMeta>
  moveAsset(relPath: string, targetDir: string): Promise<AssetMeta>
  duplicateAsset(relPath: string): Promise<AssetMeta>
  deleteAsset(relPath: string): Promise<DeletedAsset>
  restoreDeletedAsset(asset: DeletedAsset): Promise<AssetMeta>
  listDeletedAssets(): Promise<DeletedAsset[]>
  purgeDeletedAsset(undoToken: string): Promise<void>
  emptyDeletedAssets(): Promise<void>
  createFolder(folder: NoteFolder, subpath: string): Promise<void>
  renameFolder(folder: NoteFolder, oldSubpath: string, newSubpath: string): Promise<string>
  deleteFolder(folder: NoteFolder, subpath: string): Promise<void>
  duplicateFolder(folder: NoteFolder, subpath: string): Promise<string>
  revealFolder(folder: NoteFolder, subpath: string): Promise<void>
  /** Open the original target directory of a symlinked folder in the OS file manager. */
  revealFolderTarget(folder: NoteFolder, subpath: string): Promise<void>
  revealAssetsDir(): Promise<void>
  getPathForFile(file: File): string | null
  /** Open a folder as a temporary session (drag a folder onto the app to read
   *  it without turning it into a vault). Desktop-only. */
  openFolderTemporary(absPath: string): Promise<void>
  resolveLocalAssetUrl(vaultRoot: string, notePath: string, href: string): string | null
  resolveVaultAssetUrl(vaultRoot: string, assetPath: string): string | null

  onVaultChange(cb: (ev: VaultChangeEvent) => void): () => void
  onOpenSettings(cb: () => void): () => void
  onOpenNoteRequested(cb: (relPath: string) => void): () => void
  /** Escape was pressed while a subframe (an embedded video player) owned the
   *  keyboard. Keys inside a cross-origin frame never reach the page, so the
   *  desktop main process relays this one; the app hands focus back to the
   *  note. Desktop-only, the web build has no hook below the page. */
  onFrameEscape?(cb: () => void): () => void
  notifyRendererReady(): void
  onAppUpdateState(cb: (state: AppUpdateState) => void): () => void

  windowMinimize(): void
  windowToggleMaximize(): void
  windowClose(): void
  openNoteWindow(relPath: string): Promise<void>
  /** Open a vault in a new window. With a `root`, opens that known vault
   *  directly; without one, prompts with the folder picker. */
  openVaultWindow(root?: string): Promise<VaultInfo | null>

  /** Read the markdown file bound to the current standalone editor window. */
  readExternalFile(): Promise<ExternalFileContent>
  /** Save the current standalone editor window's file back to disk. */
  writeExternalFile(body: string): Promise<void>
  /** Move the current standalone editor window's file into the active vault. */
  moveExternalFileToVault(): Promise<MoveExternalFileResult>
  /**
   * Follow a link from the current standalone editor window's file. The host
   * resolves it against the file's directory (a relative href, or a wikilink
   * by name within that directory's tree) and opens a markdown target the way
   * Finder would (its vault, else another standalone window) or any other
   * file with the OS. Resolves `ok: false` with a reason when nothing on disk
   * matches. Desktop only.
   */
  followExternalFileLink(link: ExternalFileLink): Promise<{ ok: boolean; error?: string }>
  /**
   * Open a markdown file from an absolute OS path — as a note when it lives
   * inside a known vault, otherwise a standalone external-file window. The
   * drag-and-drop counterpart of the Finder "Open in ZenNotes" entry.
   * Resolves to true when a window was opened or focused. Desktop only; the
   * web bridge is a no-op that resolves to false.
   */
  openMarkdownFile(absPath: string): Promise<boolean>
  /**
   * Show a native "Open File…" picker for a markdown file and open the choice
   * the same vault-aware way as `openMarkdownFile` — the in-app equivalent of
   * the Finder "Open in ZenNotes" entry (#449). Resolves to true when a file
   * was opened. Desktop only; the web bridge resolves to false.
   */
  openFileDialog(): Promise<boolean>
  toggleQuickCapture(): Promise<void>
  getQuickCaptureHotkey(): Promise<string>
  setQuickCaptureHotkey(hotkey: string): Promise<{ ok: boolean; hotkey: string; error?: string }>
  /** Whether the quick-capture window stays pinned on top (won't hide on blur). */
  getQuickCapturePinned(): Promise<boolean>
  setQuickCapturePinned(pinned: boolean): Promise<boolean>
  /** Desktop only (#947): whether closing the last window hides it to the
   *  tray instead. Optional so the web and phone bridges need no stub. */
  getKeepRunningInTray?(): Promise<boolean>
  /** Resolves to the setting now in effect. */
  setKeepRunningInTray?(enabled: boolean): Promise<boolean>
  /** Hide this window to the tray. Resolves false, and leaves the window
   *  alone, while the tray is off: a hidden window would be unreachable. */
  hideWindowToTray?(): Promise<boolean>
  /** This window's Cloud sync state for the tray; null when there is none. */
  reportTraySyncStatus?(status: TraySyncStatus | null): void
  /** Quit the app for real. Linux and Windows have no app menu, so with the
   *  tray holding the window this is the way out besides the icon's menu. */
  quitApp?(): void
  renderTikz(source: string): Promise<TikzRenderResponse>

  mcpGetRuntime(): Promise<McpServerRuntime>
  mcpGetStatuses(): Promise<McpClientStatus[]>
  mcpInstall(id: McpClientId): Promise<McpClientStatus>
  mcpUninstall(id: McpClientId): Promise<McpClientStatus>
  /** Desktop only: whether assistants can use the token of the server the app
   *  is on (#830). Optional so the web and phone bridges need no stub. */
  mcpGetServerTokenState?(): Promise<McpServerTokenState>
  /** Desktop only: saves the app's token for that server where zn and the MCP
   *  servers look. */
  mcpShareServerToken?(): Promise<McpServerTokenState>
  /** Desktop only: removes it again, only when it is still the app's token. */
  mcpRemoveServerToken?(): Promise<McpServerTokenState>
  mcpGetInstructions(): Promise<McpInstructionsPayload>
  mcpSetInstructions(next: string | null): Promise<McpInstructionsPayload>
  cliGetStatus(): Promise<CliInstallStatus>
  cliInstall(request?: CliInstallRequest): Promise<CliInstallStatus>
  cliUninstall(): Promise<CliInstallStatus>
  /** Desktop only: the managed `zn` version and its update state. */
  cliUpdateGetState?(): Promise<CliUpdateState>
  /** Desktop only: check the latest signed CLI release now. */
  cliUpdateCheck?(request: CliUpdateCheckRequest): Promise<CliUpdateState>
  /** Desktop only: install newer CLI releases automatically or only report them. */
  cliSetAutoUpdate?(enabled: boolean): Promise<CliUpdateState>
  /** Desktop only: every change to the CLI update state, including scheduled checks. */
  onCliUpdateState?(cb: (state: CliUpdateState) => void): () => void
  raycastGetStatus(): Promise<RaycastExtensionStatus>
  raycastInstall(): Promise<RaycastExtensionStatus>
  clipboardWriteText(text: string): void
  clipboardReadText(): string

  /**
   * Portable preferences read synchronously from the on-disk config file at
   * startup (desktop). Returns null on platforms without a config file (web),
   * where the renderer falls back to localStorage. An empty object means the
   * file doesn't exist yet — the renderer seeds it from current prefs.
   */
  getConfigSync(): AppConfigPortable | null
  /** Persist the portable preferences subset to the config file (debounced by
   *  the caller). No-op on web. */
  setConfig(next: AppConfigPortable): Promise<void>
  /** Absolute path of the config file, or null when unsupported (web). */
  getConfigPath(): Promise<string | null>
  /** Create the config file if needed and reveal it in the OS file manager. */
  revealConfigFile(): Promise<void>
  /** Subscribe to external edits of the config file (e.g. a synced dotfile or
   *  a hand-edit). The callback receives the new portable config. */
  onConfigChange(cb: (next: AppConfigPortable) => void): () => void
  /** User themes loaded from `~/.config/zennotes/themes/<slug>/`. Empty on web. */
  listCustomThemes(): Promise<CustomTheme[]>
  /** Absolute path of the custom-themes directory, or null when unsupported. */
  getCustomThemesDir(): Promise<string | null>
  /** Reveal the themes directory in the file manager — or a specific theme's
   *  `theme.css` when a slug is given (creating the dir if needed). */
  revealCustomThemesDir(slug?: string): Promise<void>
  /** Delete a custom theme's folder (`<slug>/`) from the themes directory. */
  deleteCustomTheme(slug: string): Promise<void>
  /** Scaffold a new theme folder from a starter palette. Resolves to the new
   *  slug, or null on failure / when unsupported (web). */
  createCustomTheme(input: { name?: string }): Promise<string | null>
  /** Subscribe to changes in the themes directory (file added/edited/removed). */
  onCustomThemesChange(cb: (next: CustomTheme[]) => void): () => void
  listCustomCodeLanguages(): Promise<CustomCodeLanguage[]>
  installCustomCodeLanguage(input: CustomCodeLanguageInstallInput): Promise<CustomCodeLanguage>
  updateCustomCodeLanguage(input: CustomCodeLanguageUpdateInput): Promise<CustomCodeLanguage>
  revealCustomCodeLanguagesDir(id?: string): Promise<void>
  deleteCustomCodeLanguage(id: string): Promise<void>
  onCustomCodeLanguagesChange(cb: (next: CustomCodeLanguage[]) => void): () => void
  /** CSS overrides from `~/.config/zennotes/overrides/*.css`. Empty on web. */
  listOverrides(): Promise<Override[]>
  /** Reveal the overrides directory — or a specific override file when a name is
   *  given (creating the dir if needed). */
  revealOverridesDir(name?: string): Promise<void>
  /** Delete a override file (`<name>`) from the overrides directory. */
  deleteOverride(name: string): Promise<void>
  /** Subscribe to changes in the overrides directory. */
  onOverridesChange(cb: (next: Override[]) => void): () => void
  /** Open/close the renderer's developer tools (for inspecting elements while
   *  authoring themes/overrides). No-op on web. */
  toggleDevTools(): Promise<void>
}

let installedBridge: ZenBridge | null = null

function getWindowHost(): { zen: ZenBridge } | undefined {
  const host = globalThis as typeof globalThis & { window?: { zen: ZenBridge } }
  return typeof host.window === 'object' ? host.window : undefined
}

export function installZenBridge(bridge: ZenBridge): ZenBridge {
  installedBridge = bridge
  const windowHost = getWindowHost()
  if (windowHost && !windowHost.zen) {
    windowHost.zen = bridge
  }
  return bridge
}

export function getZenBridge(): ZenBridge {
  if (installedBridge) return installedBridge
  const windowHost = getWindowHost()
  if (windowHost?.zen) return windowHost.zen
  throw new Error('Zen bridge has not been installed')
}

declare global {
  interface Window {
    zen: ZenBridge
  }
}

export {}
