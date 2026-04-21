import { clipboard, contextBridge, ipcRenderer, webUtils } from 'electron'
import path from 'node:path'
import appPackage from '../../package.json'
import type { ZenAppInfo, ZenBridge, ZenCapabilities } from '@zennotes/bridge-contract/bridge'
import { IPC } from '@shared/ipc'
import type {
  AppUpdateState,
  AssetMeta,
  DirectoryBrowseResult,
  VaultDemoTourResult,
  FolderEntry,
  ImportedAsset,
  NoteContent,
  NoteFolder,
  NoteMeta,
  VaultSettings,
  VaultTextSearchBackendPreference,
  VaultTextSearchCapabilities,
  VaultTextSearchToolPaths,
  VaultTextSearchMatch,
  VaultChangeEvent,
  VaultInfo
} from '@shared/ipc'
import type { VaultTask } from '@shared/tasks'
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
  supportsDesktopNotifications: true
}

const DESKTOP_APP_INFO: ZenAppInfo = {
  name: appPackage.name,
  productName: appPackage.productName,
  version: appPackage.version,
  description: appPackage.description,
  homepage: appPackage.homepage,
  runtime: 'desktop'
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
  getAppUpdateState: (): Promise<AppUpdateState> =>
    ipcRenderer.invoke(IPC.APP_UPDATER_GET_STATE),
  checkForAppUpdates: (): Promise<AppUpdateState> =>
    ipcRenderer.invoke(IPC.APP_UPDATER_CHECK),
  checkForAppUpdatesWithUi: (): Promise<void> =>
    ipcRenderer.invoke(IPC.APP_UPDATER_CHECK_WITH_UI),
  downloadAppUpdate: (): Promise<AppUpdateState> =>
    ipcRenderer.invoke(IPC.APP_UPDATER_DOWNLOAD),
  installAppUpdate: (): Promise<void> => ipcRenderer.invoke(IPC.APP_UPDATER_INSTALL),

  getCurrentVault: (): Promise<VaultInfo | null> => ipcRenderer.invoke(IPC.VAULT_GET_CURRENT),
  pickVault: (): Promise<VaultInfo | null> => ipcRenderer.invoke(IPC.VAULT_PICK),
  selectVaultPath: async (): Promise<VaultInfo> => {
    throw new Error('Manual vault path selection is only available in the web build')
  },
  browseServerDirectories: async (): Promise<DirectoryBrowseResult> => {
    throw new Error('Server filesystem browsing is only available in the web build')
  },
  getVaultSettings: (): Promise<VaultSettings> => ipcRenderer.invoke(IPC.VAULT_GET_SETTINGS),
  setVaultSettings: (next: VaultSettings): Promise<VaultSettings> =>
    ipcRenderer.invoke(IPC.VAULT_SET_SETTINGS, next),

  listNotes: (): Promise<NoteMeta[]> => ipcRenderer.invoke(IPC.VAULT_LIST_NOTES),
  listFolders: (): Promise<FolderEntry[]> =>
    ipcRenderer.invoke(IPC.VAULT_LIST_FOLDERS),
  listAssets: (): Promise<AssetMeta[]> => ipcRenderer.invoke(IPC.VAULT_LIST_ASSETS),
  hasAssetsDir: (): Promise<boolean> => ipcRenderer.invoke(IPC.VAULT_HAS_ASSETS_DIR),
  generateDemoTour: (): Promise<VaultDemoTourResult> =>
    ipcRenderer.invoke(IPC.VAULT_GENERATE_DEMO_TOUR),
  removeDemoTour: (): Promise<VaultDemoTourResult> =>
    ipcRenderer.invoke(IPC.VAULT_REMOVE_DEMO_TOUR),
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
  readNote: (relPath: string): Promise<NoteContent> =>
    ipcRenderer.invoke(IPC.VAULT_READ_NOTE, relPath),
  scanTasks: (): Promise<VaultTask[]> => ipcRenderer.invoke(IPC.VAULT_SCAN_TASKS),
  scanTasksForPath: (relPath: string): Promise<VaultTask[]> =>
    ipcRenderer.invoke(IPC.VAULT_SCAN_TASKS_FOR, relPath),
  writeNote: (relPath: string, body: string): Promise<NoteMeta> =>
    ipcRenderer.invoke(IPC.VAULT_WRITE_NOTE, relPath, body),
  createNote: (
    folder: NoteFolder,
    title?: string,
    subpath?: string
  ): Promise<NoteMeta> =>
    ipcRenderer.invoke(IPC.VAULT_CREATE_NOTE, folder, title, subpath),
  renameNote: (relPath: string, nextTitle: string): Promise<NoteMeta> =>
    ipcRenderer.invoke(IPC.VAULT_RENAME_NOTE, relPath, nextTitle),
  deleteNote: (relPath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.VAULT_DELETE_NOTE, relPath),
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
  revealNote: (relPath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.VAULT_REVEAL_NOTE, relPath),
  moveNote: (
    relPath: string,
    targetFolder: NoteFolder,
    targetSubpath: string
  ): Promise<NoteMeta> =>
    ipcRenderer.invoke(IPC.VAULT_MOVE_NOTE, relPath, targetFolder, targetSubpath),
  importFilesToNote: (notePath: string, sourcePaths: string[]): Promise<ImportedAsset[]> =>
    ipcRenderer.invoke(IPC.VAULT_IMPORT_FILES, notePath, sourcePaths),
  createFolder: (folder: NoteFolder, subpath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.VAULT_CREATE_FOLDER, folder, subpath),
  renameFolder: (
    folder: NoteFolder,
    oldSubpath: string,
    newSubpath: string
  ): Promise<string> =>
    ipcRenderer.invoke(IPC.VAULT_RENAME_FOLDER, folder, oldSubpath, newSubpath),
  deleteFolder: (folder: NoteFolder, subpath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.VAULT_DELETE_FOLDER, folder, subpath),
  duplicateFolder: (folder: NoteFolder, subpath: string): Promise<string> =>
    ipcRenderer.invoke(IPC.VAULT_DUPLICATE_FOLDER, folder, subpath),
  revealFolder: (folder: NoteFolder, subpath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.VAULT_REVEAL_FOLDER, folder, subpath),
  revealAssetsDir: (): Promise<void> => ipcRenderer.invoke(IPC.VAULT_REVEAL_ASSETS_DIR),
  getPathForFile: (file: File): string | null => {
    try {
      return webUtils.getPathForFile(file) || null
    } catch {
      return null
    }
  },
  resolveLocalAssetUrl: (vaultRoot: string, notePath: string, href: string): string | null => {
    const trimmed = href.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return null
    if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) return null

    const stripQueryAndHash = (value: string): string => {
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
    const decodeHrefPath = (value: string): string => {
      const cleaned = stripQueryAndHash(value)
      try {
        return decodeURIComponent(cleaned)
      } catch {
        return cleaned
      }
    }

    const normalizedNotePath = notePath.split(path.sep).join('/')
    const noteDir = path.posix.dirname(normalizedNotePath)
    const decodedHref = decodeHrefPath(trimmed)
    const relativeTarget = decodedHref.startsWith('/')
      ? decodedHref.replace(/^\/+/, '')
      : path.posix.normalize(path.posix.join(noteDir === '.' ? '' : noteDir, decodedHref))
    const resolved = path.resolve(vaultRoot, relativeTarget.split('/').join(path.sep))
    const rootAbs = path.resolve(vaultRoot)
    if (resolved !== rootAbs && !resolved.startsWith(rootAbs + path.sep)) return null
    return `zen-asset://local?path=${encodeURIComponent(resolved)}`
  },
  resolveVaultAssetUrl: (vaultRoot: string, assetPath: string): string | null => {
    const trimmed = assetPath.trim()
    if (!trimmed) return null
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
  onAppUpdateState: (cb: (state: AppUpdateState) => void): (() => void) => {
    const listener = (_: unknown, state: AppUpdateState): void => cb(state)
    ipcRenderer.on(IPC.APP_UPDATER_ON_STATE, listener)
    return () => ipcRenderer.removeListener(IPC.APP_UPDATER_ON_STATE, listener)
  },

  windowMinimize: (): void => ipcRenderer.send(IPC.WINDOW_MINIMIZE),
  windowToggleMaximize: (): void => ipcRenderer.send(IPC.WINDOW_TOGGLE_MAXIMIZE),
  windowClose: (): void => ipcRenderer.send(IPC.WINDOW_CLOSE),
  openNoteWindow: (relPath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.WINDOW_OPEN_NOTE, relPath),
  renderTikz: (source: string): Promise<{ ok: boolean; svg?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.TIKZ_RENDER, source),

  mcpGetRuntime: (): Promise<McpServerRuntime> => ipcRenderer.invoke(IPC.MCP_RUNTIME),
  mcpGetStatuses: (): Promise<McpClientStatus[]> => ipcRenderer.invoke(IPC.MCP_STATUS),
  mcpInstall: (id: McpClientId): Promise<McpClientStatus> =>
    ipcRenderer.invoke(IPC.MCP_INSTALL, id),
  mcpUninstall: (id: McpClientId): Promise<McpClientStatus> =>
    ipcRenderer.invoke(IPC.MCP_UNINSTALL, id),
  mcpGetInstructions: (): Promise<McpInstructionsPayload> =>
    ipcRenderer.invoke(IPC.MCP_GET_INSTRUCTIONS),
  mcpSetInstructions: (next: string | null): Promise<McpInstructionsPayload> =>
    ipcRenderer.invoke(IPC.MCP_SET_INSTRUCTIONS, next),
  // Native Electron clipboard — more reliable than `navigator.clipboard`
  // which can reject for focus / permission reasons in Electron contexts,
  // especially right after a React state change that unmounts a menu.
  clipboardWriteText: (text: string): void => clipboard.writeText(text),
  clipboardReadText: (): string => clipboard.readText()
}

export type ZenApi = ZenBridge

contextBridge.exposeInMainWorld('zen', api)
