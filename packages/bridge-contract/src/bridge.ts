import type {
  AppUpdateState,
  AssetMeta,
  CliInstallStatus,
  DeletedAsset,
  ExternalFileContent,
  FolderEntry,
  ImportedAsset,
  LocalVaultEntry,
  MoveExternalFileResult,
  ListNotesPageRequest,
  ListNotesPageResponse,
  NoteComment,
  NoteCommentInput,
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
  VaultChangeEvent,
  VaultDemoTourResult,
  VaultInfo,
  VaultTextSearchBackendPreference,
  VaultTextSearchCapabilities,
  VaultTextSearchMatch,
  VaultTextSearchToolPaths
} from './ipc'
import type { CustomTemplateFile, WriteTemplateInput } from './templates'
import type { VaultTask } from '@zennotes/shared-domain/tasks'
import type {
  DatabaseDoc,
  DatabaseSidecar,
  DatabaseSummary,
  DbRow
} from '@zennotes/shared-domain/databases'
import type {
  McpClientId,
  McpClientStatus,
  McpInstructionsPayload,
  McpServerRuntime
} from '@zennotes/shared-domain/mcp-clients'
import type { AppConfigPortable } from '@zennotes/shared-domain/app-config'
import type { CustomTheme } from '@zennotes/shared-domain/custom-themes'
import type { Override } from '@zennotes/shared-domain/overrides'

export interface ZenCapabilities {
  supportsUpdater: boolean
  supportsNativeMenus: boolean
  supportsFloatingWindows: boolean
  supportsLocalFilesystemPickers: boolean
  supportsRemoteWorkspace: boolean
  supportsCliInstall: boolean
  /** Custom templates require local-filesystem CRUD; false on web/remote. */
  supportsCustomTemplates: boolean
}

export interface ZenAppInfo {
  name: string
  productName: string
  version: string
  description: string
  homepage?: string
  runtime: 'desktop' | 'web'
}

export interface ZenBridge {
  getCapabilities(): ZenCapabilities
  getAppInfo(): ZenAppInfo

  platform(): Promise<NodeJS.Platform>
  platformSync(): NodeJS.Platform
  listSystemFonts(): Promise<string[]>
  getAppIconDataUrl(): Promise<string | null>
  zoomInApp(): Promise<number>
  zoomOutApp(): Promise<number>
  resetAppZoom(): Promise<number>
  getAppUpdateState(): Promise<AppUpdateState>
  checkForAppUpdates(): Promise<AppUpdateState>
  checkForAppUpdatesWithUi(): Promise<void>
  downloadAppUpdate(): Promise<AppUpdateState>
  installAppUpdate(): Promise<void>
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
  scanTasks(): Promise<VaultTask[]>
  scanTasksForPath(relPath: string): Promise<VaultTask[]>
  /** Resolves to null when the `.csv` no longer exists (e.g. a stale tab). */
  openDatabase(relPath: string): Promise<DatabaseDoc | null>
  writeDatabaseRows(relPath: string, rows: DbRow[]): Promise<DatabaseDoc>
  writeDatabaseSchema(relPath: string, sidecar: DatabaseSidecar, rows: DbRow[]): Promise<DatabaseDoc>
  createDatabase(folder: NoteFolder, subpath: string, title?: string): Promise<DatabaseDoc>
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
  revealNote(relPath: string): Promise<void>
  /** Reveal the original target of a symlinked note in the OS file manager. */
  revealNoteTarget(relPath: string): Promise<void>
  /** Reveal an arbitrary file path in the OS file manager (desktop only). */
  revealFilePath(absPath: string): Promise<void>
  moveNote(relPath: string, targetFolder: NoteFolder, targetSubpath: string): Promise<NoteMeta>
  importFilesToNote(notePath: string, sourcePaths: string[]): Promise<ImportedAsset[]>
  importPastedImage(input: PastedImageInput): Promise<ImportedAsset>
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
  resolveLocalAssetUrl(vaultRoot: string, notePath: string, href: string): string | null
  resolveVaultAssetUrl(vaultRoot: string, assetPath: string): string | null

  onVaultChange(cb: (ev: VaultChangeEvent) => void): () => void
  onOpenSettings(cb: () => void): () => void
  onOpenNoteRequested(cb: (relPath: string) => void): () => void
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
   * Open a markdown file from an absolute OS path — as a note when it lives
   * inside a known vault, otherwise a standalone external-file window. The
   * drag-and-drop counterpart of the Finder "Open in ZenNotes" entry.
   * Resolves to true when a window was opened or focused. Desktop only; the
   * web bridge is a no-op that resolves to false.
   */
  openMarkdownFile(absPath: string): Promise<boolean>
  toggleQuickCapture(): Promise<void>
  getQuickCaptureHotkey(): Promise<string>
  setQuickCaptureHotkey(hotkey: string): Promise<{ ok: boolean; hotkey: string; error?: string }>
  /** Whether the quick-capture window stays pinned on top (won't hide on blur). */
  getQuickCapturePinned(): Promise<boolean>
  setQuickCapturePinned(pinned: boolean): Promise<boolean>
  renderTikz(source: string): Promise<TikzRenderResponse>

  mcpGetRuntime(): Promise<McpServerRuntime>
  mcpGetStatuses(): Promise<McpClientStatus[]>
  mcpInstall(id: McpClientId): Promise<McpClientStatus>
  mcpUninstall(id: McpClientId): Promise<McpClientStatus>
  mcpGetInstructions(): Promise<McpInstructionsPayload>
  mcpSetInstructions(next: string | null): Promise<McpInstructionsPayload>
  cliGetStatus(): Promise<CliInstallStatus>
  cliInstall(): Promise<CliInstallStatus>
  cliUninstall(): Promise<CliInstallStatus>
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
