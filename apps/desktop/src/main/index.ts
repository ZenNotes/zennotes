import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  protocol,
  screen,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents
} from 'electron'
import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { IPC } from '@shared/ipc'
import type {
  NoteMeta,
  NoteCommentInput,
  NoteFolder,
  DeletedAsset,
  ExternalFileContent,
  MoveExternalFileResult,
  PastedImageInput,
  LocalVaultEntry,
  RemoteWorkspaceInfo,
  RemoteWorkspaceProfile,
  RemoteWorkspaceProfileInput,
  ServerCapabilities,
  VaultSettings,
  VaultChangeEvent,
  VaultInfo,
  VaultTextSearchBackendPreference,
  VaultTextSearchToolPaths
} from '@shared/ipc'
import {
  absolutePath,
  appendToNote,
  archiveNote,
  createFolder,
  createNote,
  createExcalidraw,
  deleteAsset,
  DEFAULT_QUICK_CAPTURE_HOTKEY,
  deleteFolder,
  deleteNote,
  duplicateAsset,
  duplicateFolder,
  duplicateNote,
  emptyTrash,
  ensureVaultLayout,
  forgetLocalVault,
  folderAbsolutePath,
  generateDemoTour,
  getVaultSettings,
  hasAssetsDir,
  importExternalNote,
  importFiles,
  importPastedImage,
  invalidateNoteMetaCache,
  invalidateVaultTextSearchCache,
  listAssets,
  listFolders,
  listNotes,
  loadConfig,
  moveNote,
  moveAsset,
  moveToTrash,
  readNoteComments,
  readNote,
  renameFolder,
  renameNote,
  renameAsset,
  removeDemoTour,
  restoreDeletedAsset,
  restoreFromTrash,
  searchVaultTextCapabilities,
  searchVaultText,
  setVaultSettings,
  rootContentHiddenByInboxMode,
  type PersistedRemoteWorkspaceConfig,
  type PersistedRemoteWorkspaceProfile,
  type PersistedWindowState,
  rememberLocalVault,
  updateConfig,
  unarchiveNote,
  vaultInfo,
  writeNoteComments,
  writeNote
} from './vault'
import {
  listCustomTemplates,
  readCustomTemplate,
  writeCustomTemplate,
  deleteCustomTemplate
} from './templates'
import type { WriteTemplateInput } from '@zennotes/bridge-contract/templates'
import {
  deleteRemoteWorkspaceSecret,
  getRemoteWorkspaceSecret,
  setRemoteWorkspaceSecret
} from './secret-store'
import { scanAllTasks, scanTasksForPath } from './tasks'
import {
  readDatabase,
  writeDatabaseRows,
  writeDatabaseSchema,
  createDatabase,
  renameDatabase,
  createRecordPage,
  listDatabases
} from './databases'
import type { DatabaseSidecar, DbRow } from '@shared/databases'
import { VaultWatcher } from './watcher'
import { WindowVaultRegistry } from './window-vaults'
import { renderTikz } from './tikz'
import { RemoteServerClient } from './remote/server-client'
import {
  getMcpClientStatuses,
  getMcpServerRuntime,
  installMcpForClient,
  uninstallMcpForClient
} from './mcp-integrations'
import {
  getCliInstallStatus,
  installCli,
  uninstallCli
} from './cli-install'
import {
  getRaycastExtensionStatus,
  installRaycastExtension
} from './raycast-integration'
import {
  checkForAppUpdates,
  downloadAppUpdate,
  getAppUpdateState,
  initAppUpdater,
  installAppUpdate,
  scheduleBackgroundAppUpdateCheck
} from './updater'
import type { McpClientId, McpInstructionsPayload } from '@shared/mcp-clients'
import {
  instructionsFilePath,
  readCustomInstructions,
  writeCustomInstructions,
  MCP_SERVER_INSTRUCTIONS
} from '../mcp/instructions-store'
import { recordMainPerf } from './perf'
import {
  parseOpenNoteDeepLink,
  parseQuickCaptureDeepLink,
  ZENNOTES_DEEP_LINK_SCHEME
} from './deep-links'
import {
  isMarkdownFilePath,
  markdownPathsFromArgv,
  resolveMarkdownOpenTarget
} from './file-open'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOCAL_ASSET_SCHEME = 'zen-asset'

protocol.registerSchemesAsPrivileged([
  {
    scheme: LOCAL_ASSET_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true
    }
  }
])

let mainWindow: BrowserWindow | null = null
let mainWindowReadyForAppEvents = false
let creatingMainWindow: Promise<BrowserWindow> | null = null
let currentVault: VaultInfo | null = null
let currentWorkspaceMode: 'local' | 'remote' = 'local'
let remoteWorkspaceConfig: PersistedRemoteWorkspaceConfig | null = null
let currentRemoteWorkspaceProfileId: string | null = null
let remoteWorkspaceClient: RemoteServerClient | null = null
let remoteServerCapabilities: ServerCapabilities | null = null
let stopRemoteVaultWatch: (() => void) | null = null
const ipcWindowContext = new AsyncLocalStorage<BrowserWindow>()
const windowVaults = new WindowVaultRegistry({
  makeWatcher: () => new VaultWatcher(),
  invalidateVault: (root, ev) => {
    invalidateNoteMetaCache(root, ev.scope === 'vault-settings' ? undefined : ev.path)
    invalidateVaultTextSearchCache(root)
  },
  sendVaultChange: (windowId, ev) => {
    const win = BrowserWindow.fromId(windowId)
    if (!win || win.isDestroyed()) return
    win.webContents.send(IPC.VAULT_ON_CHANGE, ev)
  }
})
const DEFAULT_WINDOW_WIDTH = 1280
const DEFAULT_WINDOW_HEIGHT = 820
const MIN_WINDOW_WIDTH = 900
const MIN_WINDOW_HEIGHT = 600
const WINDOW_STATE_PERSIST_DELAY_MS = 150
const DEFAULT_ZOOM_FACTOR = 1
const MIN_ZOOM_FACTOR = 0.5
const MAX_ZOOM_FACTOR = 3
const ZOOM_STEP = 0.1
const MAC_WINDOW_BACKGROUND_COLOR = '#1f1f1f'
const MAIN_WINDOW_TABBING_IDENTIFIER = 'zennotes-vault-window'
const APP_WEBSITE_URL = 'https://zennotes.org'
const APP_DISCORD_URL = 'https://discord.gg/W4fWzapKS6'
const APP_REPOSITORY_URL = 'https://github.com/ZenNotes/zennotes'
const APP_RELEASES_URL = 'https://github.com/ZenNotes/zennotes/releases/latest'
const APP_ISSUES_URL = 'https://github.com/ZenNotes/zennotes/issues'
const userDataPathOverride = process.env['ZENNOTES_USER_DATA_PATH']?.trim()
if (userDataPathOverride && (process.env['ZEN_PERF'] === '1' || !app.isPackaged)) {
  app.setPath('userData', path.resolve(userDataPathOverride))
}
let currentZoomFactor = DEFAULT_ZOOM_FACTOR
const pendingOpenNoteRequests: string[] = []
const pendingFloatingNoteRequests: string[] = []
let flushingFloatingNoteRequests = false

// Markdown files handed to us by the OS (Finder "Open With", a file
// double-click, drag onto the dock, or a Windows/Linux argv launch).
const pendingFileOpens: { absPath: string; reuseMainWindow: boolean }[] = []
// windowId -> absolute path of the standalone external file it edits.
const externalFileWindows = new Map<number, string>()
// Per-window renderer readiness, so note-open requests can target any
// window (not just the main one) without racing the renderer mount.
const readyWindowIds = new Set<number>()
const pendingWindowNoteOpens = new Map<number, string[]>()
let appStartupComplete = false
const gotSingleInstanceLock = app.requestSingleInstanceLock()

function isMac(): boolean {
  return process.platform === 'darwin'
}

function windowIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(__dirname, '../../build/icon.png')
}

function openAllowedExternalUrl(url: string): void {
  if (/^(https?:|mailto:)/i.test(url)) {
    shell.openExternal(url).catch(() => {})
  }
}

function registerAppDeepLinkProtocol(): void {
  if (!isMac()) return

  try {
    const defaultApp = (process as NodeJS.Process & { defaultApp?: boolean }).defaultApp === true
    const didRegister =
      defaultApp && process.argv[1]
        ? app.setAsDefaultProtocolClient(
            ZENNOTES_DEEP_LINK_SCHEME,
            process.execPath,
            [path.resolve(process.argv[1])]
          )
        : app.setAsDefaultProtocolClient(ZENNOTES_DEEP_LINK_SCHEME)

    if (!didRegister) {
      console.warn(`Failed to register ${ZENNOTES_DEEP_LINK_SCHEME} URL handler`)
    }
  } catch (err) {
    console.warn(`Failed to register ${ZENNOTES_DEEP_LINK_SCHEME} URL handler`, err)
  }
}

function dispatchOpenNoteRequest(win: BrowserWindow, relPath: string): void {
  if (win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  win.webContents.send(IPC.APP_OPEN_NOTE_REQUESTED, relPath)
}

function flushPendingOpenNoteRequests(win = mainWindow): void {
  if (!win || win.isDestroyed() || !mainWindowReadyForAppEvents) return

  const requests = pendingOpenNoteRequests.splice(0)
  for (const relPath of requests) dispatchOpenNoteRequest(win, relPath)
}

function queueOpenNoteRequest(relPath: string): void {
  pendingOpenNoteRequests.push(relPath)

  if (mainWindow && !mainWindow.isDestroyed()) {
    flushPendingOpenNoteRequests(mainWindow)
    return
  }

  if (app.isReady()) {
    void ensureMainWindow().then(() => flushPendingOpenNoteRequests())
  }
}

function queueFloatingNoteRequest(relPath: string): void {
  pendingFloatingNoteRequests.push(relPath)
  if (app.isReady()) void flushPendingFloatingNoteRequests()
}

async function flushPendingFloatingNoteRequests(): Promise<void> {
  if (flushingFloatingNoteRequests || pendingFloatingNoteRequests.length === 0) return
  flushingFloatingNoteRequests = true
  try {
    const vault = await loadCurrentVaultFromConfig()
    if (!vault) {
      await ensureMainWindow()
      return
    }

    const requests = pendingFloatingNoteRequests.splice(0)
    for (const relPath of requests) openFloatingNoteWindow(relPath)
  } finally {
    flushingFloatingNoteRequests = false
  }
}

type ExternalOpenUrlResult = 'none' | 'note' | 'quick-capture'

function handleExternalOpenUrl(rawUrl: string): ExternalOpenUrlResult {
  if (parseQuickCaptureDeepLink(rawUrl)) {
    void toggleQuickCaptureWindow()
    return 'quick-capture'
  }
  const request = parseOpenNoteDeepLink(rawUrl)
  if (!request) return 'none'
  if (request.target === 'window') queueFloatingNoteRequest(request.path)
  else queueOpenNoteRequest(request.path)
  return 'note'
}

function handleStartupDeepLinks(argv: string[]): ExternalOpenUrlResult {
  let result: ExternalOpenUrlResult = 'none'
  for (const arg of argv) {
    if (arg.startsWith(`${ZENNOTES_DEEP_LINK_SCHEME}:`)) {
      const next = handleExternalOpenUrl(arg)
      if (next !== 'none') result = next
    }
  }
  return result
}

function focusWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

// Dispatch a note-open to a specific window, deferring until that
// window's renderer reports ready so the request isn't dropped on a
// freshly created window.
function queueNoteOpenForWindow(win: BrowserWindow, relPath: string): void {
  if (win.isDestroyed()) return
  if (readyWindowIds.has(win.id)) {
    dispatchOpenNoteRequest(win, relPath)
    return
  }
  const list = pendingWindowNoteOpens.get(win.id) ?? []
  list.push(relPath)
  pendingWindowNoteOpens.set(win.id, list)
}

function flushWindowNoteOpens(win: BrowserWindow): void {
  const list = pendingWindowNoteOpens.get(win.id)
  if (!list || list.length === 0) return
  pendingWindowNoteOpens.delete(win.id)
  for (const relPath of list) dispatchOpenNoteRequest(win, relPath)
}

// Full workspace windows created via createWindow. Utility windows —
// quick capture, floating notes, PDF export, external-file editors —
// inherit the vault session in windowVaults so they can read the vault,
// but they must never be picked as the target for opening a note: a
// Finder "Open in ZenNotes" that lands in the hidden quick-capture
// panel looks like the app opened a quick note instead of the file.
const workspaceWindowIds = new Set<number>()

function isWorkspaceWindow(win: BrowserWindow): boolean {
  return workspaceWindowIds.has(win.id)
}

function findWindowForVaultRoot(root: string): BrowserWindow | null {
  const target = path.resolve(root)
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || !isWorkspaceWindow(win)) continue
    const vault = windowVaults.vaultForWindow(win.id)
    if (vault && path.resolve(vault.root) === target) return win
  }
  return null
}

function queueMarkdownFileOpen(rawPath: string, reuseMainWindow: boolean): void {
  pendingFileOpens.push({ absPath: path.resolve(rawPath), reuseMainWindow })
  // Only flush eagerly once startup is finished. During startup `app.isReady()`
  // is already true (we're inside whenReady), so an eager flush here would
  // drain the queue before whenReady's own flush runs — that flush would then
  // report "nothing opened" and open a redundant default window alongside the
  // file's window, so `zen open` (and double-clicking a .md) opened two. (#178)
  if (app.isReady() && appStartupComplete) void flushPendingFileOpens()
}

function handleStartupMarkdownArgs(argv: string[], reuseMainWindow: boolean): void {
  for (const candidate of markdownPathsFromArgv(argv)) {
    queueMarkdownFileOpen(candidate, reuseMainWindow)
  }
}

// Returns true when at least one file produced (or focused) a window, so
// the caller can skip opening a redundant default-vault window.
async function flushPendingFileOpens(): Promise<boolean> {
  if (!app.isReady() || pendingFileOpens.length === 0) return false
  const items = pendingFileOpens.splice(0)
  let openedAny = false
  for (const item of items) {
    try {
      if (await openMarkdownFileFromOS(item.absPath, item.reuseMainWindow)) {
        openedAny = true
      }
    } catch (err) {
      console.error('Failed to open markdown file', item.absPath, err)
    }
  }
  return openedAny
}

async function openMarkdownFileFromOS(absPath: string, reuseMainWindow: boolean): Promise<boolean> {
  let stat
  try {
    stat = await fsp.stat(absPath)
  } catch {
    return false
  }
  if (!stat.isFile() || !isMarkdownFilePath(absPath)) return false

  const cfg = await loadConfig()
  const knownRoots: string[] = []
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    const vault = windowVaults.vaultForWindow(win.id)
    if (vault) knownRoots.push(vault.root)
  }
  for (const entry of cfg.localVaults ?? []) knownRoots.push(entry.root)
  if (cfg.vaultRoot) knownRoots.push(cfg.vaultRoot)

  const target = resolveMarkdownOpenTarget(absPath, knownRoots)

  if (target.kind === 'vault') {
    const existing = findWindowForVaultRoot(target.vaultRoot)
    if (existing) {
      focusWindow(existing)
      queueNoteOpenForWindow(existing, target.relPath)
      return true
    }
    const win = await createWindow({
      initialVaultRoot: target.vaultRoot,
      persistInitialVault: true
    })
    if (!reuseMainWindow) focusWindow(win)
    queueNoteOpenForWindow(win, target.relPath)
    return true
  }

  openExternalFileWindow(target.absPath)
  return true
}

// Pick a local vault to move an external file into: any open local
// vault, else the active local vault, else the last-used vault on disk.
async function resolveActiveLocalVault(): Promise<VaultInfo | null> {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    if (windowVaults.modeForWindow(win.id) !== 'local') continue
    const vault = windowVaults.vaultForWindow(win.id)
    if (vault) return vault
  }
  if (currentVault && currentWorkspaceMode === 'local') return currentVault
  const cfg = await loadConfig()
  if (cfg.vaultRoot) {
    try {
      await ensureVaultLayout(cfg.vaultRoot)
      return vaultInfo(path.resolve(cfg.vaultRoot))
    } catch {
      return null
    }
  }
  return null
}

// Open a standalone editor window for a markdown file that lives outside
// any vault. The window edits the file in place; the path is held here
// per-window so the renderer can read/write/move it without ever passing
// an arbitrary path back over IPC.
function openExternalFileWindow(absPath: string): void {
  const resolved = path.resolve(absPath)
  for (const [winId, file] of externalFileWindows) {
    if (path.resolve(file) !== resolved) continue
    const existing = BrowserWindow.fromId(winId)
    if (existing && !existing.isDestroyed()) {
      focusWindow(existing)
      return
    }
    externalFileWindows.delete(winId)
  }

  const mac = isMac()
  const win = new BrowserWindow({
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: mac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 16, y: 16 },
    ...(mac
      ? { backgroundColor: MAC_WINDOW_BACKGROUND_COLOR }
      : { backgroundColor: '#faf7f0', icon: windowIconPath() }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  externalFileWindows.set(win.id, resolved)
  win.on('closed', () => {
    externalFileWindows.delete(win.id)
    readyWindowIds.delete(win.id)
    pendingWindowNoteOpens.delete(win.id)
    windowVaults.clearWindow(win.id)
  })
  win.webContents.on('did-start-loading', () => {
    readyWindowIds.delete(win.id)
  })
  win.on('ready-to-show', () => win.show())

  installNavigationGuards(win)
  installZoomControls(win)
  applyZoomFactor(win, currentZoomFactor)

  const params = `?externalFile=${encodeURIComponent(resolved)}`
  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) {
    void win.loadURL(`${devServerUrl}${params}`)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'), {
      search: params.slice(1)
    })
  }
}

function decodeLocalAssetRequestPath(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== `${LOCAL_ASSET_SCHEME}:`) return null
    if (parsed.hostname && parsed.hostname !== 'local') return null
    const encoded = parsed.searchParams.get('path')
    if (!encoded) return null
    return decodeURIComponent(encoded)
  } catch {
    return null
  }
}

function decodeRemoteAssetRequest(url: string): { baseUrl: string; relPath: string } | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== `${LOCAL_ASSET_SCHEME}:`) return null
    if (parsed.hostname !== 'remote') return null
    const baseUrl = parsed.searchParams.get('baseUrl')?.trim()
    const relPath = parsed.searchParams.get('path')?.trim()
    if (!baseUrl || !relPath) return null
    return { baseUrl, relPath }
  } catch {
    return null
  }
}

function currentIpcWindow(): BrowserWindow | null {
  const win = ipcWindowContext.getStore()
  return win && !win.isDestroyed() ? win : null
}

function requireEventWindow(event: IpcMainEvent | IpcMainInvokeEvent): BrowserWindow {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed()) {
    throw new Error('No window is associated with this IPC call.')
  }
  return win
}

function isPathInsideVault(absPath: string): boolean {
  const win = currentIpcWindow()
  if (win) return windowVaults.isPathInsideWindowVault(win.id, absPath)
  if (windowVaults.isPathInsideOpenLocalVault(absPath)) return true
  if (!currentVault) return false
  const resolved = path.resolve(absPath)
  const root = path.resolve(currentVault.root)
  return resolved === root || resolved.startsWith(root + path.sep)
}

function isPathInsideWindowVault(win: BrowserWindow, absPath: string): boolean {
  if (windowVaults.isPathInsideWindowVault(win.id, absPath)) return true
  const vault = windowVaults.vaultForWindow(win.id)
  if (!vault) return false
  const resolved = path.resolve(absPath)
  const root = path.resolve(vault.root)
  return resolved === root || resolved.startsWith(root + path.sep)
}

function installNavigationGuards(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`${LOCAL_ASSET_SCHEME}://`)) {
      const abs = decodeLocalAssetRequestPath(url)
      if (abs && isPathInsideWindowVault(win, abs)) {
        void shell.openPath(abs)
      }
      return { action: 'deny' }
    }
    openAllowedExternalUrl(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (url === win.webContents.getURL()) return
    event.preventDefault()
    if (url.startsWith(`${LOCAL_ASSET_SCHEME}://`)) {
      const abs = decodeLocalAssetRequestPath(url)
      if (abs && isPathInsideWindowVault(win, abs)) {
        void shell.openPath(abs)
      }
      return
    }
    openAllowedExternalUrl(url)
  })
}

function mimeTypeForPath(absPath: string): string {
  const ext = path.extname(absPath).toLowerCase()
  switch (ext) {
    case '.apng':
      return 'image/apng'
    case '.avif':
      return 'image/avif'
    case '.gif':
      return 'image/gif'
    case '.jpeg':
    case '.jpg':
      return 'image/jpeg'
    case '.png':
      return 'image/png'
    case '.svg':
      return 'image/svg+xml'
    case '.webp':
      return 'image/webp'
    case '.pdf':
      return 'application/pdf'
    case '.aac':
      return 'audio/aac'
    case '.flac':
      return 'audio/flac'
    case '.m4a':
      return 'audio/mp4'
    case '.mp3':
      return 'audio/mpeg'
    case '.ogg':
      return 'audio/ogg'
    case '.wav':
      return 'audio/wav'
    case '.m4v':
    case '.mp4':
      return 'video/mp4'
    case '.mov':
      return 'video/quicktime'
    case '.ogv':
      return 'video/ogg'
    case '.webm':
      return 'video/webm'
    default:
      return 'application/octet-stream'
  }
}

function isTrustedRendererUrl(url: string): boolean {
  if (!url) return false
  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) {
    return url.startsWith(devServerUrl)
  }
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === 'file:' &&
      parsed.pathname.endsWith('/out/renderer/index.html')
    )
  } catch {
    return false
  }
}

function isTrustedIpcSender(sender: WebContents): boolean {
  const ownerWindow = BrowserWindow.fromWebContents(sender)
  if (!ownerWindow || ownerWindow.isDestroyed()) return false
  return isTrustedRendererUrl(sender.getURL())
}

function assertTrustedIpcEvent(event: IpcMainEvent | IpcMainInvokeEvent): void {
  if (!isTrustedIpcSender(event.sender)) {
    throw new Error('Blocked IPC call from an untrusted renderer.')
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function normalizeZoomFactor(value: number): number {
  return Math.round(clamp(value, MIN_ZOOM_FACTOR, MAX_ZOOM_FACTOR) * 100) / 100
}

async function persistZoomFactor(factor: number): Promise<number> {
  const normalized = normalizeZoomFactor(factor)
  currentZoomFactor = normalized
  await updateConfig((cfg) => ({ ...cfg, zoomFactor: normalized }))
  return normalized
}

function applyZoomFactor(win: BrowserWindow, factor: number): number {
  const normalized = normalizeZoomFactor(factor)
  win.webContents.setZoomFactor(normalized)
  currentZoomFactor = normalized
  return normalized
}

async function setWindowZoom(
  win: BrowserWindow | null | undefined,
  factor: number
): Promise<number> {
  const target = win && !win.isDestroyed() ? win : mainWindow
  const normalized = normalizeZoomFactor(factor)
  const windows = BrowserWindow.getAllWindows()
  if (windows.length > 0) {
    for (const openWin of windows) {
      if (!openWin.isDestroyed()) applyZoomFactor(openWin, normalized)
    }
  } else if (target && !target.isDestroyed()) {
    applyZoomFactor(target, normalized)
  }
  return await persistZoomFactor(normalized)
}

async function adjustWindowZoom(
  win: BrowserWindow | null | undefined,
  delta: number
): Promise<number> {
  const target = win && !win.isDestroyed() ? win : mainWindow
  const base = target && !target.isDestroyed() ? target.webContents.getZoomFactor() : currentZoomFactor
  return await setWindowZoom(target, base + delta)
}

function isZoomShortcut(input: Electron.Input, key: string, code: string): boolean {
  return input.key === key || input.code === code
}

function installZoomControls(win: BrowserWindow): void {
  win.webContents.on('before-input-event', (event, input) => {
    const mod = input.control || input.meta
    if (!mod || input.alt) return

    if (
      isZoomShortcut(input, '0', 'Digit0') ||
      isZoomShortcut(input, ')', 'Digit0') ||
      isZoomShortcut(input, '0', 'Numpad0') ||
      isZoomShortcut(input, 'Insert', 'Numpad0')
    ) {
      event.preventDefault()
      void setWindowZoom(win, DEFAULT_ZOOM_FACTOR)
      return
    }

    if (
      isZoomShortcut(input, '=', 'Equal') ||
      isZoomShortcut(input, '+', 'Equal') ||
      isZoomShortcut(input, '+', 'NumpadAdd')
    ) {
      event.preventDefault()
      void adjustWindowZoom(win, ZOOM_STEP)
      return
    }

    if (
      isZoomShortcut(input, '-', 'Minus') ||
      isZoomShortcut(input, '_', 'Minus') ||
      isZoomShortcut(input, '-', 'NumpadSubtract')
    ) {
      event.preventDefault()
      void adjustWindowZoom(win, -ZOOM_STEP)
    }
  })
}

function sanitizeWindowState(state: PersistedWindowState | null): PersistedWindowState | null {
  if (!state) return null

  const width = Math.max(MIN_WINDOW_WIDTH, Math.round(state.width))
  const height = Math.max(MIN_WINDOW_HEIGHT, Math.round(state.height))
  const display = screen.getDisplayMatching({
    x: Math.round(state.x),
    y: Math.round(state.y),
    width,
    height
  })
  const workArea = display.workArea
  const clampedWidth = Math.min(width, workArea.width)
  const clampedHeight = Math.min(height, workArea.height)
  const x = clamp(
    Math.round(state.x),
    workArea.x,
    Math.max(workArea.x, workArea.x + workArea.width - clampedWidth)
  )
  const y = clamp(
    Math.round(state.y),
    workArea.y,
    Math.max(workArea.y, workArea.y + workArea.height - clampedHeight)
  )

  return {
    x,
    y,
    width: clampedWidth,
    height: clampedHeight,
    isMaximized: state.isMaximized
  }
}

async function persistWindowState(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed()) return
  const isMaximized = win.isMaximized()
  const bounds = isMaximized ? win.getNormalBounds() : win.getBounds()
  await updateConfig((cfg) => ({
    ...cfg,
    windowState: {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized
    }
  }))
}

interface CreateWindowOptions {
  initialVaultRoot?: string | null
  inheritWorkspaceFrom?: BrowserWindow | null
  persistInitialVault?: boolean
}

async function createWindow(options: CreateWindowOptions = {}): Promise<BrowserWindow> {
  const createWindowStartedAt = performance.now()
  const mac = isMac()
  const cfg = await loadConfig()
  const restoredState = sanitizeWindowState(cfg.windowState)
  currentZoomFactor = normalizeZoomFactor(cfg.zoomFactor)
  const win = new BrowserWindow({
    width: restoredState?.width ?? DEFAULT_WINDOW_WIDTH,
    height: restoredState?.height ?? DEFAULT_WINDOW_HEIGHT,
    ...(restoredState ? { x: restoredState.x, y: restoredState.y } : {}),
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: mac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 16, y: 16 },
    ...(mac
      ? {
          // The renderer now runs fully opaque, so keeping the
          // BrowserWindow transparent forces macOS into an unnecessary
          // compositing path that makes typing feel mushy on large
          // displays. Use a solid background instead.
          backgroundColor: MAC_WINDOW_BACKGROUND_COLOR,
          tabbingIdentifier: MAIN_WINDOW_TABBING_IDENTIFIER
        }
      : {
          backgroundColor: '#faf7f0',
          icon: windowIconPath()
        }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      // Keep the renderer isolated and node-free, but the current preload
      // still relies on Node/Electron APIs that are not available inside a
      // fully sandboxed preload context.
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  workspaceWindowIds.add(win.id)

  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = win
    mainWindowReadyForAppEvents = false
  }

  let persistWindowStateTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleWindowStatePersist = () => {
    if (persistWindowStateTimer) clearTimeout(persistWindowStateTimer)
    persistWindowStateTimer = setTimeout(() => {
      persistWindowStateTimer = null
      void persistWindowState(win)
    }, WINDOW_STATE_PERSIST_DELAY_MS)
  }
  const flushWindowStatePersist = () => {
    if (persistWindowStateTimer) {
      clearTimeout(persistWindowStateTimer)
      persistWindowStateTimer = null
    }
    void persistWindowState(win)
  }

  win.on('ready-to-show', () => {
    recordMainPerf('main.window.ready-to-show', performance.now() - createWindowStartedAt, {
      restored: !!restoredState
    })
    if (restoredState?.isMaximized) win.maximize()
    win.show()
  })
  win.webContents.on('did-start-loading', () => {
    readyWindowIds.delete(win.id)
    if (mainWindow === win) mainWindowReadyForAppEvents = false
  })
  win.webContents.once('did-finish-load', () => {
    recordMainPerf('main.window.did-finish-load', performance.now() - createWindowStartedAt, {
      restored: !!restoredState
    })
  })

  win.on('move', scheduleWindowStatePersist)
  win.on('resize', scheduleWindowStatePersist)
  win.on('maximize', scheduleWindowStatePersist)
  win.on('unmaximize', scheduleWindowStatePersist)
  win.on('close', flushWindowStatePersist)
  win.on('closed', () => {
    if (persistWindowStateTimer) clearTimeout(persistWindowStateTimer)
    workspaceWindowIds.delete(win.id)
    windowVaults.clearWindow(win.id)
    readyWindowIds.delete(win.id)
    pendingWindowNoteOpens.delete(win.id)
    if (mainWindow === win) {
      // Promote only a real workspace window — never quick capture,
      // floating notes, or other utility windows. With none left,
      // mainWindow stays null and the next open recreates one.
      mainWindow =
        BrowserWindow.getAllWindows().find(
          (candidate) =>
            candidate.id !== win.id && !candidate.isDestroyed() && isWorkspaceWindow(candidate)
        ) ?? null
      mainWindowReadyForAppEvents = mainWindow != null
    }
  })

  installNavigationGuards(win)
  installZoomControls(win)
  applyZoomFactor(win, currentZoomFactor)

  if (options.inheritWorkspaceFrom && !options.inheritWorkspaceFrom.isDestroyed()) {
    inheritWindowWorkspaceSession(options.inheritWorkspaceFrom, win)
  } else if (options.initialVaultRoot) {
    try {
      await setVaultForWindow(win, options.initialVaultRoot, {
        persist: options.persistInitialVault !== false
      })
    } catch (err) {
      if (!win.isDestroyed()) win.destroy()
      throw err
    }
  }

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) {
    void win.loadURL(devServerUrl)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return win
}

async function ensureMainWindow(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) return
  if (!app.isReady()) return
  if (!creatingMainWindow) {
    creatingMainWindow = createWindow().finally(() => {
      creatingMainWindow = null
    })
  }
  await creatingMainWindow
}

async function openVaultInNewWindow(parentWindow?: BrowserWindow | null): Promise<VaultInfo | null> {
  const options: Electron.OpenDialogOptions = {
    title: 'Open Vault in New Window',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Open Vault'
  }
  const result =
    parentWindow && !parentWindow.isDestroyed()
      ? await dialog.showOpenDialog(parentWindow, options)
      : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return null

  const win = await createWindow({
    initialVaultRoot: result.filePaths[0],
    persistInitialVault: true
  })
  if (parentWindow && !parentWindow.isDestroyed()) {
    win.moveTop()
  }
  return windowVaults.vaultForWindow(win.id)
}

async function currentRemoteWorkspaceInfo(): Promise<RemoteWorkspaceInfo | null> {
  const win = currentIpcWindow()
  const windowMode = win ? windowVaults.modeForWindow(win.id) : null
  if (windowMode === 'local') return null
  if (!remoteWorkspaceConfig) {
    const cfg = await loadConfig()
    if (cfg.workspaceMode !== 'remote' || !cfg.remoteWorkspace?.baseUrl) return null
    remoteWorkspaceConfig = cfg.remoteWorkspace
    currentRemoteWorkspaceProfileId = cfg.remoteWorkspaceProfileId
  }
  if (win && windowMode && windowMode !== 'remote') return null
  if (!remoteWorkspaceConfig) return null
  return {
    mode: 'remote',
    baseUrl: remoteWorkspaceConfig.baseUrl,
    authConfigured: Boolean(remoteWorkspaceClient?.authToken),
    capabilities: remoteServerCapabilities,
    profileId: currentRemoteWorkspaceProfileId
  }
}

function normalizeRemoteBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

function deriveRemoteWorkspaceProfileName(
  input: {
    id?: string
    baseUrl: string
    vaultPath?: string | null
  },
  existingProfiles: PersistedRemoteWorkspaceProfile[]
): string {
  const normalizedBaseUrl = normalizeRemoteBaseUrl(input.baseUrl)
  let host = 'ZenNotes Server'
  try {
    const normalizedUrl = /^https?:\/\//i.test(normalizedBaseUrl)
      ? normalizedBaseUrl
      : `http://${normalizedBaseUrl}`
    host = new URL(normalizedUrl).host || host
  } catch {
    if (normalizedBaseUrl) host = normalizedBaseUrl
  }

  const trimmedVaultPath = input.vaultPath?.trim() || null
  let baseName = host
  if (trimmedVaultPath) {
    const normalizedVaultPath = trimmedVaultPath.replace(/\\/g, '/').replace(/\/+$/, '')
    const vaultName = path.posix.basename(normalizedVaultPath)
    if (vaultName && vaultName !== '.' && vaultName !== '/') {
      baseName = `${vaultName} (${host})`
    }
  }

  const otherProfiles = existingProfiles.filter((entry) => entry.id !== input.id)
  if (!otherProfiles.some((entry) => entry.name === baseName)) return baseName

  let suffix = 2
  while (otherProfiles.some((entry) => entry.name === `${baseName} ${suffix}`)) suffix += 1
  return `${baseName} ${suffix}`
}

function profileMatchesConnection(
  profile: PersistedRemoteWorkspaceProfile,
  connection: PersistedRemoteWorkspaceConfig,
  vaultPath: string | null
): boolean {
  return (
    normalizeRemoteBaseUrl(profile.baseUrl) === normalizeRemoteBaseUrl(connection.baseUrl) &&
    (profile.vaultPath ?? null) === (vaultPath ?? null)
  )
}

function findRemoteProfileById(
  profiles: PersistedRemoteWorkspaceProfile[],
  id: string | null
): PersistedRemoteWorkspaceProfile | null {
  if (!id) return null
  return profiles.find((entry) => entry.id === id) ?? null
}

async function migrateLegacyRemoteWorkspaceSecrets(): Promise<void> {
  const cfg = await loadConfig()
  let changed = false
  let nextProfiles = [...cfg.remoteWorkspaceProfiles]
  let nextRemoteWorkspace = cfg.remoteWorkspace
  let nextProfileId = cfg.remoteWorkspaceProfileId

  for (const profile of nextProfiles) {
    if (profile.authToken && profile.authToken.trim()) {
      await setRemoteWorkspaceSecret(profile.id, profile.authToken)
      delete profile.authToken
      changed = true
    }
  }

  if (nextRemoteWorkspace?.authToken && nextRemoteWorkspace.authToken.trim()) {
    let targetProfile =
      findRemoteProfileById(nextProfiles, nextProfileId) ??
      nextProfiles.find(
        (entry) => normalizeRemoteBaseUrl(entry.baseUrl) === normalizeRemoteBaseUrl(nextRemoteWorkspace!.baseUrl)
      ) ??
      null

    if (!targetProfile) {
      targetProfile = {
        id: randomUUID(),
        name: deriveRemoteWorkspaceProfileName(
          {
            baseUrl: nextRemoteWorkspace.baseUrl,
            vaultPath: currentVault?.root ?? null
          },
          nextProfiles
        ),
        baseUrl: normalizeRemoteBaseUrl(nextRemoteWorkspace.baseUrl),
        vaultPath: currentVault?.root ?? null,
        lastConnectedAt: null
      }
      nextProfiles = [...nextProfiles, targetProfile].sort((a, b) => a.name.localeCompare(b.name))
      nextProfileId = targetProfile.id
    }

    await setRemoteWorkspaceSecret(targetProfile.id, nextRemoteWorkspace.authToken)
    nextRemoteWorkspace = { baseUrl: nextRemoteWorkspace.baseUrl }
    changed = true
  }

  if (!changed) return

  await updateConfig((current) => ({
    ...current,
    remoteWorkspace: nextRemoteWorkspace
      ? {
          baseUrl: normalizeRemoteBaseUrl(nextRemoteWorkspace.baseUrl)
        }
      : null,
    remoteWorkspaceProfiles: nextProfiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      baseUrl: normalizeRemoteBaseUrl(profile.baseUrl),
      vaultPath: profile.vaultPath ?? null,
      lastConnectedAt: profile.lastConnectedAt ?? null
    })),
    remoteWorkspaceProfileId: nextProfileId
  }))
}

function stopRemoteWatch(): void {
  if (stopRemoteVaultWatch) {
    stopRemoteVaultWatch()
    stopRemoteVaultWatch = null
  }
}

function startRemoteWatch(client: RemoteServerClient, capabilities: ServerCapabilities): void {
  stopRemoteWatch()
  if (!capabilities.supportsWatch) return
  stopRemoteVaultWatch = client.watchVaultChanges((ev) => {
    windowVaults.sendRemoteVaultChange(ev)
  })
}

async function setVaultForWindow(
  win: BrowserWindow,
  root: string,
  options: { persist?: boolean } = {}
): Promise<VaultInfo> {
  await ensureVaultLayout(root)
  const vault = vaultInfo(path.resolve(root))
  windowVaults.setLocalVault(win.id, vault)
  currentVault = vault
  currentWorkspaceMode = 'local'
  if (!windowVaults.hasRemoteWindows()) {
    remoteWorkspaceClient = null
    remoteWorkspaceConfig = null
    currentRemoteWorkspaceProfileId = null
    remoteServerCapabilities = null
    stopRemoteWatch()
  }
  if (options.persist !== false) {
    await updateConfig((cfg) => ({
      ...cfg,
      workspaceMode: 'local',
      vaultRoot: vault.root,
      localVaults: rememberLocalVault(cfg.localVaults, vault),
      remoteWorkspaceProfileId: null
    }))
  }
  return vault
}

async function setVault(root: string): Promise<VaultInfo> {
  const win = currentIpcWindow() ?? mainWindow
  if (win && !win.isDestroyed()) return await setVaultForWindow(win, root)

  await ensureVaultLayout(root)
  const vault = vaultInfo(path.resolve(root))
  currentVault = vault
  currentWorkspaceMode = 'local'
  remoteWorkspaceClient = null
  remoteWorkspaceConfig = null
  currentRemoteWorkspaceProfileId = null
  remoteServerCapabilities = null
  stopRemoteWatch()
  await updateConfig((cfg) => ({
    ...cfg,
    workspaceMode: 'local',
    vaultRoot: vault.root,
    localVaults: rememberLocalVault(cfg.localVaults, vault),
    remoteWorkspaceProfileId: null
  }))
  return vault
}

async function closeLocalVaultForWindow(): Promise<VaultInfo | null> {
  const win = currentIpcWindow() ?? mainWindow
  if (win && !win.isDestroyed() && windowVaults.isRemoteWindow(win.id)) return null
  if ((!win || win.isDestroyed()) && currentWorkspaceMode === 'remote') return null
  const vault = win && !win.isDestroyed() ? windowVaults.vaultForWindow(win.id) : currentVault
  if (!vault) return null

  const cfg = await loadConfig()
  const candidates = new Map<string, { root: string; name: string }>()
  const remainingLocalVaults = forgetLocalVault(cfg.localVaults, vault.root)
  for (const entry of remainingLocalVaults) {
    candidates.set(path.resolve(entry.root), entry)
  }
  for (const entry of windowVaults.localVaultsExcept(vault.root)) {
    const root = path.resolve(entry.root)
    if (!candidates.has(root)) candidates.set(root, entry)
  }
  const nextLocalVault = candidates.values().next().value ?? null
  const nextVault =
    nextLocalVault && win && !win.isDestroyed()
      ? await setVaultForWindow(win, nextLocalVault.root, { persist: false })
      : nextLocalVault
        ? await setVault(nextLocalVault.root)
        : null

  if (!nextVault) {
    if (win && !win.isDestroyed()) {
      windowVaults.clearWindow(win.id)
    }
    if (currentVault && path.resolve(currentVault.root) === path.resolve(vault.root)) {
      currentVault = null
    }
    currentWorkspaceMode = 'local'
  }

  await updateConfig((cfg) => ({
    ...cfg,
    workspaceMode: 'local',
    vaultRoot: nextVault ? nextVault.root : null,
    localVaults: forgetLocalVault(cfg.localVaults, vault.root),
    remoteWorkspaceProfileId: null
  }))

  return nextVault
}

async function listLocalVaults(): Promise<LocalVaultEntry[]> {
  const cfg = await loadConfig()
  let entries = cfg.localVaults
  if (cfg.vaultRoot && !entries.some((entry) => path.resolve(entry.root) === path.resolve(cfg.vaultRoot!))) {
    try {
      entries = rememberLocalVault(entries, vaultInfo(cfg.vaultRoot), 0)
    } catch {
      entries = [
        {
          root: path.resolve(cfg.vaultRoot),
          name: path.basename(cfg.vaultRoot),
          lastOpenedAt: 0
        },
        ...entries
      ]
    }
  }
  return entries
}

async function setRemoteWorkspace(
  baseUrl: string,
  authToken?: string | null,
  options: { persist?: boolean; profileId?: string | null; vaultPath?: string | null } = {}
): Promise<{ vault: VaultInfo | null; capabilities: ServerCapabilities }> {
  const client = new RemoteServerClient({ baseUrl, authToken })
  const capabilities = await client.getCapabilities()
  let vault = await client.getCurrentVault()
  const preferredVaultPath = options.vaultPath?.trim() || null
  if (
    capabilities.supportsVaultSelection &&
    preferredVaultPath &&
    vault?.root !== preferredVaultPath
  ) {
    vault = await client.selectVaultPath(preferredVaultPath)
  }

  const win = currentIpcWindow() ?? mainWindow
  currentWorkspaceMode = 'remote'
  currentVault = vault
  if (win && !win.isDestroyed()) {
    windowVaults.setRemoteVault(win.id, vault)
  }
  remoteWorkspaceClient = client
  remoteServerCapabilities = capabilities
  currentRemoteWorkspaceProfileId = options.profileId ?? null
  remoteWorkspaceConfig = {
    baseUrl: client.baseUrl
  }
  startRemoteWatch(client, capabilities)

  if (options.persist !== false) {
    await updateConfig((cfg) => ({
      ...cfg,
      workspaceMode: 'remote',
      remoteWorkspace: remoteWorkspaceConfig,
      remoteWorkspaceProfileId: currentRemoteWorkspaceProfileId
    }))
  }

  return { vault, capabilities }
}

async function disconnectRemoteWorkspace(): Promise<VaultInfo | null> {
  const cfg = await loadConfig()
  const win = currentIpcWindow() ?? mainWindow
  currentWorkspaceMode = 'local'

  if (cfg.vaultRoot) {
    if (win && !win.isDestroyed()) {
      return await setVaultForWindow(win, cfg.vaultRoot)
    }
    return await setVault(cfg.vaultRoot)
  }

  if (win && !win.isDestroyed()) {
    windowVaults.clearWindow(win.id)
  }
  if (!windowVaults.hasRemoteWindows()) {
    remoteWorkspaceClient = null
    remoteWorkspaceConfig = null
    currentRemoteWorkspaceProfileId = null
    remoteServerCapabilities = null
  }
  currentVault = null
  await updateConfig((current) => ({
    ...current,
    workspaceMode: 'local',
    remoteWorkspaceProfileId: null
  }))
  return null
}

function inheritWindowWorkspaceSession(source: BrowserWindow, target: BrowserWindow): void {
  const vault = windowVaults.vaultForWindow(source.id)
  const mode = windowVaults.modeForWindow(source.id)
  if (!vault || !mode) return
  if (mode === 'remote') {
    windowVaults.setRemoteVault(target.id, vault)
  } else {
    windowVaults.setLocalVault(target.id, vault)
  }
}

function noteTitleFromRelPath(relPath: string): string {
  const base = path.posix.basename(relPath)
  return base.replace(/\.md$/i, '') || 'Note'
}

function sanitizePdfFilename(name: string): string {
  const sanitized = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return sanitized || 'Note'
}

function ensurePdfExtension(targetPath: string): string {
  return targetPath.toLowerCase().endsWith('.pdf') ? targetPath : `${targetPath}.pdf`
}

async function waitForExportWindowState(
  win: BrowserWindow,
  timeoutMs = 15000
): Promise<void> {
  const startedAt = Date.now()
  while (!win.isDestroyed()) {
    const state = await win.webContents.executeJavaScript(
      'document.body?.dataset.exportState ?? ""',
      true
    )
    if (state === 'ready') return
    if (state === 'error') {
      const message = await win.webContents.executeJavaScript(
        'document.body?.dataset.exportError ?? "The export renderer reported an error."',
        true
      )
      throw new Error(typeof message === 'string' ? message : 'The export renderer reported an error.')
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error('Timed out while preparing the note preview for PDF export.')
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('The export window closed before PDF export completed.')
}

async function exportNotePdf(
  relPath: string,
  parentWindow: BrowserWindow | null | undefined
): Promise<string | null> {
  const current =
    parentWindow && !parentWindow.isDestroyed()
      ? windowVaults.vaultForWindow(parentWindow.id)
      : currentVault ?? (isRemoteWorkspaceActive() ? await requireRemoteWorkspaceClient().getCurrentVault() : null)
  if (!current) {
    throw new Error('No active vault is available for PDF export.')
  }

  const suggestedName = `${sanitizePdfFilename(noteTitleFromRelPath(relPath))}.pdf`
  const saveDialogOptions = {
    title: 'Export Note as PDF',
    defaultPath: path.join(app.getPath('documents'), suggestedName),
    buttonLabel: 'Export PDF',
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  }
  const result = parentWindow
    ? await dialog.showSaveDialog(parentWindow, saveDialogOptions)
    : await dialog.showSaveDialog(saveDialogOptions)
  if (result.canceled || !result.filePath) return null

  const targetPath = ensurePdfExtension(result.filePath)
  const mac = isMac()
  const exportWindow = new BrowserWindow({
    width: 1024,
    height: 1400,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: mac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 12, y: 12 },
    ...(mac
      ? {
          backgroundColor: '#ffffff'
        }
      : {
          backgroundColor: '#ffffff',
          icon: windowIconPath()
        }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  try {
    if (parentWindow && !parentWindow.isDestroyed()) {
      inheritWindowWorkspaceSession(parentWindow, exportWindow)
    }
    installNavigationGuards(exportWindow)
    applyZoomFactor(exportWindow, currentZoomFactor)
    const params = `?exportNote=${encodeURIComponent(relPath)}`
    const devServerUrl = process.env['ELECTRON_RENDERER_URL']
    if (devServerUrl) {
      await exportWindow.loadURL(`${devServerUrl}${params}`)
    } else {
      await exportWindow.loadFile(path.join(__dirname, '../renderer/index.html'), {
        search: params.slice(1)
      })
    }

    await waitForExportWindowState(exportWindow)
    await exportWindow.webContents.executeJavaScript(
      'document.fonts ? document.fonts.ready.then(() => true) : Promise.resolve(true)',
      true
    )
    const pdf = await exportWindow.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true
    })
    await fsp.mkdir(path.dirname(targetPath), { recursive: true })
    await fsp.writeFile(targetPath, pdf)
    return targetPath
  } finally {
    windowVaults.clearWindow(exportWindow.id)
    if (!exportWindow.isDestroyed()) {
      exportWindow.destroy()
    }
  }
}

async function listRemoteWorkspaceProfiles(): Promise<RemoteWorkspaceProfile[]> {
  const cfg = await loadConfig()
  return await Promise.all(
    cfg.remoteWorkspaceProfiles.map(async (profile) => ({
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl,
      vaultPath: profile.vaultPath ?? null,
      lastConnectedAt: profile.lastConnectedAt ?? null,
      hasCredential: Boolean(await getRemoteWorkspaceSecret(profile.id))
    }))
  )
}

async function saveRemoteWorkspaceProfile(
  input: RemoteWorkspaceProfileInput & { lastConnectedAt?: number | null }
): Promise<RemoteWorkspaceProfile> {
  const normalizedId = input.id?.trim() || randomUUID()
  await updateConfig((cfg) => {
    const normalizedBaseUrl = normalizeRemoteBaseUrl(input.baseUrl)
    const trimmedName = input.name?.trim() || ''
    const normalizedVaultPath = input.vaultPath?.trim() || null
    if (!normalizedId || !normalizedBaseUrl) {
      throw new Error('Remote workspace profiles need a server URL.')
    }
    const nextNormalized: PersistedRemoteWorkspaceProfile = {
      id: normalizedId,
      name:
        trimmedName ||
        deriveRemoteWorkspaceProfileName(
          {
            id: normalizedId,
            baseUrl: normalizedBaseUrl,
            vaultPath: normalizedVaultPath
          },
          cfg.remoteWorkspaceProfiles
        ),
      baseUrl: normalizedBaseUrl,
      vaultPath: normalizedVaultPath,
      lastConnectedAt:
        typeof input.lastConnectedAt === 'number' && Number.isFinite(input.lastConnectedAt)
          ? input.lastConnectedAt
          : null
    }
    const others = cfg.remoteWorkspaceProfiles.filter((entry) => entry.id !== nextNormalized.id)
    const nextProfiles = [...others, nextNormalized].sort((a, b) => a.name.localeCompare(b.name))
    let nextCurrentProfileId = cfg.remoteWorkspaceProfileId
    if (remoteWorkspaceConfig) {
      if (
        profileMatchesConnection(nextNormalized, remoteWorkspaceConfig, currentVault?.root ?? null)
      ) {
        nextCurrentProfileId = nextNormalized.id
      } else if (cfg.remoteWorkspaceProfileId === nextNormalized.id) {
        nextCurrentProfileId = null
      }
    }
    currentRemoteWorkspaceProfileId = nextCurrentProfileId
    return {
      ...cfg,
      remoteWorkspaceProfiles: nextProfiles,
      remoteWorkspaceProfileId: nextCurrentProfileId
    }
  })
  if (input.clearAuthToken) {
    await deleteRemoteWorkspaceSecret(normalizedId)
  } else if (typeof input.authToken === 'string' && input.authToken.trim()) {
    await setRemoteWorkspaceSecret(normalizedId, input.authToken.trim())
  }
  const cfg = await loadConfig()
  const normalized = findRemoteProfileById(cfg.remoteWorkspaceProfiles, normalizedId)
  if (!normalized) {
    throw new Error('Remote workspace profile could not be saved.')
  }
  return {
    id: normalized.id,
    name: normalized.name,
    baseUrl: normalized.baseUrl,
    vaultPath: normalized.vaultPath ?? null,
    lastConnectedAt: normalized.lastConnectedAt ?? null,
    hasCredential: input.clearAuthToken
      ? false
      : typeof input.authToken === 'string' && input.authToken.trim()
        ? true
        : Boolean(await getRemoteWorkspaceSecret(normalized.id))
  }
}

async function deleteRemoteWorkspaceProfile(id: string): Promise<void> {
  const deletedSecret = await getRemoteWorkspaceSecret(id)
  await updateConfig((cfg) => {
    const deletedProfile = findRemoteProfileById(cfg.remoteWorkspaceProfiles, id)
    const nextProfiles = cfg.remoteWorkspaceProfiles.filter((entry) => entry.id !== id)
    const nextCurrentProfileId =
      cfg.remoteWorkspaceProfileId === id ? null : cfg.remoteWorkspaceProfileId
    const shouldClearLegacyRemoteWorkspace =
      !!deletedProfile &&
      !!cfg.remoteWorkspace &&
      normalizeRemoteBaseUrl(cfg.remoteWorkspace.baseUrl) ===
        normalizeRemoteBaseUrl(deletedProfile.baseUrl) &&
      !nextProfiles.some(
        (entry) =>
          normalizeRemoteBaseUrl(entry.baseUrl) === normalizeRemoteBaseUrl(deletedProfile.baseUrl)
      )
    currentRemoteWorkspaceProfileId = nextCurrentProfileId
    return {
      ...cfg,
      remoteWorkspace: shouldClearLegacyRemoteWorkspace ? null : cfg.remoteWorkspace,
      remoteWorkspaceProfiles: nextProfiles,
      remoteWorkspaceProfileId: nextCurrentProfileId
    }
  })
  await deleteRemoteWorkspaceSecret(id)
  if (deletedSecret && currentRemoteWorkspaceProfileId === id) {
    remoteWorkspaceClient = null
  }
}

async function connectRemoteWorkspaceProfile(
  profileId: string
): Promise<{ vault: VaultInfo | null; capabilities: ServerCapabilities }> {
  const cfg = await loadConfig()
  const profile = findRemoteProfileById(cfg.remoteWorkspaceProfiles, profileId)
  if (!profile) {
    throw new Error('That saved remote workspace no longer exists.')
  }
  const authToken = await getRemoteWorkspaceSecret(profile.id)
  const result = await setRemoteWorkspace(profile.baseUrl, authToken, {
    profileId: profile.id,
    vaultPath: profile.vaultPath
  })
  const connectedAt = Date.now()
  await updateConfig((current) => ({
    ...current,
    remoteWorkspaceProfileId: profile.id,
    remoteWorkspaceProfiles: current.remoteWorkspaceProfiles.map((entry) =>
      entry.id === profile.id ? { ...entry, lastConnectedAt: connectedAt } : entry
    )
  }))
  currentRemoteWorkspaceProfileId = profile.id
  return result
}

async function loadCurrentVaultFromConfig(): Promise<VaultInfo | null> {
  const win = currentIpcWindow() ?? mainWindow
  if (win && !win.isDestroyed()) {
    const existing = windowVaults.vaultForWindow(win.id)
    if (existing) return existing
  } else if (currentVault) {
    return currentVault
  }
  const cfg = await loadConfig()
  remoteWorkspaceConfig = cfg.remoteWorkspace
  currentRemoteWorkspaceProfileId = cfg.remoteWorkspaceProfileId
  if (cfg.workspaceMode === 'remote' && cfg.remoteWorkspace?.baseUrl) {
    const remoteProfile = findRemoteProfileById(cfg.remoteWorkspaceProfiles, cfg.remoteWorkspaceProfileId)
    const authToken =
      (remoteProfile && (await getRemoteWorkspaceSecret(remoteProfile.id))) ??
      cfg.remoteWorkspace.authToken ??
      null
    try {
      const loadRemote = async () =>
        await setRemoteWorkspace(cfg.remoteWorkspace!.baseUrl, authToken, {
          persist: false,
          profileId: remoteProfile?.id ?? cfg.remoteWorkspaceProfileId,
          vaultPath: remoteProfile?.vaultPath ?? null
        })
      const result =
        win && !win.isDestroyed()
          ? await ipcWindowContext.run(win, loadRemote)
          : await loadRemote()
      return result.vault
    } catch {
      currentRemoteWorkspaceProfileId = null
      return null
    }
  }
  if (cfg.vaultRoot) {
    try {
      if (win && !win.isDestroyed()) {
        return await setVaultForWindow(win, cfg.vaultRoot, { persist: false })
      }
      return await setVault(cfg.vaultRoot)
    } catch {
      return null
    }
  }
  return null
}

function requireVault(): VaultInfo {
  const win = currentIpcWindow()
  const vault = win ? windowVaults.vaultForWindow(win.id) : currentVault
  if (!vault) throw new Error('No vault is open')
  return vault
}

function isRemoteWorkspaceActive(): boolean {
  const win = currentIpcWindow()
  if (win && !windowVaults.isRemoteWindow(win.id)) return false
  return remoteWorkspaceClient != null && (win ? true : currentWorkspaceMode === 'remote')
}

function requireRemoteWorkspaceClient(): RemoteServerClient {
  if (!isRemoteWorkspaceActive() || !remoteWorkspaceClient) {
    throw new Error('No remote workspace is connected')
  }
  return remoteWorkspaceClient
}

/**
 * Enumerate installed font families for the font picker.
 *
 * On macOS we call `system_profiler SPFontsDataType -json` and pull the
 * `typefaces[].family` field out of each entry — that's the actual
 * family name users see in Font Book (`JetBrains Mono`, `SF Mono`),
 * not the raw filename. Falls back to the `font-list` package on other
 * platforms.
 */
function listFontFamiliesMac(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      '/usr/sbin/system_profiler',
      ['SPFontsDataType', '-json'],
      { maxBuffer: 200 * 1024 * 1024 },
      async (err, stdout) => {
        if (err) {
          console.error('system_profiler failed', err)
          resolve([])
          return
        }
        try {
          const data = JSON.parse(stdout) as {
            SPFontsDataType: Array<{
              _name?: string
              typefaces?: Array<{ family?: string; _name?: string }>
            }>
          }
          const entries = data.SPFontsDataType || []
          const families = new Set<string>()
          for (const entry of entries) {
            const faces = entry.typefaces || []
            for (const f of faces) {
              const name = f.family?.trim()
              if (!name) continue
              // Skip macOS private system fonts (leading dot, e.g.
              // `.SF NS`, `.SF Arabic`) — they're meant for the OS,
              // not user-selectable text.
              if (name.startsWith('.')) continue
              families.add(name)
            }
          }
          // Also include every file name that might not appear as a
          // registered typeface — rare but gives us an extra safety net
          // for fonts that were activated after boot and aren't yet in
          // the system_profiler cache.
          try {
            const homeFonts = path.join(app.getPath('home'), 'Library', 'Fonts')
            const files = await fsp.readdir(homeFonts)
            for (const f of files) {
              if (/\.(ttf|otf|ttc|otc)$/i.test(f)) {
                // Not a family name but a filename — only add if we
                // can't find any family that shares its stem.
                const stem = f.replace(/\.(ttf|otf|ttc|otc)$/i, '')
                const guess = stem.replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim()
                if (guess && ![...families].some((fam) => guess.toLowerCase().startsWith(fam.toLowerCase()))) {
                  // leave unmatched file stems out of the picker — they
                  // rarely map cleanly to a family the user would pick.
                }
              }
            }
          } catch {
            /* ignore */
          }
          resolve(
            [...families].sort((a, b) =>
              a.localeCompare(b, undefined, { sensitivity: 'base' })
            )
          )
        } catch (e) {
          console.error('failed to parse system_profiler JSON', e)
          resolve([])
        }
      }
    )
  })
}

async function listFontFamilies(): Promise<string[]> {
  if (process.platform === 'darwin') {
    const list = await listFontFamiliesMac()
    if (list.length > 0) return list
  }
  // Cross-platform fallback via the `font-list` package.
  try {
    const mod = (await import('font-list')) as unknown as {
      getFonts?: () => Promise<string[]>
      default?: { getFonts?: () => Promise<string[]> }
    }
    const getFonts = mod.getFonts ?? mod.default?.getFonts
    if (!getFonts) return []
    const raw = await getFonts()
    const unique = new Set<string>()
    for (const f of raw) {
      const name = f.replace(/^"|"$/g, '').trim()
      if (name) unique.add(name)
    }
    return [...unique].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' })
    )
  } catch (err) {
    console.error('font-list fallback failed', err)
    return []
  }
}

interface ListNotesStreamRequest {
  requestId?: unknown
  chunkSize?: unknown
  offset?: unknown
}

interface ListNotesStreamState {
  notes: NoteMeta[]
  touchedAt: number
}

const DEFAULT_LIST_NOTES_STREAM_CHUNK_SIZE = 500
const MAX_LIST_NOTES_STREAM_CHUNK_SIZE = 1000
const LIST_NOTES_STREAM_STATE_TTL_MS = 60_000
const listNotesStreamStates = new Map<string, ListNotesStreamState>()

function listNotesStreamChunkSize(raw: unknown): number {
  const parsed = Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIST_NOTES_STREAM_CHUNK_SIZE
  return Math.min(MAX_LIST_NOTES_STREAM_CHUNK_SIZE, parsed)
}

function listNotesStreamOffset(raw: unknown): number {
  const parsed = Number.parseInt(String(raw ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function pruneListNotesStreamStates(): void {
  const cutoff = Date.now() - LIST_NOTES_STREAM_STATE_TTL_MS
  for (const [requestId, state] of listNotesStreamStates) {
    if (state.touchedAt < cutoff) listNotesStreamStates.delete(requestId)
  }
}

function registerIpc(): void {
  const handle = <Args extends unknown[], Result>(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>
  ): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      assertTrustedIpcEvent(event)
      const win = requireEventWindow(event)
      return await ipcWindowContext.run(win, async () => await listener(event, ...(args as Args)))
    })
  }

  const on = <Args extends unknown[]>(
    channel: string,
    listener: (event: IpcMainEvent, ...args: Args) => void
  ): void => {
    ipcMain.on(channel, (event, ...args) => {
      assertTrustedIpcEvent(event)
      const win = requireEventWindow(event)
      ipcWindowContext.run(win, () => listener(event, ...(args as Args)))
    })
  }

  handle(IPC.APP_PLATFORM, () => process.platform)

  handle(IPC.APP_LIST_FONTS, async () => {
    return await listFontFamilies()
  })
  handle(IPC.APP_ICON_DATA_URL, async () => {
    try {
      const iconPath = path.join(__dirname, '../../build/icon.png')
      const png = await fsp.readFile(iconPath)
      return `data:image/png;base64,${png.toString('base64')}`
    } catch {
      return null
    }
  })
  on(IPC.APP_RENDERER_READY, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    readyWindowIds.add(win.id)
    flushWindowNoteOpens(win)
    if (win !== mainWindow) return
    mainWindowReadyForAppEvents = true
    flushPendingOpenNoteRequests(win)
    void flushPendingFloatingNoteRequests()
  })
  handle(IPC.APP_ZOOM_IN, async (e) => {
    return await adjustWindowZoom(BrowserWindow.fromWebContents(e.sender), ZOOM_STEP)
  })
  handle(IPC.APP_ZOOM_OUT, async (e) => {
    return await adjustWindowZoom(BrowserWindow.fromWebContents(e.sender), -ZOOM_STEP)
  })
  handle(IPC.APP_ZOOM_RESET, async (e) => {
    return await setWindowZoom(BrowserWindow.fromWebContents(e.sender), DEFAULT_ZOOM_FACTOR)
  })
  handle(IPC.APP_UPDATER_GET_STATE, () => getAppUpdateState())
  handle(IPC.APP_UPDATER_CHECK, async () => await checkForAppUpdates())
  handle(IPC.APP_UPDATER_CHECK_WITH_UI, async () => {
    await runMenuUpdateCheck()
  })
  handle(IPC.APP_UPDATER_DOWNLOAD, async () => await downloadAppUpdate())
  handle(IPC.APP_UPDATER_INSTALL, () => {
    installAppUpdate()
  })

  handle(IPC.WORKSPACE_GET_INFO, async () => currentRemoteWorkspaceInfo())
  handle(IPC.WORKSPACE_CONNECT_REMOTE, async (_e, baseUrl: string, authToken?: string | null) => {
    return await setRemoteWorkspace(baseUrl, authToken)
  })
  handle(IPC.WORKSPACE_DISCONNECT_REMOTE, async () => {
    return await disconnectRemoteWorkspace()
  })
  handle(IPC.WORKSPACE_LIST_REMOTE_PROFILES, async () => {
    return await listRemoteWorkspaceProfiles()
  })
  handle(IPC.WORKSPACE_SAVE_REMOTE_PROFILE, async (_e, input: RemoteWorkspaceProfileInput) => {
    return await saveRemoteWorkspaceProfile(input)
  })
  handle(IPC.WORKSPACE_DELETE_REMOTE_PROFILE, async (_e, id: string) => {
    await deleteRemoteWorkspaceProfile(id)
  })
  handle(IPC.WORKSPACE_CONNECT_REMOTE_PROFILE, async (_e, id: string) => {
    return await connectRemoteWorkspaceProfile(id)
  })

  handle(IPC.VAULT_GET_CURRENT, async () => {
    return await loadCurrentVaultFromConfig()
  })

  handle(IPC.VAULT_LIST_LOCAL, async () => {
    return await listLocalVaults()
  })

  handle(IPC.VAULT_OPEN_LOCAL, async (_event, root: string) => {
    const trimmed = typeof root === 'string' ? root.trim() : ''
    if (!trimmed) return null
    return await setVault(trimmed)
  })

  handle(IPC.VAULT_CLOSE, async () => {
    return await closeLocalVaultForWindow()
  })

  handle(IPC.VAULT_PICK, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Choose a vault folder',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Open Vault'
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return await setVault(result.filePaths[0])
  })

  handle(IPC.VAULT_SELECT_PATH, async (_e, targetPath: string) => {
    const client = requireRemoteWorkspaceClient()
    const vault = await client.selectVaultPath(targetPath)
    currentVault = vault
    if (remoteServerCapabilities) {
      startRemoteWatch(client, remoteServerCapabilities)
    }
    return vault
  })

  handle(IPC.VAULT_BROWSE_SERVER_DIRECTORIES, async (_e, targetPath: string = '') => {
    const client = requireRemoteWorkspaceClient()
    return await client.browseDirectories(targetPath)
  })

  handle(IPC.VAULT_GET_SETTINGS, async () => {
    if (isRemoteWorkspaceActive()) {
      return await requireRemoteWorkspaceClient().getVaultSettings()
    }
    const v = requireVault()
    return await getVaultSettings(v.root)
  })

  handle(IPC.VAULT_SET_SETTINGS, async (_e, next: VaultSettings) => {
    if (isRemoteWorkspaceActive()) {
      return await requireRemoteWorkspaceClient().setVaultSettings(next)
    }
    const v = requireVault()
    return await setVaultSettings(v.root, next)
  })

  handle(IPC.VAULT_ROOT_CONTENT_HIDDEN, async () => {
    // Local-vault only: a remote workspace manages its own layout server-side.
    if (isRemoteWorkspaceActive()) return false
    const v = requireVault()
    return await rootContentHiddenByInboxMode(v.root)
  })

  handle(IPC.VAULT_LIST_NOTES, async () => {
    if (isRemoteWorkspaceActive()) return await requireRemoteWorkspaceClient().listNotes()
    const v = requireVault()
    return await listNotes(v.root)
  })

  handle(IPC.VAULT_LIST_NOTES_STREAM, async (_event, request: ListNotesStreamRequest) => {
    if (typeof request?.requestId !== 'string' || request.requestId.length === 0) {
      throw new Error('Missing list-notes stream request id')
    }
    const requestId = request.requestId
    const chunkSize = listNotesStreamChunkSize(request.chunkSize)
    const offset = listNotesStreamOffset(request.offset)
    pruneListNotesStreamStates()

    let state = listNotesStreamStates.get(requestId)
    if (!state || offset === 0) {
      const notes = isRemoteWorkspaceActive()
        ? await requireRemoteWorkspaceClient().listNotes()
        : await listNotes(requireVault().root)
      state = { notes, touchedAt: Date.now() }
      listNotesStreamStates.set(requestId, state)
    } else {
      state.touchedAt = Date.now()
    }

    const nextOffset = Math.min(state.notes.length, offset + chunkSize)
    const done = nextOffset >= state.notes.length
    const notes = state.notes.slice(offset, nextOffset)
    if (done) listNotesStreamStates.delete(requestId)
    return {
      notes,
      nextOffset,
      done,
      total: state.notes.length
    }
  })

  handle(IPC.VAULT_LIST_FOLDERS, async () => {
    if (isRemoteWorkspaceActive()) return await requireRemoteWorkspaceClient().listFolders()
    const v = requireVault()
    return await listFolders(v.root)
  })

  handle(IPC.VAULT_LIST_ASSETS, async () => {
    if (isRemoteWorkspaceActive()) return await requireRemoteWorkspaceClient().listAssets()
    const v = requireVault()
    return await listAssets(v.root)
  })

  handle(IPC.VAULT_HAS_ASSETS_DIR, async () => {
    if (isRemoteWorkspaceActive()) return await requireRemoteWorkspaceClient().hasAssetsDir()
    const v = requireVault()
    return await hasAssetsDir(v.root)
  })

  handle(IPC.VAULT_GENERATE_DEMO_TOUR, async () => {
    if (isRemoteWorkspaceActive()) {
      return await requireRemoteWorkspaceClient().generateDemoTour()
    }
    const v = requireVault()
    return await generateDemoTour(v.root)
  })

  handle(IPC.VAULT_REMOVE_DEMO_TOUR, async () => {
    if (isRemoteWorkspaceActive()) {
      return await requireRemoteWorkspaceClient().removeDemoTour()
    }
    const v = requireVault()
    return await removeDemoTour(v.root)
  })

  // Custom templates live on the local filesystem only; remote vaults fall
  // back to built-in templates (renderer constants), so list returns empty and
  // mutations are rejected.
  handle(IPC.VAULT_LIST_TEMPLATES, async () => {
    if (isRemoteWorkspaceActive()) return []
    const v = requireVault()
    return await listCustomTemplates(v.root)
  })

  handle(IPC.VAULT_READ_TEMPLATE, async (_e, sourcePath: string) => {
    if (isRemoteWorkspaceActive()) {
      throw new Error('Custom templates are unavailable on remote vaults')
    }
    const v = requireVault()
    return await readCustomTemplate(v.root, sourcePath)
  })

  handle(IPC.VAULT_WRITE_TEMPLATE, async (_e, input: WriteTemplateInput) => {
    if (isRemoteWorkspaceActive()) {
      throw new Error('Custom templates are unavailable on remote vaults')
    }
    const v = requireVault()
    return await writeCustomTemplate(v.root, input)
  })

  handle(IPC.VAULT_DELETE_TEMPLATE, async (_e, sourcePath: string) => {
    if (isRemoteWorkspaceActive()) {
      throw new Error('Custom templates are unavailable on remote vaults')
    }
    const v = requireVault()
    return await deleteCustomTemplate(v.root, sourcePath)
  })

  handle(IPC.VAULT_TEXT_SEARCH_CAPABILITIES, async (_e, paths: VaultTextSearchToolPaths = {}) => {
    if (isRemoteWorkspaceActive()) {
      return await requireRemoteWorkspaceClient().getVaultTextSearchCapabilities()
    }
    return await searchVaultTextCapabilities(paths)
  })

  handle(
    IPC.VAULT_SEARCH_TEXT,
    async (
      _e,
      query: string,
      backend: VaultTextSearchBackendPreference = 'auto',
      paths: VaultTextSearchToolPaths = {}
    ) => {
      if (isRemoteWorkspaceActive()) {
        return await requireRemoteWorkspaceClient().searchVaultText(query, backend, paths)
      }
      const v = requireVault()
      return await searchVaultText(v.root, query, backend, paths)
    }
  )

  handle(IPC.VAULT_READ_NOTE, async (_e, relPath: string) => {
    if (isRemoteWorkspaceActive()) return await requireRemoteWorkspaceClient().readNote(relPath)
    const v = requireVault()
    return await readNote(v.root, relPath)
  })

  handle(IPC.VAULT_READ_COMMENTS, async (_e, relPath: string) => {
    if (isRemoteWorkspaceActive()) {
      return await requireRemoteWorkspaceClient().readNoteComments(relPath)
    }
    const v = requireVault()
    return await readNoteComments(v.root, relPath)
  })

  handle(IPC.VAULT_WRITE_COMMENTS, async (_e, relPath: string, comments: NoteCommentInput[]) => {
    if (isRemoteWorkspaceActive()) {
      return await requireRemoteWorkspaceClient().writeNoteComments(relPath, comments)
    }
    const v = requireVault()
    return await writeNoteComments(v.root, relPath, comments)
  })

  handle(IPC.VAULT_SCAN_TASKS, async () => {
    if (isRemoteWorkspaceActive()) return await requireRemoteWorkspaceClient().scanTasks()
    const v = requireVault()
    return await scanAllTasks(v.root)
  })

  handle(IPC.VAULT_SCAN_TASKS_FOR, async (_e, relPath: string) => {
    if (isRemoteWorkspaceActive()) {
      return await requireRemoteWorkspaceClient().scanTasksForPath(relPath)
    }
    const v = requireVault()
    return await scanTasksForPath(v.root, relPath)
  })

  // Databases are local-vault only for now (no remote-server endpoints yet).
  const ensureLocalForDatabases = (): void => {
    if (isRemoteWorkspaceActive()) {
      throw new Error('Databases are not yet supported on remote vaults')
    }
  }

  handle(IPC.VAULT_OPEN_DATABASE, async (_e, relPath: string) => {
    ensureLocalForDatabases()
    try {
      return await readDatabase(requireVault().root, relPath)
    } catch (err) {
      // A missing database isn't exceptional — its tab can simply outlive the
      // file (deleted by us or another client). Return null so the renderer
      // forgets it, instead of rejecting and logging a noisy
      // "Error occurred in handler for 'vault:open-database'". Real errors
      // (parse/permission) still throw.
      if (err instanceof Error && err.message.startsWith('Database not found')) return null
      throw err
    }
  })

  handle(IPC.VAULT_WRITE_DATABASE_ROWS, async (_e, relPath: string, rows: DbRow[]) => {
    ensureLocalForDatabases()
    return await writeDatabaseRows(requireVault().root, relPath, rows)
  })

  handle(
    IPC.VAULT_WRITE_DATABASE_SCHEMA,
    async (_e, relPath: string, sidecar: DatabaseSidecar, rows: DbRow[]) => {
      ensureLocalForDatabases()
      return await writeDatabaseSchema(requireVault().root, relPath, sidecar, rows)
    }
  )

  handle(
    IPC.VAULT_CREATE_DATABASE,
    async (_e, folder: NoteFolder, subpath: string, title?: string) => {
      ensureLocalForDatabases()
      return await createDatabase(requireVault().root, folder, subpath, title)
    }
  )

  handle(IPC.VAULT_RENAME_DATABASE, async (_e, csvPath: string, newTitle: string) => {
    ensureLocalForDatabases()
    return await renameDatabase(requireVault().root, csvPath, newTitle)
  })

  handle(
    IPC.VAULT_CREATE_RECORD_PAGE,
    async (_e, csvPath: string, title: string, body: string) => {
      ensureLocalForDatabases()
      return await createRecordPage(requireVault().root, csvPath, title, body)
    }
  )

  handle(IPC.VAULT_LIST_DATABASES, async () => {
    ensureLocalForDatabases()
    return await listDatabases(requireVault().root)
  })

  handle(IPC.VAULT_WRITE_NOTE, async (_e, relPath: string, body: string) => {
    if (isRemoteWorkspaceActive()) {
      return await requireRemoteWorkspaceClient().writeNote(relPath, body)
    }
    const v = requireVault()
    return await writeNote(v.root, relPath, body)
  })

  handle(
    IPC.VAULT_APPEND_NOTE,
    async (_e, relPath: string, body: string, position: 'start' | 'end') => {
      const safePosition = position === 'start' ? 'start' : 'end'
      if (isRemoteWorkspaceActive()) {
        // Remote vaults don't expose appendToNote yet — compose with read+write
        // so the call works uniformly across local + remote workspaces.
        const client = requireRemoteWorkspaceClient()
        const current = await client.readNote(relPath)
        const trimmed = body.replace(/\s+$/u, '')
        if (!trimmed) return current
        const next =
          safePosition === 'end'
            ? `${current.body}${current.body.endsWith('\n') ? '' : '\n'}\n${trimmed}\n`
            : `${trimmed}\n\n${current.body}`
        return await client.writeNote(relPath, next)
      }
      const v = requireVault()
      return await appendToNote(v.root, relPath, body, safePosition)
    }
  )

  handle(
    IPC.VAULT_CREATE_NOTE,
    async (_e, folder: NoteFolder, title: string | undefined, subpath: string = '') => {
      if (isRemoteWorkspaceActive()) {
        return await requireRemoteWorkspaceClient().createNote(folder, title, subpath)
      }
      const v = requireVault()
      return await createNote(v.root, folder, title, subpath)
    }
  )

  handle(
    IPC.VAULT_CREATE_EXCALIDRAW,
    async (_e, folder: NoteFolder, subpath: string = '', title?: string) => {
      if (isRemoteWorkspaceActive()) {
        return await requireRemoteWorkspaceClient().createExcalidraw(folder, subpath, title)
      }
      const v = requireVault()
      return await createExcalidraw(v.root, folder, subpath, title)
    }
  )

  handle(IPC.VAULT_RENAME_NOTE, async (_e, relPath: string, nextTitle: string) => {
    if (isRemoteWorkspaceActive()) {
      return await requireRemoteWorkspaceClient().renameNote(relPath, nextTitle)
    }
    const v = requireVault()
    return await renameNote(v.root, relPath, nextTitle)
  })

  handle(IPC.VAULT_DELETE_NOTE, async (_e, relPath: string) => {
    if (isRemoteWorkspaceActive()) {
      await requireRemoteWorkspaceClient().deleteNote(relPath)
      return
    }
    const v = requireVault()
    await deleteNote(v.root, relPath)
  })

  handle(IPC.VAULT_MOVE_TO_TRASH, async (_e, relPath: string) => {
    if (isRemoteWorkspaceActive()) {
      return await requireRemoteWorkspaceClient().moveToTrash(relPath)
    }
    const v = requireVault()
    return await moveToTrash(v.root, relPath)
  })

  handle(IPC.VAULT_RESTORE_FROM_TRASH, async (_e, relPath: string) => {
    if (isRemoteWorkspaceActive()) {
      return await requireRemoteWorkspaceClient().restoreFromTrash(relPath)
    }
    const v = requireVault()
    return await restoreFromTrash(v.root, relPath)
  })

  handle(IPC.VAULT_EMPTY_TRASH, async () => {
    if (isRemoteWorkspaceActive()) {
      await requireRemoteWorkspaceClient().emptyTrash()
      return
    }
    const v = requireVault()
    await emptyTrash(v.root)
  })

  handle(IPC.VAULT_ARCHIVE_NOTE, async (_e, relPath: string) => {
    if (isRemoteWorkspaceActive()) {
      return await requireRemoteWorkspaceClient().archiveNote(relPath)
    }
    const v = requireVault()
    return await archiveNote(v.root, relPath)
  })

  handle(IPC.VAULT_UNARCHIVE_NOTE, async (_e, relPath: string) => {
    if (isRemoteWorkspaceActive()) {
      return await requireRemoteWorkspaceClient().unarchiveNote(relPath)
    }
    const v = requireVault()
    return await unarchiveNote(v.root, relPath)
  })

  handle(IPC.VAULT_DUPLICATE_NOTE, async (_e, relPath: string) => {
    if (isRemoteWorkspaceActive()) {
      return await requireRemoteWorkspaceClient().duplicateNote(relPath)
    }
    const v = requireVault()
    return await duplicateNote(v.root, relPath)
  })

  handle(IPC.VAULT_EXPORT_NOTE_PDF, async (event, relPath: string) => {
    return await exportNotePdf(relPath, BrowserWindow.fromWebContents(event.sender))
  })

  handle(IPC.VAULT_REVEAL_NOTE, async (_e, relPath: string) => {
    if (isRemoteWorkspaceActive()) {
      throw new Error('Reveal in file manager is only available for local vaults.')
    }
    const v = requireVault()
    const abs = absolutePath(v.root, relPath)
    shell.showItemInFolder(abs)
  })

  handle(IPC.VAULT_REVEAL_NOTE_TARGET, async (_e, relPath: string) => {
    if (isRemoteWorkspaceActive()) {
      throw new Error('Reveal in file manager is only available for local vaults.')
    }
    const v = requireVault()
    const abs = absolutePath(v.root, relPath)
    let target: string
    try {
      target = await fsp.realpath(abs)
    } catch {
      throw new Error('Could not resolve the symlink target (it may be broken).')
    }
    shell.showItemInFolder(target)
  })

  handle(
    IPC.VAULT_MOVE_NOTE,
    async (_e, relPath: string, targetFolder: NoteFolder, targetSubpath: string) => {
      if (isRemoteWorkspaceActive()) {
        return await requireRemoteWorkspaceClient().moveNote(relPath, targetFolder, targetSubpath)
      }
      const v = requireVault()
      return await moveNote(v.root, relPath, targetFolder, targetSubpath)
    }
  )

  handle(
    IPC.VAULT_IMPORT_FILES,
    async (_e, notePath: string, sourcePaths: string[]) => {
      if (isRemoteWorkspaceActive()) {
        throw new Error('Desktop file import is only available for local vaults right now.')
      }
      const v = requireVault()
      return await importFiles(v.root, notePath, sourcePaths)
    }
  )

  handle(IPC.VAULT_IMPORT_PASTED_IMAGE, async (_e, input: PastedImageInput) => {
    if (isRemoteWorkspaceActive()) {
      throw new Error('Clipboard image paste is only available for local vaults right now.')
    }
    const v = requireVault()
    return await importPastedImage(v.root, input)
  })

  handle(IPC.VAULT_RENAME_ASSET, async (_e, relPath: string, nextName: string) => {
    if (isRemoteWorkspaceActive()) {
      throw new Error('Asset rename is only available for local vaults right now.')
    }
    const v = requireVault()
    return await renameAsset(v.root, relPath, nextName)
  })

  handle(IPC.VAULT_MOVE_ASSET, async (_e, relPath: string, targetDir: string) => {
    if (isRemoteWorkspaceActive()) {
      throw new Error('Asset move is only available for local vaults right now.')
    }
    const v = requireVault()
    return await moveAsset(v.root, relPath, targetDir)
  })

  handle(IPC.VAULT_DUPLICATE_ASSET, async (_e, relPath: string) => {
    if (isRemoteWorkspaceActive()) {
      throw new Error('Asset duplication is only available for local vaults right now.')
    }
    const v = requireVault()
    return await duplicateAsset(v.root, relPath)
  })

  handle(IPC.VAULT_DELETE_ASSET, async (_e, relPath: string) => {
    if (isRemoteWorkspaceActive()) {
      throw new Error('Asset deletion is only available for local vaults right now.')
    }
    const v = requireVault()
    return await deleteAsset(v.root, relPath)
  })

  handle(IPC.VAULT_RESTORE_DELETED_ASSET, async (_e, deleted: DeletedAsset) => {
    if (isRemoteWorkspaceActive()) {
      throw new Error('Asset restore is only available for local vaults right now.')
    }
    const v = requireVault()
    return await restoreDeletedAsset(v.root, deleted)
  })

  handle(
    IPC.VAULT_CREATE_FOLDER,
    async (_e, folder: NoteFolder, subpath: string) => {
      if (isRemoteWorkspaceActive()) {
        await requireRemoteWorkspaceClient().createFolder(folder, subpath)
        return
      }
      const v = requireVault()
      await createFolder(v.root, folder, subpath)
    }
  )

  handle(
    IPC.VAULT_RENAME_FOLDER,
    async (_e, folder: NoteFolder, oldSubpath: string, newSubpath: string) => {
      if (isRemoteWorkspaceActive()) {
        return await requireRemoteWorkspaceClient().renameFolder(folder, oldSubpath, newSubpath)
      }
      const v = requireVault()
      return await renameFolder(v.root, folder, oldSubpath, newSubpath)
    }
  )

  handle(
    IPC.VAULT_DELETE_FOLDER,
    async (_e, folder: NoteFolder, subpath: string) => {
      if (isRemoteWorkspaceActive()) {
        await requireRemoteWorkspaceClient().deleteFolder(folder, subpath)
        return
      }
      const v = requireVault()
      await deleteFolder(v.root, folder, subpath)
    }
  )

  handle(
    IPC.VAULT_DUPLICATE_FOLDER,
    async (_e, folder: NoteFolder, subpath: string) => {
      if (isRemoteWorkspaceActive()) {
        return await requireRemoteWorkspaceClient().duplicateFolder(folder, subpath)
      }
      const v = requireVault()
      return await duplicateFolder(v.root, folder, subpath)
    }
  )

  handle(
    IPC.VAULT_REVEAL_FOLDER,
    async (_e, folder: NoteFolder, subpath: string) => {
      if (isRemoteWorkspaceActive()) {
        throw new Error('Reveal in file manager is only available for local vaults.')
      }
      const v = requireVault()
      const abs = await folderAbsolutePath(v.root, folder, subpath)
      await shell.openPath(abs)
    }
  )

  handle(
    IPC.VAULT_REVEAL_FOLDER_TARGET,
    async (_e, folder: NoteFolder, subpath: string) => {
      if (isRemoteWorkspaceActive()) {
        throw new Error('Reveal in file manager is only available for local vaults.')
      }
      const v = requireVault()
      const abs = await folderAbsolutePath(v.root, folder, subpath)
      let target: string
      try {
        target = await fsp.realpath(abs)
      } catch {
        throw new Error('Could not resolve the symlink target (it may be broken).')
      }
      await shell.openPath(target)
    }
  )

  handle(IPC.VAULT_REVEAL_ASSETS_DIR, async () => {
    if (isRemoteWorkspaceActive()) {
      throw new Error('Reveal in file manager is only available for local vaults.')
    }
    const v = requireVault()
    await shell.openPath(v.root)
  })

  // Route window chrome controls to the window that actually sent the
  // IPC (via `e.sender`) so that floating note windows can minimize /
  // maximize / close themselves without hijacking the main window.
  on(IPC.WINDOW_MINIMIZE, (e) => {
    BrowserWindow.fromWebContents(e.sender)?.minimize()
  })
  on(IPC.WINDOW_TOGGLE_MAXIMIZE, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  on(IPC.WINDOW_CLOSE, (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close()
  })

  handle(IPC.WINDOW_OPEN_NOTE, async (_e, relPath: string) => {
    openFloatingNoteWindow(relPath)
  })

  handle(IPC.WINDOW_OPEN_VAULT, async (event) => {
    return await openVaultInNewWindow(BrowserWindow.fromWebContents(event.sender))
  })

  handle(IPC.APP_READ_EXTERNAL_FILE, async (event): Promise<ExternalFileContent> => {
    const win = requireEventWindow(event)
    const abs = externalFileWindows.get(win.id)
    if (!abs || !isMarkdownFilePath(abs)) {
      throw new Error('No markdown file is bound to this window.')
    }
    const body = await fsp.readFile(abs, 'utf8')
    return { path: abs, name: path.basename(abs), body }
  })

  handle(IPC.APP_WRITE_EXTERNAL_FILE, async (event, body: string): Promise<void> => {
    const win = requireEventWindow(event)
    const abs = externalFileWindows.get(win.id)
    if (!abs || !isMarkdownFilePath(abs)) {
      throw new Error('No markdown file is bound to this window.')
    }
    await fsp.writeFile(abs, body, 'utf8')
  })

  handle(IPC.APP_MOVE_EXTERNAL_FILE_TO_VAULT, async (event): Promise<MoveExternalFileResult> => {
    const win = requireEventWindow(event)
    const abs = externalFileWindows.get(win.id)
    if (!abs || !isMarkdownFilePath(abs)) {
      throw new Error('No markdown file is bound to this window.')
    }
    const vault = await resolveActiveLocalVault()
    if (!vault) {
      throw new Error('Open a vault first, then move this file into it.')
    }
    const meta = await importExternalNote(vault.root, abs)
    externalFileWindows.delete(win.id)
    const targetWin =
      findWindowForVaultRoot(vault.root) ??
      (await createWindow({ initialVaultRoot: vault.root, persistInitialVault: true }))
    focusWindow(targetWin)
    queueNoteOpenForWindow(targetWin, meta.path)
    if (!win.isDestroyed()) win.close()
    return { vaultRoot: vault.root, relPath: meta.path }
  })

  // Drag-and-drop a markdown file onto a window. Routes through the same
  // vault-aware opener as the Finder "Open in ZenNotes" entry / `open-file`
  // event: a note inside a known vault opens against that vault, anything
  // else opens in a standalone external-file window. The absolute path comes
  // from `webUtils.getPathForFile` on the dropped File, and the stat +
  // markdown checks inside `openMarkdownFileFromOS` re-validate it.
  handle(IPC.APP_OPEN_MARKDOWN_FILE, async (_event, rawPath: string): Promise<boolean> => {
    if (typeof rawPath !== 'string' || !rawPath.trim() || !isMarkdownFilePath(rawPath)) {
      return false
    }
    return await openMarkdownFileFromOS(path.resolve(rawPath), false)
  })

  handle(IPC.WINDOW_TOGGLE_QUICK_CAPTURE, async () => {
    await toggleQuickCaptureWindow()
  })

  handle(IPC.APP_GET_QUICK_CAPTURE_HOTKEY, async () => {
    const cfg = await loadConfig()
    return cfg.quickCaptureHotkey
  })

  handle(IPC.APP_SET_QUICK_CAPTURE_HOTKEY, async (_e, hotkey: string) => {
    const trimmed = typeof hotkey === 'string' ? hotkey.trim() : ''
    const result = registerQuickCaptureHotkey(trimmed)
    if (result.ok) {
      await updateConfig((cfg) => ({ ...cfg, quickCaptureHotkey: trimmed }))
    }
    return { ok: result.ok, hotkey: trimmed, error: result.error }
  })

  handle(IPC.APP_GET_QUICK_CAPTURE_PINNED, async () => {
    const cfg = await loadConfig()
    quickCapturePinned = cfg.quickCapturePinned
    return quickCapturePinned
  })

  handle(IPC.APP_SET_QUICK_CAPTURE_PINNED, async (_e, pinned: boolean) => {
    quickCapturePinned = pinned === true
    applyQuickCapturePinned()
    await updateConfig((cfg) => ({ ...cfg, quickCapturePinned }))
    return quickCapturePinned
  })

  handle(IPC.TIKZ_RENDER, async (_e, source: string) => {
    const result = await renderTikz(source)
    if (result.ok) return { ok: true, svg: result.svg }
    return { ok: false, error: result.error }
  })

  handle(IPC.MCP_RUNTIME, async () => await getMcpServerRuntime())
  handle(IPC.MCP_STATUS, async () => await getMcpClientStatuses())
  handle(IPC.MCP_INSTALL, async (_e, id: McpClientId) => await installMcpForClient(id))
  handle(IPC.MCP_UNINSTALL, async (_e, id: McpClientId) => await uninstallMcpForClient(id))
  handle(IPC.MCP_GET_INSTRUCTIONS, async (): Promise<McpInstructionsPayload> => {
    const custom = await readCustomInstructions()
    return {
      defaultValue: MCP_SERVER_INSTRUCTIONS,
      current: custom ?? MCP_SERVER_INSTRUCTIONS,
      isCustom: custom != null,
      filePath: instructionsFilePath()
    }
  })
  handle(
    IPC.MCP_SET_INSTRUCTIONS,
    async (_e, next: string | null): Promise<McpInstructionsPayload> => {
      await writeCustomInstructions(next)
      const custom = await readCustomInstructions()
      return {
        defaultValue: MCP_SERVER_INSTRUCTIONS,
        current: custom ?? MCP_SERVER_INSTRUCTIONS,
        isCustom: custom != null,
        filePath: instructionsFilePath()
      }
    }
  )

  handle(IPC.CLI_GET_STATUS, async () => await getCliInstallStatus())
  handle(IPC.CLI_INSTALL, async () => await installCli())
  handle(IPC.CLI_UNINSTALL, async () => await uninstallCli())
  handle(IPC.RAYCAST_GET_STATUS, async () => await getRaycastExtensionStatus())
  handle(IPC.RAYCAST_INSTALL, async () => await installRaycastExtension())
}

/**
 * Pop a note out into a standalone always-visible window. The same
 * note is reused if a floating window is already showing it — we just
 * focus the existing one rather than spawning duplicates.
 */
const floatingNoteWindows = new Map<string, BrowserWindow>()
function openFloatingNoteWindow(relPath: string): void {
  const floatingWindowStartedAt = performance.now()
  const sourceWindow = currentIpcWindow() ?? mainWindow
  const sourceVault =
    sourceWindow && !sourceWindow.isDestroyed() ? windowVaults.vaultForWindow(sourceWindow.id) : currentVault
  const floatingKey = `${sourceVault?.root ?? 'no-vault'}:${relPath}`
  const existing = floatingNoteWindows.get(floatingKey)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.focus()
    return
  }
  const mac = isMac()
  const win = new BrowserWindow({
    width: 720,
    height: 720,
    minWidth: 360,
    minHeight: 320,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: mac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 12, y: 12 },
    ...(mac
      ? {
          backgroundColor: MAC_WINDOW_BACKGROUND_COLOR
        }
      : {
          backgroundColor: '#faf7f0',
          icon: windowIconPath()
        }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      // Keep the renderer isolated and node-free, but the current preload
      // still relies on Node/Electron APIs that are not available inside a
      // fully sandboxed preload context.
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  floatingNoteWindows.set(floatingKey, win)
  win.on('closed', () => {
    floatingNoteWindows.delete(floatingKey)
    windowVaults.clearWindow(win.id)
  })
  win.on('ready-to-show', () => {
    recordMainPerf('main.floating-window.ready-to-show', performance.now() - floatingWindowStartedAt, {
      path: relPath
    })
    win.show()
  })
  win.webContents.once('did-finish-load', () => {
    recordMainPerf(
      'main.floating-window.did-finish-load',
      performance.now() - floatingWindowStartedAt,
      { path: relPath }
    )
  })
  installNavigationGuards(win)
  installZoomControls(win)
  applyZoomFactor(win, currentZoomFactor)
  if (sourceWindow && !sourceWindow.isDestroyed()) {
    inheritWindowWorkspaceSession(sourceWindow, win)
  }

  const params = `?floating=1&note=${encodeURIComponent(relPath)}`
  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) {
    void win.loadURL(`${devServerUrl}${params}`)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'), {
      search: params.slice(1)
    })
  }
}

/**
 * Quick capture window — a small always-on-top floating panel that
 * appears anywhere via a system-wide hotkey. Singleton, hide-on-close
 * (so the second invocation is instant), and lets the user dump text
 * into a brand-new note or append to an existing one.
 */
let quickCaptureWindow: BrowserWindow | null = null
let quickCaptureQuitting = false
let registeredQuickCaptureHotkey: string | null = null
/** When true, the quick-capture window stays pinned on top and does not
 *  auto-hide on blur. Mirrors PersistedConfig.quickCapturePinned. */
let quickCapturePinned = false

async function ensureQuickCaptureWindow(): Promise<BrowserWindow> {
  if (quickCaptureWindow && !quickCaptureWindow.isDestroyed()) return quickCaptureWindow
  const mac = isMac()
  const sourceWindow = BrowserWindow.getFocusedWindow() ?? mainWindow
  const win = new BrowserWindow({
    width: 620,
    height: 340,
    minWidth: 460,
    minHeight: 260,
    title: 'ZenNotes Quick Capture',
    show: false,
    frame: false,
    titleBarStyle: mac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 12, y: 12 },
    autoHideMenuBar: true,
    alwaysOnTop: true,
    skipTaskbar: !mac,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: mac ? MAC_WINDOW_BACKGROUND_COLOR : '#faf7f0',
    ...(mac ? {} : { icon: windowIconPath() }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (mac) {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }

  // Restore the persisted pin state for this freshly created window.
  void loadConfig().then((cfg) => {
    quickCapturePinned = cfg.quickCapturePinned
    applyQuickCapturePinned()
  })

  win.on('close', (event) => {
    if (quickCaptureQuitting) return
    event.preventDefault()
    win.hide()
  })
  win.on('closed', () => {
    if (quickCaptureWindow === win) quickCaptureWindow = null
    windowVaults.clearWindow(win.id)
  })
  win.on('blur', () => {
    // Focus-out hides the panel so the user's flow snaps back to whatever
    // they were doing — same UX as Spotlight / Raycast. When pinned, the
    // panel stays put so it floats on top while you work in other windows.
    if (quickCapturePinned) return
    if (!win.isDestroyed() && win.isVisible()) win.hide()
  })

  installNavigationGuards(win)
  installZoomControls(win)
  applyZoomFactor(win, currentZoomFactor)
  if (sourceWindow && !sourceWindow.isDestroyed()) {
    inheritWindowWorkspaceSession(sourceWindow, win)
  } else {
    await ipcWindowContext.run(win, async () => {
      await loadCurrentVaultFromConfig()
    })
  }

  const params = '?quickCapture=1'
  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) {
    void win.loadURL(`${devServerUrl}${params}`)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'), {
      search: params.slice(1)
    })
  }

  quickCaptureWindow = win
  return win
}

/** Reflect the current pin state on the live quick-capture window. Pinned uses
 *  a higher always-on-top level so it floats above other apps and fullscreen. */
function applyQuickCapturePinned(): void {
  const win = quickCaptureWindow
  if (!win || win.isDestroyed()) return
  win.setAlwaysOnTop(true, quickCapturePinned ? 'screen-saver' : 'floating')
}

async function showQuickCaptureWindow(): Promise<void> {
  const win = await ensureQuickCaptureWindow()
  const sourceWindow = BrowserWindow.getFocusedWindow() ?? mainWindow
  if (sourceWindow && sourceWindow.id !== win.id && !sourceWindow.isDestroyed()) {
    inheritWindowWorkspaceSession(sourceWindow, win)
  }
  win.show()
  win.focus()
}

async function toggleQuickCaptureWindow(): Promise<void> {
  const win = quickCaptureWindow
  if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) {
    win.hide()
    return
  }
  await showQuickCaptureWindow()
}

function unregisterQuickCaptureHotkey(): void {
  if (!registeredQuickCaptureHotkey) return
  try {
    globalShortcut.unregister(registeredQuickCaptureHotkey)
  } catch {
    // Ignore — Electron throws if the binding wasn't registered cleanly.
  }
  registeredQuickCaptureHotkey = null
}

function registerQuickCaptureHotkey(hotkey: string): { ok: boolean; error?: string } {
  unregisterQuickCaptureHotkey()
  const trimmed = hotkey.trim()
  if (!trimmed) return { ok: true }
  try {
    const ok = globalShortcut.register(trimmed, () => {
      console.info(`[zen:quick-capture] hotkey pressed: ${trimmed}`)
      void toggleQuickCaptureWindow()
    })
    if (!ok) {
      return { ok: false, error: `Failed to register quick capture hotkey: ${trimmed}` }
    }
    if (!globalShortcut.isRegistered(trimmed)) {
      return { ok: false, error: `Quick capture hotkey was not registered by the system: ${trimmed}` }
    }
    registeredQuickCaptureHotkey = trimmed
    console.info(`[zen:quick-capture] registered hotkey: ${trimmed}`)
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  }
}

// Set the app name before the ready event so the dock / menu bar /
// About panel all show "ZenNotes" instead of the default "Electron"
// during dev. electron-builder handles this for packaged builds via
// `productName`, but in `npm run dev` we have to announce it ourselves.
app.setName('ZenNotes')
if (isMac()) {
  app.setAboutPanelOptions({
    applicationName: 'ZenNotes',
    applicationVersion: app.getVersion()
  })
}

function installAppMenu(): void {
  if (!isMac()) {
    // On Windows/Linux we keep `autoHideMenuBar: true` and skip the menu.
    Menu.setApplicationMenu(null)
    return
  }
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'ZenNotes',
      submenu: [
        { label: 'About ZenNotes', role: 'about' },
        { type: 'separator' },
        {
          label: 'Check for Updates…',
          click: () => {
            void runMenuUpdateCheck()
          }
        },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            const target = BrowserWindow.getFocusedWindow() ?? mainWindow
            target?.webContents.send(IPC.APP_OPEN_SETTINGS)
          }
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: 'Hide ZenNotes' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: 'Quit ZenNotes' }
      ]
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Vault in New Window…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => {
            void openVaultInNewWindow(BrowserWindow.getFocusedWindow() ?? mainWindow)
          }
        }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        ...(app.isPackaged
          ? []
          : ([{ role: 'toggleDevTools' }] as Electron.MenuItemConstructorOptions[])),
        { type: 'separator' },
        {
          label: 'Actual Size',
          accelerator: 'CmdOrCtrl+0',
          click: () => {
            void setWindowZoom(BrowserWindow.getFocusedWindow(), DEFAULT_ZOOM_FACTOR)
          }
        },
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+=',
          click: () => {
            void adjustWindowZoom(BrowserWindow.getFocusedWindow(), ZOOM_STEP)
          }
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: () => {
            void adjustWindowZoom(BrowserWindow.getFocusedWindow(), -ZOOM_STEP)
          }
        },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        // Electron 41 leaves these macOS tab roles unlabeled unless the
        // template supplies text, which renders as blank Window menu rows.
        { role: 'toggleTabBar', label: 'Toggle Tab Bar' },
        { role: 'selectNextTab', label: 'Show Next Tab' },
        { role: 'selectPreviousTab', label: 'Show Previous Tab' },
        { role: 'mergeAllWindows', label: 'Merge All Windows' },
        { type: 'separator' },
        { role: 'front' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'ZenNotes Website',
          click: () => {
            openAllowedExternalUrl(APP_WEBSITE_URL)
          }
        },
        {
          label: 'Join Discord',
          click: () => {
            openAllowedExternalUrl(APP_DISCORD_URL)
          }
        },
        { type: 'separator' },
        {
          label: 'GitHub Repository',
          click: () => {
            openAllowedExternalUrl(APP_REPOSITORY_URL)
          }
        },
        {
          label: 'Latest Release',
          click: () => {
            openAllowedExternalUrl(APP_RELEASES_URL)
          }
        },
        {
          label: 'Report an Issue',
          click: () => {
            openAllowedExternalUrl(APP_ISSUES_URL)
          }
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function runMenuUpdateCheck(): Promise<void> {
  const parent = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined
  const showDialog = async (
    options: Electron.MessageBoxOptions
  ): Promise<Electron.MessageBoxReturnValue> => {
    return parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options)
  }
  const state = await checkForAppUpdates()

  if (state.phase === 'available') {
    const { response } = await showDialog({
      type: 'info',
      buttons: ['Download Update', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'ZenNotes Update Available',
      message: `ZenNotes ${state.availableVersion ?? ''} is available.`,
      detail: state.message
    })
    if (response === 0) {
      void downloadAppUpdate()
      await showDialog({
        type: 'info',
        buttons: ['OK'],
        defaultId: 0,
        title: 'Downloading Update',
        message: `ZenNotes ${state.availableVersion ?? ''} is downloading in the background.`,
        detail: 'Open Settings → About to track progress and install when the download finishes.'
      })
    }
    return
  }

  if (state.phase === 'downloaded') {
    const { response } = await showDialog({
      type: 'info',
      buttons: ['Install and Relaunch', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'ZenNotes Update Ready',
      message: `ZenNotes ${state.availableVersion ?? ''} is ready to install.`,
      detail: state.message
    })
    if (response === 0) {
      installAppUpdate()
    }
    return
  }

  if (state.phase === 'downloading' || state.phase === 'checking') {
    await showDialog({
      type: 'info',
      buttons: ['OK'],
      defaultId: 0,
      title: 'ZenNotes Updates',
      message: state.phase === 'checking' ? 'Checking for updates…' : 'Downloading update…',
      detail: state.message
    })
    return
  }

  await showDialog({
    type: state.phase === 'error' ? 'warning' : 'info',
    buttons: ['OK'],
    defaultId: 0,
    title: 'ZenNotes Updates',
    message:
      state.phase === 'not-available'
        ? 'ZenNotes is up to date.'
        : state.phase === 'unsupported'
          ? 'Update checks are unavailable.'
          : state.phase === 'error'
            ? 'Could not check for updates.'
            : 'ZenNotes Updates',
    detail: state.message
  })
}

// On some Linux setups (notably NVIDIA + Fedora) Chromium's VAAPI probe fails
// with "vaInitialize failed: unknown libva error" because the driver doesn't
// expose a working libva. We don't use GPU video decode, so disable the VAAPI
// features to avoid the error and the failed-probe noise. Linux-only; must run
// before `app.whenReady()`.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('disable-features', 'VaapiVideoDecoder,VaapiVideoEncoder')
  // Wayland compositors (including Hyprland/Omarchy) expose global shortcuts
  // through xdg-desktop-portal, but Electron only wires that path when this
  // Chromium feature is enabled before app.whenReady().
  app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal')
}

app.whenReady().then(async () => {
  // A second launch (e.g. double-clicking a .md on Windows/Linux) hands
  // its argv to the primary instance via 'second-instance' below, then
  // quits here so there's only ever one ZenNotes process.
  if (!gotSingleInstanceLock) {
    app.quit()
    return
  }

  await migrateLegacyRemoteWorkspaceSecrets()

  protocol.handle(LOCAL_ASSET_SCHEME, async (request) => {
    const remote = decodeRemoteAssetRequest(request.url)
    if (remote) {
      const client = remoteWorkspaceClient
      if (!client || client.baseUrl !== remote.baseUrl) {
        throw new Error(`No remote workspace client for ${remote.baseUrl}`)
      }
      const response = await client.fetchAssetResponse(remote.relPath)
      return response
    }

    const abs = decodeLocalAssetRequestPath(request.url)
    if (!abs || !windowVaults.isPathInsideOpenLocalVault(abs)) {
      throw new Error(`Invalid local asset URL: ${request.url}`)
    }
    const data = await fsp.readFile(abs)
    return new Response(data, {
      headers: {
        'content-type': mimeTypeForPath(abs),
        'cache-control': 'no-cache'
      }
    })
  })

  // Permissions this app grants to its own renderer (deny everything else —
  // it's our app talking to our own vault, no third-party surface):
  //   - 'local-fonts'   → queryLocalFonts() for the font picker
  //   - clipboard read/write → copy buttons and vim's "+y / "+p registers
  //     (without this, navigator.clipboard throws NotAllowedError, which on
  //     macOS and Wayland broke yank/paste to the system clipboard — #79)
  const GRANTED_PERMISSIONS = new Set<string>([
    'local-fonts',
    'clipboard-read',
    'clipboard-sanitized-write'
  ])
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(GRANTED_PERMISSIONS.has(permission as string))
  })
  // writeText()/readText() gate on the synchronous check handler, not the
  // async request handler — grant the same set here or they still fail.
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    GRANTED_PERMISSIONS.has(permission as string)
  )

  // macOS dock icon. `BrowserWindow.icon` has no effect on macOS — the
  // dock picks up whatever the running binary advertises. During
  // `npm run dev` that's Electron's default, so we force our own.
  if (isMac() && app.dock) {
    try {
      const iconPath = path.join(__dirname, '../../build/icon.png')
      app.dock.setIcon(iconPath)
    } catch (err) {
      console.error('Failed to set dock icon', err)
    }
  }

  installAppMenu()
  registerIpc()
  initAppUpdater()
  registerAppDeepLinkProtocol()
  const startupDeepLinkResult = handleStartupDeepLinks(process.argv)
  handleStartupMarkdownArgs(process.argv, true)

  // Honor a file ZenNotes was launched to open before falling back to a
  // default-vault window, so double-clicking a .md doesn't also pop an
  // unrelated window.
  const openedFromFile = await flushPendingFileOpens()
  if (!openedFromFile && startupDeepLinkResult !== 'quick-capture') {
    await ensureMainWindow()
  }
  void flushPendingFloatingNoteRequests()
  scheduleBackgroundAppUpdateCheck()

  try {
    const cfg = await loadConfig()
    const desired = cfg.quickCaptureHotkey || DEFAULT_QUICK_CAPTURE_HOTKEY
    const result = registerQuickCaptureHotkey(desired)
    if (!result.ok) console.warn(result.error ?? `Failed to bind ${desired}`)
  } catch (err) {
    console.warn('Quick capture hotkey registration failed', err)
  }

  app.on('activate', () => {
    // Count only real workspace windows: a hidden quick-capture panel
    // (or other utility window) must not stop the dock click from
    // bringing back a usable window.
    const hasWorkspaceWindow = BrowserWindow.getAllWindows().some(
      (win) => !win.isDestroyed() && isWorkspaceWindow(win)
    )
    if (!hasWorkspaceWindow) void ensureMainWindow()
  })

  app.on('new-window-for-tab', () => {
    const sourceWindow = BrowserWindow.getFocusedWindow() ?? mainWindow
    void createWindow({
      inheritWorkspaceFrom: sourceWindow,
      persistInitialVault: false
    })
  })

  appStartupComplete = true
})

app.on('open-url', (event, url) => {
  event.preventDefault()
  if (handleExternalOpenUrl(url) === 'none') {
    console.warn(`Ignoring unsupported ${ZENNOTES_DEEP_LINK_SCHEME} URL: ${url}`)
  }
})

// macOS delivers Finder "Open With" / double-click / dock-drop here.
// During cold start this can fire before the app is ready, so the
// request is queued and flushed in whenReady; reuse the main window for
// the launch file but spawn a fresh window once we're already running.
app.on('open-file', (event, filePath) => {
  event.preventDefault()
  queueMarkdownFileOpen(filePath, !appStartupComplete)
})

// Windows/Linux: a relaunch (e.g. opening a .md while ZenNotes is
// already running) forwards its argv here instead of starting a second
// process.
app.on('second-instance', (_event, argv) => {
  const deepLinkResult = handleStartupDeepLinks(argv)
  handleStartupMarkdownArgs(argv, false)
  if (deepLinkResult === 'quick-capture') return
  if (mainWindow && !mainWindow.isDestroyed()) {
    focusWindow(mainWindow)
    return
  }
  void ensureMainWindow()
})

app.on('window-all-closed', () => {
  windowVaults.stopAll()
  stopRemoteWatch()
  if (!isMac()) app.quit()
})

app.on('before-quit', () => {
  windowVaults.stopAll()
  stopRemoteWatch()
  quickCaptureQuitting = true
  unregisterQuickCaptureHotkey()
})
