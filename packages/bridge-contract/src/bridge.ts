import type {
  AppUpdateState,
  AssetMeta,
  CliInstallStatus,
  FolderEntry,
  ImportedAsset,
  ListNotesPageRequest,
  ListNotesPageResponse,
  NoteComment,
  NoteCommentInput,
  NoteContent,
  NoteFolder,
  NoteMeta,
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
import type { VaultTask } from '@zennotes/shared-domain/tasks'
import type {
  McpClientId,
  McpClientStatus,
  McpInstructionsPayload,
  McpServerRuntime
} from '@zennotes/shared-domain/mcp-clients'

export interface ZenCapabilities {
  supportsUpdater: boolean
  supportsNativeMenus: boolean
  supportsFloatingWindows: boolean
  supportsLocalFilesystemPickers: boolean
  supportsRemoteWorkspace: boolean
  supportsCliInstall: boolean
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
  pickVault(): Promise<VaultInfo | null>
  selectVaultPath(path: string): Promise<VaultInfo>
  browseServerDirectories(path?: string): Promise<DirectoryBrowseResult>
  getVaultSettings(): Promise<VaultSettings>
  setVaultSettings(next: VaultSettings): Promise<VaultSettings>

  listNotes(): Promise<NoteMeta[]>
  listNotesPage?(request: ListNotesPageRequest): Promise<ListNotesPageResponse>
  listFolders(): Promise<FolderEntry[]>
  listAssets(): Promise<AssetMeta[]>
  hasAssetsDir(): Promise<boolean>
  generateDemoTour(): Promise<VaultDemoTourResult>
  removeDemoTour(): Promise<VaultDemoTourResult>
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
  writeNote(relPath: string, body: string): Promise<NoteMeta>
  appendToNote(relPath: string, body: string, position: 'start' | 'end'): Promise<NoteMeta>
  createNote(folder: NoteFolder, title?: string, subpath?: string): Promise<NoteMeta>
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
  moveNote(relPath: string, targetFolder: NoteFolder, targetSubpath: string): Promise<NoteMeta>
  importFilesToNote(notePath: string, sourcePaths: string[]): Promise<ImportedAsset[]>
  createFolder(folder: NoteFolder, subpath: string): Promise<void>
  renameFolder(folder: NoteFolder, oldSubpath: string, newSubpath: string): Promise<string>
  deleteFolder(folder: NoteFolder, subpath: string): Promise<void>
  duplicateFolder(folder: NoteFolder, subpath: string): Promise<string>
  revealFolder(folder: NoteFolder, subpath: string): Promise<void>
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
  toggleQuickCapture(): Promise<void>
  getQuickCaptureHotkey(): Promise<string>
  setQuickCaptureHotkey(hotkey: string): Promise<{ ok: boolean; hotkey: string; error?: string }>
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
