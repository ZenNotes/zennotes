import {
  app,
  BrowserWindow,
  dialog,
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
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { IPC } from '@shared/ipc'
import type {
  NoteFolder,
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
  archiveNote,
  createFolder,
  createNote,
  deleteFolder,
  deleteNote,
  duplicateFolder,
  duplicateNote,
  emptyTrash,
  ensureVaultLayout,
  folderAbsolutePath,
  generateDemoTour,
  getVaultSettings,
  hasAssetsDir,
  importFiles,
  listAssets,
  listFolders,
  listNotes,
  loadConfig,
  moveNote,
  moveToTrash,
  readNote,
  renameFolder,
  renameNote,
  removeDemoTour,
  restoreFromTrash,
  searchVaultTextCapabilities,
  searchVaultText,
  setVaultSettings,
  type PersistedRemoteWorkspaceConfig,
  type PersistedRemoteWorkspaceProfile,
  type PersistedWindowState,
  updateConfig,
  unarchiveNote,
  vaultInfo,
  writeNote
} from './vault'
import {
  deleteRemoteWorkspaceSecret,
  getRemoteWorkspaceSecret,
  setRemoteWorkspaceSecret
} from './secret-store'
import { scanAllTasks, scanTasksForPath } from './tasks'
import { VaultWatcher } from './watcher'
import { renderTikz } from './tikz'
import { RemoteServerClient } from './remote/server-client'
import {
  getMcpClientStatuses,
  getMcpServerRuntime,
  installMcpForClient,
  uninstallMcpForClient
} from './mcp-integrations'
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
let currentVault: VaultInfo | null = null
let currentWorkspaceMode: 'local' | 'remote' = 'local'
let remoteWorkspaceConfig: PersistedRemoteWorkspaceConfig | null = null
let currentRemoteWorkspaceProfileId: string | null = null
let remoteWorkspaceClient: RemoteServerClient | null = null
let remoteServerCapabilities: ServerCapabilities | null = null
let stopRemoteVaultWatch: (() => void) | null = null
const watcher = new VaultWatcher()
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
const APP_WEBSITE_URL = 'https://zennotes.org'
const APP_DISCORD_URL = 'https://discord.gg/W4fWzapKS6'
const APP_REPOSITORY_URL = 'https://github.com/ZenNotes/zennotes'
const APP_RELEASES_URL = 'https://github.com/ZenNotes/zennotes/releases/latest'
const APP_ISSUES_URL = 'https://github.com/ZenNotes/zennotes/issues'
let currentZoomFactor = DEFAULT_ZOOM_FACTOR

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

function isPathInsideVault(absPath: string): boolean {
  if (!currentVault) return false
  const resolved = path.resolve(absPath)
  const root = path.resolve(currentVault.root)
  return resolved === root || resolved.startsWith(root + path.sep)
}

function installNavigationGuards(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`${LOCAL_ASSET_SCHEME}://`)) {
      const abs = decodeLocalAssetRequestPath(url)
      if (abs && isPathInsideVault(abs)) {
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
      if (abs && isPathInsideVault(abs)) {
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
  const bounds = win.isMaximized() ? win.getNormalBounds() : win.getBounds()
  await updateConfig((cfg) => ({
    ...cfg,
    windowState: {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized: win.isMaximized()
    }
  }))
}

async function createWindow(): Promise<void> {
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

  mainWindow = win

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
    if (mainWindow === win) mainWindow = null
  })

  installNavigationGuards(win)
  installZoomControls(win)
  applyZoomFactor(win, currentZoomFactor)

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) {
    void win.loadURL(devServerUrl)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function currentRemoteWorkspaceInfo(): RemoteWorkspaceInfo | null {
  if (!remoteWorkspaceConfig) return null
  return {
    mode: currentWorkspaceMode,
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

function broadcastVaultChange(ev: VaultChangeEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.VAULT_ON_CHANGE, ev)
  }
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
    broadcastVaultChange(ev)
  })
}

async function setVault(root: string): Promise<VaultInfo> {
  await ensureVaultLayout(root)
  currentVault = vaultInfo(root)
  currentWorkspaceMode = 'local'
  remoteWorkspaceClient = null
  remoteWorkspaceConfig = null
  currentRemoteWorkspaceProfileId = null
  remoteServerCapabilities = null
  stopRemoteWatch()
  await updateConfig((cfg) => ({
    ...cfg,
    workspaceMode: 'local',
    vaultRoot: root,
    remoteWorkspaceProfileId: null
  }))
  watcher.start(root, (ev: VaultChangeEvent) => {
    broadcastVaultChange(ev)
  })
  return currentVault
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

  watcher.stop()
  currentWorkspaceMode = 'remote'
  currentVault = vault
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
  stopRemoteWatch()
  remoteWorkspaceClient = null
  remoteWorkspaceConfig = null
  currentRemoteWorkspaceProfileId = null
  remoteServerCapabilities = null
  currentWorkspaceMode = 'local'

  if (cfg.vaultRoot) {
    return await setVault(cfg.vaultRoot)
  }

  watcher.stop()
  currentVault = null
  await updateConfig((current) => ({
    ...current,
    workspaceMode: 'local',
    remoteWorkspaceProfileId: null
  }))
  return null
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

function requireVault(): VaultInfo {
  if (!currentVault) throw new Error('No vault is open')
  return currentVault
}

function isRemoteWorkspaceActive(): boolean {
  return currentWorkspaceMode === 'remote' && remoteWorkspaceClient != null
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

function registerIpc(): void {
  const handle = <Args extends unknown[], Result>(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>
  ): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      assertTrustedIpcEvent(event)
      return await listener(event, ...(args as Args))
    })
  }

  const on = <Args extends unknown[]>(
    channel: string,
    listener: (event: IpcMainEvent, ...args: Args) => void
  ): void => {
    ipcMain.on(channel, (event, ...args) => {
      assertTrustedIpcEvent(event)
      listener(event, ...(args as Args))
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
    if (currentVault) return currentVault
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
        const result = await setRemoteWorkspace(cfg.remoteWorkspace.baseUrl, authToken, {
          persist: false,
          profileId: remoteProfile?.id ?? cfg.remoteWorkspaceProfileId,
          vaultPath: remoteProfile?.vaultPath ?? null
        })
        return result.vault
      } catch {
        currentRemoteWorkspaceProfileId = null
        return null
      }
    }
    if (cfg.vaultRoot) {
      try {
        return await setVault(cfg.vaultRoot)
      } catch {
        return null
      }
    }
    return null
  })

  handle(IPC.VAULT_PICK, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose a vault folder',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Open Vault'
    })
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

  handle(IPC.VAULT_LIST_NOTES, async () => {
    if (isRemoteWorkspaceActive()) return await requireRemoteWorkspaceClient().listNotes()
    const v = requireVault()
    return await listNotes(v.root)
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

  handle(IPC.VAULT_WRITE_NOTE, async (_e, relPath: string, body: string) => {
    if (isRemoteWorkspaceActive()) {
      return await requireRemoteWorkspaceClient().writeNote(relPath, body)
    }
    const v = requireVault()
    return await writeNote(v.root, relPath, body)
  })

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

  handle(IPC.VAULT_REVEAL_NOTE, async (_e, relPath: string) => {
    if (isRemoteWorkspaceActive()) {
      throw new Error('Reveal in file manager is only available for local vaults.')
    }
    const v = requireVault()
    const abs = absolutePath(v.root, relPath)
    shell.showItemInFolder(abs)
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
}

/**
 * Pop a note out into a standalone always-visible window. The same
 * note is reused if a floating window is already showing it — we just
 * focus the existing one rather than spawning duplicates.
 */
const floatingNoteWindows = new Map<string, BrowserWindow>()
function openFloatingNoteWindow(relPath: string): void {
  const floatingWindowStartedAt = performance.now()
  const existing = floatingNoteWindows.get(relPath)
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

  floatingNoteWindows.set(relPath, win)
  win.on('closed', () => {
    floatingNoteWindows.delete(relPath)
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
            mainWindow?.webContents.send(IPC.APP_OPEN_SETTINGS)
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

app.whenReady().then(async () => {
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
    if (!abs || !isPathInsideVault(abs)) {
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

  // Auto-grant the Local Font Access permission so `queryLocalFonts()`
  // can enumerate system fonts without a prompt. This is our own app
  // talking to our own vault — no third-party surface.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    // 'local-fonts' is not in Electron's published permission union yet,
    // but Chromium emits it when the renderer calls `queryLocalFonts()`.
    if ((permission as string) === 'local-fonts') return callback(true)
    callback(false)
  })

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
  await createWindow()
  scheduleBackgroundAppUpdateCheck()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  watcher.stop()
  if (!isMac()) app.quit()
})

app.on('before-quit', () => {
  watcher.stop()
})
