import { clipboard, contextBridge, ipcRenderer, webUtils } from 'electron'
import path from 'node:path'
import appPackage from '../../package.json'
import type {
  ZenAppInfo,
  ZenBridge,
  ZenCapabilities
} from '@zennotes/bridge-contract/bridge'
import type {
  CustomTemplateFile,
  WriteTemplateInput
} from '@zennotes/bridge-contract/templates'
import type {
  CloudAccountConnectResult,
  CloudAccountStatus,
  CloudBackupNoteRestoreResult,
  CloudBackupRestoreResult,
  CloudBackupSchedule,
  CloudBackupSnapshot,
  CloudBackupSnapshotItem,
  CloudPublishedNote,
  CloudPublishedNoteResult,
  CloudPublishNoteInput,
  CloudServiceAccount,
  CloudSyncRunSummary,
  CloudSyncSettingsChoice,
  CloudSyncSettingsConflict,
  CloudSyncVault,
  CloudVaultLink
} from '@zennotes/bridge-contract/cloud-sync'
import type {
  ApplyWorkflowInput,
  ExportWorkflowInput,
  ImportedWorkflowFile,
  WorkflowFile,
  WorkflowRunReceipt,
  WorkflowRunSummary,
  WorkflowUndoResult,
  WriteWorkflowInput
} from '@zennotes/bridge-contract/workflows'
import { IPC } from '@shared/ipc'
import type { AppConfigPortable } from '@shared/app-config'
import type { CustomTheme } from '@shared/custom-themes'
import type { Override } from '@shared/overrides'
import type {
  CustomCodeLanguage,
  CustomCodeLanguageInstallInput,
  CustomCodeLanguageUpdateInput
} from '@shared/custom-code-languages'
import type {
  AppUpdateState,
  AssetMeta,
  CliInstallStatus,
  DeletedAsset,
  DirectoryBrowseResult,
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
  NoteContent,
  NoteFolder,
  NoteMeta,
  PastedImageInput,
  RaycastExtensionStatus,
  RemoteWorkspaceInfo,
  RemoteWorkspaceProfile,
  RemoteWorkspaceProfileInput,
  ServerCapabilities,
  ServerSessionStatus,
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
import type { DatabaseDoc, DatabaseSidecar, DatabaseSummary, DbRow } from '@shared/databases'
import type {
  McpClientId,
  McpClientStatus,
  McpInstructionsPayload,
  McpServerRuntime
} from '@shared/mcp-clients'

const DESKTOP_CAPABILITIES: ZenCapabilities = {
  supportsUpdater: true,
  supportsNativeMenus: true,
  supportsFloatingWindows: true,
  supportsLocalFilesystemPickers: true,
  supportsRemoteWorkspace: true,
  supportsCloudSync: true,
  // CLI install is supported on macOS and Linux via /usr/local/bin or
  // ~/.local/bin symlinks. Windows uses a different model (PATH munging)
  // and is gated to a follow-up.
  supportsCliInstall: process.platform === 'darwin' || process.platform === 'linux',
  supportsCustomTemplates: true,
  supportsCustomCodeLanguages: true,
  supportsWorkflows: true
}

const DESKTOP_APP_INFO: ZenAppInfo = {
  name: appPackage.name,
  productName: appPackage.productName,
  version: appPackage.version,
  description: appPackage.description,
  homepage: appPackage.homepage,
  runtime: 'desktop'
}

let remoteWorkspaceInfo: RemoteWorkspaceInfo | null = null
const LIST_NOTES_STREAM_CHUNK_SIZE = 250

async function refreshRemoteWorkspaceInfo(): Promise<RemoteWorkspaceInfo | null> {
  try {
    remoteWorkspaceInfo = await ipcRenderer.invoke(IPC.WORKSPACE_GET_INFO)
  } catch {
    remoteWorkspaceInfo = null
  }
  return remoteWorkspaceInfo
}

void refreshRemoteWorkspaceInfo()

function yieldRendererTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function listNotesStreamed(): Promise<NoteMeta[]> {
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const notes: NoteMeta[] = []
  let offset = 0

  for (;;) {
    const page = (await ipcRenderer.invoke(IPC.VAULT_LIST_NOTES_STREAM, {
      requestId,
      offset,
      chunkSize: LIST_NOTES_STREAM_CHUNK_SIZE
    })) as ListNotesPageResponse
    if (Array.isArray(page.notes) && page.notes.length > 0) {
      notes.push(...page.notes)
    }
    if (page.done) return notes
    offset = page.nextOffset
    await yieldRendererTask()
  }
}

function stripQueryAndHash(value: string): string {
  const hashIdx = value.indexOf('#')
  const queryIdx = value.indexOf('?')
  const cutIdx =
    hashIdx === -1
      ? queryIdx
      : queryIdx === -1
        ? hashIdx
        : Math.min(hashIdx, queryIdx)
  return cutIdx === -1 ? value : value.slice(0, cutIdx)
}

function decodeHrefPath(value: string): string {
  const cleaned = stripQueryAndHash(value)
  try {
    return decodeURIComponent(cleaned)
  } catch {
    return cleaned
  }
}

function resolveVaultRelativeAssetPath(notePath: string, href: string): string | null {
  const trimmed = href.trim()
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return null
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) return null

  const normalizedNotePath = notePath.split(path.sep).join('/')
  const noteDir = path.posix.dirname(normalizedNotePath)
  const decodedHref = decodeHrefPath(trimmed)
  const relativeTarget = decodedHref.startsWith('/')
    ? decodedHref.replace(/^\/+/, '')
    : path.posix.normalize(path.posix.join(noteDir === '.' ? '' : noteDir, decodedHref))
  if (relativeTarget === '..' || relativeTarget.startsWith('../')) return null
  return relativeTarget
}

function remoteAssetUrl(assetPath: string): string | null {
  if (remoteWorkspaceInfo?.mode !== 'remote' || !remoteWorkspaceInfo.baseUrl) return null
  const trimmed = assetPath.trim()
  if (!trimmed) return null
  return `zen-asset://remote?baseUrl=${encodeURIComponent(
    remoteWorkspaceInfo.baseUrl.replace(/\/+$/, '')
  )}&path=${encodeURIComponent(trimmed)}`
}

const api: ZenBridge = {
  getCapabilities: (): ZenCapabilities => DESKTOP_CAPABILITIES,
  getAppInfo: (): ZenAppInfo => DESKTOP_APP_INFO,
  platform: (): Promise<NodeJS.Platform> => ipcRenderer.invoke(IPC.APP_PLATFORM),
  platformSync: (): NodeJS.Platform => process.platform,
  listSystemFonts: (): Promise<string[]> => ipcRenderer.invoke(IPC.APP_LIST_FONTS),
  getAppIconDataUrl: (): Promise<string | null> => ipcRenderer.invoke(IPC.APP_ICON_DATA_URL),
  zoomInApp: (): Promise<number> => ipcRenderer.invoke(IPC.APP_ZOOM_IN),
  zoomOutApp: (): Promise<number> => ipcRenderer.invoke(IPC.APP_ZOOM_OUT),
  resetAppZoom: (): Promise<number> => ipcRenderer.invoke(IPC.APP_ZOOM_RESET),
  getAppUpdateState: (): Promise<AppUpdateState> => ipcRenderer.invoke(IPC.APP_UPDATER_GET_STATE),
  checkForAppUpdates: (): Promise<AppUpdateState> => ipcRenderer.invoke(IPC.APP_UPDATER_CHECK),
  checkForAppUpdatesWithUi: (): Promise<void> =>
    ipcRenderer.invoke(IPC.APP_UPDATER_CHECK_WITH_UI),
  downloadAppUpdate: (): Promise<AppUpdateState> => ipcRenderer.invoke(IPC.APP_UPDATER_DOWNLOAD),
  installAppUpdate: (): Promise<void> => ipcRenderer.invoke(IPC.APP_UPDATER_INSTALL),
  getCloudAccountStatus: (): Promise<CloudAccountStatus> =>
    ipcRenderer.invoke(IPC.CLOUD_ACCOUNT_GET),
  connectCloudAccount: (baseUrl?: string): Promise<CloudAccountConnectResult> =>
    ipcRenderer.invoke(IPC.CLOUD_ACCOUNT_CONNECT, baseUrl),
  logoutCloudAccount: (): Promise<CloudAccountStatus> =>
    ipcRenderer.invoke(IPC.CLOUD_ACCOUNT_LOGOUT),
  onCloudAccountChange: (cb: (status: CloudAccountStatus) => void): (() => void) => {
    const listener = (_: unknown, status: CloudAccountStatus): void => cb(status)
    ipcRenderer.on(IPC.CLOUD_ACCOUNT_ON_CHANGE, listener)
    return () => ipcRenderer.removeListener(IPC.CLOUD_ACCOUNT_ON_CHANGE, listener)
  },
  getCloudServiceAccount: (): Promise<CloudServiceAccount> =>
    ipcRenderer.invoke(IPC.CLOUD_SERVICE_ACCOUNT_GET),
  listCloudPublishedNotes: (): Promise<CloudPublishedNote[]> =>
    ipcRenderer.invoke(IPC.CLOUD_PUBLISHED_NOTES_LIST),
  publishCloudNote: (input: CloudPublishNoteInput): Promise<CloudPublishedNoteResult> =>
    ipcRenderer.invoke(IPC.CLOUD_PUBLISHED_NOTE_CREATE, input),
  updateCloudPublishedNote: (
    shareId: number,
    input: CloudPublishNoteInput
  ): Promise<CloudPublishedNoteResult> =>
    ipcRenderer.invoke(IPC.CLOUD_PUBLISHED_NOTE_UPDATE, shareId, input),
  unpublishCloudNote: (shareId: number): Promise<void> =>
    ipcRenderer.invoke(IPC.CLOUD_PUBLISHED_NOTE_DELETE, shareId),
  listCloudVaults: (): Promise<CloudSyncVault[]> => ipcRenderer.invoke(IPC.CLOUD_VAULTS_LIST),
  getCloudVaultLink: (): Promise<CloudVaultLink | null> =>
    ipcRenderer.invoke(IPC.CLOUD_VAULT_LINK_GET),
  linkCloudVault: (vaultId: string): Promise<CloudVaultLink> =>
    ipcRenderer.invoke(IPC.CLOUD_VAULT_LINK_SET, vaultId),
  createAndLinkCloudVault: (name: string): Promise<CloudVaultLink> =>
    ipcRenderer.invoke(IPC.CLOUD_VAULT_LINK_CREATE, name),
  unlinkCloudVault: (): Promise<void> => ipcRenderer.invoke(IPC.CLOUD_VAULT_LINK_DELETE),
  deleteCloudVault: (): Promise<void> => ipcRenderer.invoke(IPC.CLOUD_VAULT_DELETE),
  syncCloudVault: (): Promise<CloudSyncRunSummary> => ipcRenderer.invoke(IPC.CLOUD_VAULT_SYNC),
  getCloudSettingsConflict: (): Promise<CloudSyncSettingsConflict | null> =>
    ipcRenderer.invoke(IPC.CLOUD_VAULT_SETTINGS_CONFLICT_GET),
  resolveCloudSettingsConflict: (choice: CloudSyncSettingsChoice): Promise<void> =>
    ipcRenderer.invoke(IPC.CLOUD_VAULT_SETTINGS_CONFLICT_RESOLVE, choice),
  listCloudBackups: (): Promise<CloudBackupSnapshot[]> =>
    ipcRenderer.invoke(IPC.CLOUD_BACKUPS_LIST),
  getCloudBackupSchedule: (): Promise<CloudBackupSchedule> =>
    ipcRenderer.invoke(IPC.CLOUD_BACKUP_SCHEDULE_GET),
  updateCloudBackupSchedule: (enabled: boolean): Promise<CloudBackupSchedule> =>
    ipcRenderer.invoke(IPC.CLOUD_BACKUP_SCHEDULE_UPDATE, enabled),
  listCloudBackupItems: (backupId: string): Promise<CloudBackupSnapshotItem[]> =>
    ipcRenderer.invoke(IPC.CLOUD_BACKUP_ITEMS_LIST, backupId),
  createCloudBackup: (label?: string): Promise<CloudBackupSnapshot> =>
    ipcRenderer.invoke(IPC.CLOUD_BACKUP_CREATE, label),
  downloadCloudBackup: (backupId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.CLOUD_BACKUP_DOWNLOAD, backupId),
  deleteCloudBackup: (backupId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.CLOUD_BACKUP_DELETE, backupId),
  restoreCloudBackup: (backupId: string): Promise<CloudBackupRestoreResult> =>
    ipcRenderer.invoke(IPC.CLOUD_BACKUP_RESTORE, backupId),
  restoreCloudBackupNote: (
    backupId: string,
    snapshotItemId: number,
  ): Promise<CloudBackupNoteRestoreResult> =>
    ipcRenderer.invoke(IPC.CLOUD_BACKUP_NOTE_RESTORE, backupId, snapshotItemId),
  getServerCapabilities: async (): Promise<ServerCapabilities | null> =>
    (await refreshRemoteWorkspaceInfo())?.capabilities ?? null,
  getServerSession: async (): Promise<ServerSessionStatus> => ({
    authenticated: true,
    authRequired: false,
    supportsSessionLogin: false
  }),
  loginServerSession: async (): Promise<ServerSessionStatus> => ({
    authenticated: true,
    authRequired: false,
    supportsSessionLogin: false
  }),
  logoutServerSession: async (): Promise<ServerSessionStatus> => ({
    authenticated: true,
    authRequired: false,
    supportsSessionLogin: false
  }),
  getRemoteWorkspaceInfo: async (): Promise<RemoteWorkspaceInfo | null> =>
    await refreshRemoteWorkspaceInfo(),
  connectRemoteWorkspace: async (
    baseUrl: string,
    authToken?: string | null
  ): Promise<{ vault: VaultInfo | null; capabilities: ServerCapabilities }> => {
    const result = await ipcRenderer.invoke(IPC.WORKSPACE_CONNECT_REMOTE, baseUrl, authToken ?? null)
    await refreshRemoteWorkspaceInfo()
    return result
  },
  disconnectRemoteWorkspace: async (): Promise<VaultInfo | null> => {
    const result = await ipcRenderer.invoke(IPC.WORKSPACE_DISCONNECT_REMOTE)
    await refreshRemoteWorkspaceInfo()
    return result
  },
  retryWorkspaceBoot: async (): Promise<VaultInfo | null> => {
    const result = await ipcRenderer.invoke(IPC.WORKSPACE_RETRY_BOOT)
    await refreshRemoteWorkspaceInfo()
    return result
  },
  listRemoteWorkspaceProfiles: async (): Promise<RemoteWorkspaceProfile[]> =>
    ipcRenderer.invoke(IPC.WORKSPACE_LIST_REMOTE_PROFILES),
  saveRemoteWorkspaceProfile: async (
    input: RemoteWorkspaceProfileInput
  ): Promise<RemoteWorkspaceProfile> => {
    const result = await ipcRenderer.invoke(IPC.WORKSPACE_SAVE_REMOTE_PROFILE, input)
    await refreshRemoteWorkspaceInfo()
    return result
  },
  deleteRemoteWorkspaceProfile: async (id: string): Promise<void> => {
    await ipcRenderer.invoke(IPC.WORKSPACE_DELETE_REMOTE_PROFILE, id)
    await refreshRemoteWorkspaceInfo()
  },
  connectRemoteWorkspaceProfile: async (
    id: string
  ): Promise<{ vault: VaultInfo | null; capabilities: ServerCapabilities }> => {
    const result = await ipcRenderer.invoke(IPC.WORKSPACE_CONNECT_REMOTE_PROFILE, id)
    await refreshRemoteWorkspaceInfo()
    return result
  },

  getCurrentVault: async (): Promise<VaultInfo | null> => {
    const vault = await ipcRenderer.invoke(IPC.VAULT_GET_CURRENT)
    await refreshRemoteWorkspaceInfo()
    return vault
  },
  listLocalVaults: async (): Promise<LocalVaultEntry[]> => {
    return await ipcRenderer.invoke(IPC.VAULT_LIST_LOCAL)
  },
  openLocalVault: async (root: string): Promise<VaultInfo | null> => {
    const vault = await ipcRenderer.invoke(IPC.VAULT_OPEN_LOCAL, root)
    await refreshRemoteWorkspaceInfo()
    return vault
  },
  closeVault: async (): Promise<VaultInfo | null> => {
    const vault = await ipcRenderer.invoke(IPC.VAULT_CLOSE)
    await refreshRemoteWorkspaceInfo()
    return vault
  },
  pickVault: async (): Promise<VaultInfo | null> => {
    const vault = await ipcRenderer.invoke(IPC.VAULT_PICK)
    await refreshRemoteWorkspaceInfo()
    return vault
  },
  selectVaultPath: async (targetPath: string): Promise<VaultInfo> => {
    const vault = await ipcRenderer.invoke(IPC.VAULT_SELECT_PATH, targetPath)
    await refreshRemoteWorkspaceInfo()
    return vault
  },
  browseServerDirectories: async (targetPath = ''): Promise<DirectoryBrowseResult> => {
    return await ipcRenderer.invoke(IPC.VAULT_BROWSE_SERVER_DIRECTORIES, targetPath)
  },
  getVaultSettings: (): Promise<VaultSettings> => ipcRenderer.invoke(IPC.VAULT_GET_SETTINGS),
  setVaultSettings: (next: VaultSettings): Promise<VaultSettings> =>
    ipcRenderer.invoke(IPC.VAULT_SET_SETTINGS, next),
  readWorkspaceState: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC.WORKSPACE_STATE_READ),
  writeWorkspaceState: (json: string): Promise<void> =>
    ipcRenderer.invoke(IPC.WORKSPACE_STATE_WRITE, json),
  rootContentHiddenByInboxMode: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC.VAULT_ROOT_CONTENT_HIDDEN),

  listNotes: (): Promise<NoteMeta[]> => listNotesStreamed(),
  listNotesPage: (request: ListNotesPageRequest): Promise<ListNotesPageResponse> =>
    ipcRenderer.invoke(IPC.VAULT_LIST_NOTES_STREAM, request),
  listFolders: (): Promise<FolderEntry[]> => ipcRenderer.invoke(IPC.VAULT_LIST_FOLDERS),
  listAssets: (): Promise<AssetMeta[]> => ipcRenderer.invoke(IPC.VAULT_LIST_ASSETS),
  hasAssetsDir: (): Promise<boolean> => ipcRenderer.invoke(IPC.VAULT_HAS_ASSETS_DIR),
  generateDemoTour: (): Promise<VaultDemoTourResult> =>
    ipcRenderer.invoke(IPC.VAULT_GENERATE_DEMO_TOUR),
  removeDemoTour: (): Promise<VaultDemoTourResult> =>
    ipcRenderer.invoke(IPC.VAULT_REMOVE_DEMO_TOUR),
  listWorkflows: (): Promise<WorkflowFile[]> => ipcRenderer.invoke(IPC.VAULT_LIST_WORKFLOWS),
  writeWorkflow: (input: WriteWorkflowInput): Promise<WorkflowFile> =>
    ipcRenderer.invoke(IPC.VAULT_WRITE_WORKFLOW, input),
  deleteWorkflow: (sourcePath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.VAULT_DELETE_WORKFLOW, sourcePath),
  // Sharing, both directions. A workflow is a plain `.md` file, so export is a
  // save dialog over the bytes already on disk and import is an open dialog
  // that READS one. Nothing here parses, and nothing here writes into the
  // vault: an imported file goes through the review and then `writeWorkflow`.
  exportWorkflow: (input: ExportWorkflowInput): Promise<string | null> =>
    ipcRenderer.invoke(IPC.VAULT_EXPORT_WORKFLOW, input),
  importWorkflowFile: (): Promise<ImportedWorkflowFile | null> =>
    ipcRenderer.invoke(IPC.VAULT_IMPORT_WORKFLOW_FILE),
  // Planning happens in the renderer and writes nothing; this is the separate,
  // explicit call that applies what the dry run showed.
  applyWorkflow: (input: ApplyWorkflowInput): Promise<WorkflowRunReceipt> =>
    ipcRenderer.invoke(IPC.VAULT_APPLY_WORKFLOW, input),
  undoWorkflowRun: (runId: string): Promise<WorkflowUndoResult> =>
    ipcRenderer.invoke(IPC.VAULT_UNDO_WORKFLOW_RUN, runId),
  listWorkflowRuns: (): Promise<WorkflowRunSummary[]> =>
    ipcRenderer.invoke(IPC.VAULT_LIST_WORKFLOW_RUNS),
  deleteWorkflowRuns: (workflowId: string): Promise<number> =>
    ipcRenderer.invoke(IPC.VAULT_DELETE_WORKFLOW_RUNS, workflowId),
  listTemplates: (): Promise<CustomTemplateFile[]> =>
    ipcRenderer.invoke(IPC.VAULT_LIST_TEMPLATES),
  readTemplate: (sourcePath: string): Promise<string> =>
    ipcRenderer.invoke(IPC.VAULT_READ_TEMPLATE, sourcePath),
  writeTemplate: (input: WriteTemplateInput): Promise<CustomTemplateFile> =>
    ipcRenderer.invoke(IPC.VAULT_WRITE_TEMPLATE, input),
  deleteTemplate: (sourcePath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.VAULT_DELETE_TEMPLATE, sourcePath),
  getVaultTextSearchCapabilities: (
    paths: VaultTextSearchToolPaths = {}
  ): Promise<VaultTextSearchCapabilities> =>
    ipcRenderer.invoke(IPC.VAULT_TEXT_SEARCH_CAPABILITIES, paths),
  searchVaultText: (
    query: string,
    backend: VaultTextSearchBackendPreference = 'auto',
    paths: VaultTextSearchToolPaths = {}
  ): Promise<VaultTextSearchMatch[]> =>
    ipcRenderer.invoke(IPC.VAULT_SEARCH_TEXT, query, backend, paths),
  readNote: (relPath: string): Promise<NoteContent> => ipcRenderer.invoke(IPC.VAULT_READ_NOTE, relPath),
  readNoteComments: (relPath: string): Promise<NoteComment[]> =>
    ipcRenderer.invoke(IPC.VAULT_READ_COMMENTS, relPath),
  writeNoteComments: (relPath: string, comments: NoteCommentInput[]): Promise<NoteComment[]> =>
    ipcRenderer.invoke(IPC.VAULT_WRITE_COMMENTS, relPath, comments),
  scanTasks: (): Promise<VaultTask[]> => ipcRenderer.invoke(IPC.VAULT_SCAN_TASKS),
  scanTasksForPath: (relPath: string): Promise<VaultTask[]> =>
    ipcRenderer.invoke(IPC.VAULT_SCAN_TASKS_FOR, relPath),
  openDatabase: (relPath: string): Promise<DatabaseDoc | null> =>
    ipcRenderer.invoke(IPC.VAULT_OPEN_DATABASE, relPath),
  writeDatabaseRows: (relPath: string, rows: DbRow[]): Promise<DatabaseDoc> =>
    ipcRenderer.invoke(IPC.VAULT_WRITE_DATABASE_ROWS, relPath, rows),
  writeDatabaseSchema: (
    relPath: string,
    sidecar: DatabaseSidecar,
    rows: DbRow[]
  ): Promise<DatabaseDoc> =>
    ipcRenderer.invoke(IPC.VAULT_WRITE_DATABASE_SCHEMA, relPath, sidecar, rows),
  createDatabase: (folder: NoteFolder, subpath: string, title?: string): Promise<DatabaseDoc> =>
    ipcRenderer.invoke(IPC.VAULT_CREATE_DATABASE, folder, subpath, title),
  renameDatabase: (csvPath: string, newTitle: string): Promise<string> =>
    ipcRenderer.invoke(IPC.VAULT_RENAME_DATABASE, csvPath, newTitle),
  createRecordPage: (csvPath: string, title: string, body: string): Promise<string> =>
    ipcRenderer.invoke(IPC.VAULT_CREATE_RECORD_PAGE, csvPath, title, body),
  listDatabases: (): Promise<DatabaseSummary[]> => ipcRenderer.invoke(IPC.VAULT_LIST_DATABASES),
  writeNote: (relPath: string, body: string): Promise<NoteMeta> =>
    ipcRenderer.invoke(IPC.VAULT_WRITE_NOTE, relPath, body),
  appendToNote: (relPath: string, body: string, position: 'start' | 'end'): Promise<NoteMeta> =>
    ipcRenderer.invoke(IPC.VAULT_APPEND_NOTE, relPath, body, position),
  createNote: (folder: NoteFolder, title?: string, subpath?: string): Promise<NoteMeta> =>
    ipcRenderer.invoke(IPC.VAULT_CREATE_NOTE, folder, title, subpath),
  createExcalidraw: (folder: NoteFolder, subpath?: string, title?: string): Promise<NoteMeta> =>
    ipcRenderer.invoke(IPC.VAULT_CREATE_EXCALIDRAW, folder, subpath, title),
  convertObsidianExcalidraw: (relPath: string): Promise<NoteMeta> =>
    ipcRenderer.invoke(IPC.VAULT_CONVERT_OBSIDIAN_EXCALIDRAW, relPath),
  renameNote: (relPath: string, nextTitle: string): Promise<NoteMeta> =>
    ipcRenderer.invoke(IPC.VAULT_RENAME_NOTE, relPath, nextTitle),
  deleteNote: (relPath: string): Promise<void> => ipcRenderer.invoke(IPC.VAULT_DELETE_NOTE, relPath),
  moveToTrash: (relPath: string): Promise<NoteMeta> =>
    ipcRenderer.invoke(IPC.VAULT_MOVE_TO_TRASH, relPath),
  restoreFromTrash: (relPath: string): Promise<NoteMeta> =>
    ipcRenderer.invoke(IPC.VAULT_RESTORE_FROM_TRASH, relPath),
  emptyTrash: (): Promise<void> => ipcRenderer.invoke(IPC.VAULT_EMPTY_TRASH),
  archiveNote: (relPath: string): Promise<NoteMeta> =>
    ipcRenderer.invoke(IPC.VAULT_ARCHIVE_NOTE, relPath),
  unarchiveNote: (relPath: string): Promise<NoteMeta> =>
    ipcRenderer.invoke(IPC.VAULT_UNARCHIVE_NOTE, relPath),
  duplicateNote: (relPath: string): Promise<NoteMeta> =>
    ipcRenderer.invoke(IPC.VAULT_DUPLICATE_NOTE, relPath),
  exportNotePdf: (relPath: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.VAULT_EXPORT_NOTE_PDF, relPath),
  exportNoteDocx: (relPath: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.VAULT_EXPORT_NOTE_DOCX, relPath),
  revealNote: (relPath: string): Promise<void> => ipcRenderer.invoke(IPC.VAULT_REVEAL_NOTE, relPath),
  revealNoteTarget: (relPath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.VAULT_REVEAL_NOTE_TARGET, relPath),
  revealFilePath: (absPath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.VAULT_REVEAL_FILE_PATH, absPath),
  openExternalFile: (href: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.VAULT_OPEN_EXTERNAL_FILE, href),
  openAssetExternally: (relPath: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.VAULT_OPEN_ASSET_EXTERNALLY, relPath),
  fetchLinkMetadata: (url: string): Promise<LinkMetadata> =>
    ipcRenderer.invoke(IPC.VAULT_FETCH_LINK_METADATA, url),
  moveNote: (
    relPath: string,
    targetFolder: NoteFolder,
    targetSubpath: string
  ): Promise<NoteMeta> =>
    ipcRenderer.invoke(IPC.VAULT_MOVE_NOTE, relPath, targetFolder, targetSubpath),
  importFilesToNote: (notePath: string, sourcePaths: string[]): Promise<ImportedAsset[]> =>
    ipcRenderer.invoke(IPC.VAULT_IMPORT_FILES, notePath, sourcePaths),
  importPastedImage: (input: PastedImageInput): Promise<ImportedAsset> =>
    ipcRenderer.invoke(IPC.VAULT_IMPORT_PASTED_IMAGE, input),
  readVaultAssetBase64: (assetPath: string): Promise<string> =>
    ipcRenderer.invoke(IPC.VAULT_READ_ASSET_BASE64, assetPath),
  downloadAsset: (relPath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.VAULT_DOWNLOAD_ASSET, relPath),
  renameAsset: (relPath: string, nextName: string): Promise<AssetMeta> =>
    ipcRenderer.invoke(IPC.VAULT_RENAME_ASSET, relPath, nextName),
  moveAsset: (relPath: string, targetDir: string): Promise<AssetMeta> =>
    ipcRenderer.invoke(IPC.VAULT_MOVE_ASSET, relPath, targetDir),
  duplicateAsset: (relPath: string): Promise<AssetMeta> =>
    ipcRenderer.invoke(IPC.VAULT_DUPLICATE_ASSET, relPath),
  deleteAsset: (relPath: string): Promise<DeletedAsset> =>
    ipcRenderer.invoke(IPC.VAULT_DELETE_ASSET, relPath),
  restoreDeletedAsset: (asset: DeletedAsset): Promise<AssetMeta> =>
    ipcRenderer.invoke(IPC.VAULT_RESTORE_DELETED_ASSET, asset),
  listDeletedAssets: (): Promise<DeletedAsset[]> =>
    ipcRenderer.invoke(IPC.VAULT_LIST_DELETED_ASSETS),
  purgeDeletedAsset: (undoToken: string): Promise<void> =>
    ipcRenderer.invoke(IPC.VAULT_PURGE_DELETED_ASSET, undoToken),
  emptyDeletedAssets: (): Promise<void> => ipcRenderer.invoke(IPC.VAULT_EMPTY_DELETED_ASSETS),
  createFolder: (folder: NoteFolder, subpath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.VAULT_CREATE_FOLDER, folder, subpath),
  renameFolder: (folder: NoteFolder, oldSubpath: string, newSubpath: string): Promise<string> =>
    ipcRenderer.invoke(IPC.VAULT_RENAME_FOLDER, folder, oldSubpath, newSubpath),
  deleteFolder: (folder: NoteFolder, subpath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.VAULT_DELETE_FOLDER, folder, subpath),
  duplicateFolder: (folder: NoteFolder, subpath: string): Promise<string> =>
    ipcRenderer.invoke(IPC.VAULT_DUPLICATE_FOLDER, folder, subpath),
  revealFolder: (folder: NoteFolder, subpath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.VAULT_REVEAL_FOLDER, folder, subpath),
  revealFolderTarget: (folder: NoteFolder, subpath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.VAULT_REVEAL_FOLDER_TARGET, folder, subpath),
  revealAssetsDir: (): Promise<void> => ipcRenderer.invoke(IPC.VAULT_REVEAL_ASSETS_DIR),
  getPathForFile: (file: File): string | null => {
    try {
      return webUtils.getPathForFile(file) || null
    } catch {
      return null
    }
  },
  resolveLocalAssetUrl: (vaultRoot: string, notePath: string, href: string): string | null => {
    if (remoteWorkspaceInfo?.mode === 'remote') {
      const resolved = resolveVaultRelativeAssetPath(notePath, href)
      return resolved ? remoteAssetUrl(resolved) : null
    }

    const trimmed = href.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return null
    if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) return null

    const relativeTarget = resolveVaultRelativeAssetPath(notePath, href)
    if (!relativeTarget) return null
    const resolved = path.resolve(vaultRoot, relativeTarget.split('/').join(path.sep))
    const rootAbs = path.resolve(vaultRoot)
    if (resolved !== rootAbs && !resolved.startsWith(rootAbs + path.sep)) return null
    return `zen-asset://local?path=${encodeURIComponent(resolved)}`
  },
  resolveVaultAssetUrl: (vaultRoot: string, assetPath: string): string | null => {
    const trimmed = assetPath.trim()
    if (!trimmed) return null
    if (remoteWorkspaceInfo?.mode === 'remote') {
      return remoteAssetUrl(trimmed)
    }
    const resolved = path.resolve(vaultRoot, trimmed.split('/').join(path.sep))
    const rootAbs = path.resolve(vaultRoot)
    if (resolved !== rootAbs && !resolved.startsWith(rootAbs + path.sep)) return null
    return `zen-asset://local?path=${encodeURIComponent(resolved)}`
  },

  onVaultChange: (cb: (ev: VaultChangeEvent) => void): (() => void) => {
    const listener = (_: unknown, ev: VaultChangeEvent): void => cb(ev)
    ipcRenderer.on(IPC.VAULT_ON_CHANGE, listener)
    return () => ipcRenderer.removeListener(IPC.VAULT_ON_CHANGE, listener)
  },
  onOpenSettings: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on(IPC.APP_OPEN_SETTINGS, listener)
    return () => ipcRenderer.removeListener(IPC.APP_OPEN_SETTINGS, listener)
  },
  onOpenNoteRequested: (cb: (relPath: string) => void): (() => void) => {
    const listener = (_: unknown, relPath: string): void => cb(relPath)
    ipcRenderer.on(IPC.APP_OPEN_NOTE_REQUESTED, listener)
    return () => ipcRenderer.removeListener(IPC.APP_OPEN_NOTE_REQUESTED, listener)
  },
  onFrameEscape: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on(IPC.APP_FRAME_ESCAPE, listener)
    return () => ipcRenderer.removeListener(IPC.APP_FRAME_ESCAPE, listener)
  },
  notifyRendererReady: (): void => ipcRenderer.send(IPC.APP_RENDERER_READY),
  onAppUpdateState: (cb: (state: AppUpdateState) => void): (() => void) => {
    const listener = (_: unknown, state: AppUpdateState): void => cb(state)
    ipcRenderer.on(IPC.APP_UPDATER_ON_STATE, listener)
    return () => ipcRenderer.removeListener(IPC.APP_UPDATER_ON_STATE, listener)
  },

  windowMinimize: (): void => ipcRenderer.send(IPC.WINDOW_MINIMIZE),
  windowToggleMaximize: (): void => ipcRenderer.send(IPC.WINDOW_TOGGLE_MAXIMIZE),
  windowClose: (): void => ipcRenderer.send(IPC.WINDOW_CLOSE),
  openNoteWindow: (relPath: string): Promise<void> => ipcRenderer.invoke(IPC.WINDOW_OPEN_NOTE, relPath),
  openVaultWindow: async (root?: string): Promise<VaultInfo | null> => {
    const vault = await ipcRenderer.invoke(IPC.WINDOW_OPEN_VAULT, root ?? null)
    await refreshRemoteWorkspaceInfo()
    return vault
  },
  readExternalFile: (): Promise<ExternalFileContent> =>
    ipcRenderer.invoke(IPC.APP_READ_EXTERNAL_FILE),
  writeExternalFile: (body: string): Promise<void> =>
    ipcRenderer.invoke(IPC.APP_WRITE_EXTERNAL_FILE, body),
  moveExternalFileToVault: (): Promise<MoveExternalFileResult> =>
    ipcRenderer.invoke(IPC.APP_MOVE_EXTERNAL_FILE_TO_VAULT),
  followExternalFileLink: (link: ExternalFileLink): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.APP_FOLLOW_EXTERNAL_FILE_LINK, link),
  openMarkdownFile: (absPath: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.APP_OPEN_MARKDOWN_FILE, absPath),
  openFileDialog: (): Promise<boolean> => ipcRenderer.invoke(IPC.APP_OPEN_FILE_DIALOG),
  openFolderTemporary: (absPath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.APP_OPEN_FOLDER_TEMPORARY, absPath),
  toggleQuickCapture: (): Promise<void> =>
    ipcRenderer.invoke(IPC.WINDOW_TOGGLE_QUICK_CAPTURE),
  getQuickCaptureHotkey: (): Promise<string> =>
    ipcRenderer.invoke(IPC.APP_GET_QUICK_CAPTURE_HOTKEY),
  setQuickCaptureHotkey: (
    hotkey: string
  ): Promise<{ ok: boolean; hotkey: string; error?: string }> =>
    ipcRenderer.invoke(IPC.APP_SET_QUICK_CAPTURE_HOTKEY, hotkey),
  getQuickCapturePinned: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC.APP_GET_QUICK_CAPTURE_PINNED),
  setQuickCapturePinned: (pinned: boolean): Promise<boolean> =>
    ipcRenderer.invoke(IPC.APP_SET_QUICK_CAPTURE_PINNED, pinned),
  renderTikz: (source: string): Promise<{ ok: boolean; svg?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.TIKZ_RENDER, source),

  mcpGetRuntime: (): Promise<McpServerRuntime> => ipcRenderer.invoke(IPC.MCP_RUNTIME),
  mcpGetStatuses: (): Promise<McpClientStatus[]> => ipcRenderer.invoke(IPC.MCP_STATUS),
  mcpInstall: (id: McpClientId): Promise<McpClientStatus> => ipcRenderer.invoke(IPC.MCP_INSTALL, id),
  mcpUninstall: (id: McpClientId): Promise<McpClientStatus> =>
    ipcRenderer.invoke(IPC.MCP_UNINSTALL, id),
  mcpGetInstructions: (): Promise<McpInstructionsPayload> =>
    ipcRenderer.invoke(IPC.MCP_GET_INSTRUCTIONS),
  mcpSetInstructions: (next: string | null): Promise<McpInstructionsPayload> =>
    ipcRenderer.invoke(IPC.MCP_SET_INSTRUCTIONS, next),
  cliGetStatus: (): Promise<CliInstallStatus> => ipcRenderer.invoke(IPC.CLI_GET_STATUS),
  cliInstall: (): Promise<CliInstallStatus> => ipcRenderer.invoke(IPC.CLI_INSTALL),
  cliUninstall: (): Promise<CliInstallStatus> => ipcRenderer.invoke(IPC.CLI_UNINSTALL),
  raycastGetStatus: (): Promise<RaycastExtensionStatus> =>
    ipcRenderer.invoke(IPC.RAYCAST_GET_STATUS),
  raycastInstall: (): Promise<RaycastExtensionStatus> =>
    ipcRenderer.invoke(IPC.RAYCAST_INSTALL),
  clipboardWriteText: (text: string): void => clipboard.writeText(text),
  clipboardReadText: (): string => clipboard.readText(),

  getConfigSync: (): AppConfigPortable | null => {
    try {
      return ipcRenderer.sendSync(IPC.CONFIG_GET_SYNC) as AppConfigPortable | null
    } catch {
      return null
    }
  },
  setConfig: (next: AppConfigPortable): Promise<void> =>
    ipcRenderer.invoke(IPC.CONFIG_SET, next),
  getConfigPath: (): Promise<string | null> => ipcRenderer.invoke(IPC.CONFIG_GET_PATH),
  revealConfigFile: (): Promise<void> => ipcRenderer.invoke(IPC.CONFIG_REVEAL),
  onConfigChange: (cb: (next: AppConfigPortable) => void): (() => void) => {
    const listener = (_: unknown, next: AppConfigPortable): void => cb(next)
    ipcRenderer.on(IPC.CONFIG_ON_CHANGE, listener)
    return () => ipcRenderer.removeListener(IPC.CONFIG_ON_CHANGE, listener)
  },

  listCustomThemes: (): Promise<CustomTheme[]> => ipcRenderer.invoke(IPC.CUSTOM_THEMES_LIST),
  getCustomThemesDir: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC.CUSTOM_THEMES_GET_DIR),
  revealCustomThemesDir: (slug?: string): Promise<void> =>
    ipcRenderer.invoke(IPC.CUSTOM_THEMES_REVEAL, slug),
  deleteCustomTheme: (slug: string): Promise<void> =>
    ipcRenderer.invoke(IPC.CUSTOM_THEMES_DELETE, slug),
  createCustomTheme: (input: { name?: string }): Promise<string | null> =>
    ipcRenderer.invoke(IPC.CUSTOM_THEMES_CREATE, input),
  onCustomThemesChange: (cb: (next: CustomTheme[]) => void): (() => void) => {
    const listener = (_: unknown, next: CustomTheme[]): void => cb(next)
    ipcRenderer.on(IPC.CUSTOM_THEMES_ON_CHANGE, listener)
    return () => ipcRenderer.removeListener(IPC.CUSTOM_THEMES_ON_CHANGE, listener)
  },

  listCustomCodeLanguages: (): Promise<CustomCodeLanguage[]> =>
    ipcRenderer.invoke(IPC.CUSTOM_CODE_LANGUAGES_LIST),
  installCustomCodeLanguage: (
    input: CustomCodeLanguageInstallInput
  ): Promise<CustomCodeLanguage> =>
    ipcRenderer.invoke(IPC.CUSTOM_CODE_LANGUAGES_INSTALL, input),
  updateCustomCodeLanguage: (
    input: CustomCodeLanguageUpdateInput
  ): Promise<CustomCodeLanguage> => ipcRenderer.invoke(IPC.CUSTOM_CODE_LANGUAGES_UPDATE, input),
  revealCustomCodeLanguagesDir: (id?: string): Promise<void> =>
    ipcRenderer.invoke(IPC.CUSTOM_CODE_LANGUAGES_REVEAL, id),
  deleteCustomCodeLanguage: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.CUSTOM_CODE_LANGUAGES_DELETE, id),
  onCustomCodeLanguagesChange: (
    cb: (next: CustomCodeLanguage[]) => void
  ): (() => void) => {
    const listener = (_: unknown, next: CustomCodeLanguage[]): void => cb(next)
    ipcRenderer.on(IPC.CUSTOM_CODE_LANGUAGES_ON_CHANGE, listener)
    return () => ipcRenderer.removeListener(IPC.CUSTOM_CODE_LANGUAGES_ON_CHANGE, listener)
  },

  listOverrides: (): Promise<Override[]> => ipcRenderer.invoke(IPC.OVERRIDES_LIST),
  revealOverridesDir: (name?: string): Promise<void> =>
    ipcRenderer.invoke(IPC.OVERRIDES_REVEAL, name),
  deleteOverride: (name: string): Promise<void> => ipcRenderer.invoke(IPC.OVERRIDES_DELETE, name),
  onOverridesChange: (cb: (next: Override[]) => void): (() => void) => {
    const listener = (_: unknown, next: Override[]): void => cb(next)
    ipcRenderer.on(IPC.OVERRIDES_ON_CHANGE, listener)
    return () => ipcRenderer.removeListener(IPC.OVERRIDES_ON_CHANGE, listener)
  },

  toggleDevTools: (): Promise<void> => ipcRenderer.invoke(IPC.DEVTOOLS_TOGGLE)
}

export type ZenApi = ZenBridge

contextBridge.exposeInMainWorld('zen', api)
