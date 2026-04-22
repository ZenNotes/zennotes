/**
 * HTTP/WebSocket implementation of the `window.zen` API.
 *
 * The Electron preload (`src/preload/index.ts` in the desktop build)
 * exposes a `zen` object on `window` with ~60 methods. The web client
 * needs an object with the exact same shape, backed by HTTP calls to
 * the Go server instead of Electron IPC. Swapping this object is the
 * one and only change needed to keep every UI component in
 * `src/components/**` working without edits.
 *
 * Not every desktop-only method has a meaningful web equivalent
 * (native menus, window chrome, auto-updater, TikZ subprocess). Those
 * resolve to sensible no-ops or "unsupported" states so the UI never
 * crashes; the user just doesn't see the corresponding affordance.
 */

import appPackage from '../../package.json'
import {
  installZenBridge,
  type ZenAppInfo,
  type ZenBridge,
  type ZenCapabilities
} from '@zennotes/bridge-contract/bridge'
import type {
  AppUpdateState,
  AssetMeta,
  DirectoryBrowseResult,
  FolderEntry,
  ImportedAsset,
  NoteContent,
  NoteFolder,
  NoteMeta,
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
} from '@shared/ipc'
import type { VaultTask } from '@shared/tasks'
import type {
  McpClientId,
  McpClientStatus,
  McpInstructionsPayload,
  McpServerRuntime
} from '@shared/mcp-clients'

const WEB_CAPABILITIES: ZenCapabilities = {
  supportsUpdater: false,
  supportsNativeMenus: false,
  supportsFloatingWindows: false,
  supportsLocalFilesystemPickers: false,
  supportsDesktopNotifications: false,
  supportsRemoteWorkspace: false
}

const WEB_APP_INFO: ZenAppInfo = {
  name: appPackage.name,
  productName: 'ZenNotes',
  version: appPackage.version,
  description: appPackage.description,
  homepage: appPackage.homepage,
  runtime: 'web'
}

const API_BASE = '/api'

type JsonBody = Record<string, unknown> | unknown[]
type JsonRequestInit = Omit<RequestInit, 'body'> & { body?: JsonBody }

class HttpRequestError extends Error {
  status: number
  path: string

  constructor(status: number, path: string, message: string) {
    super(message)
    this.name = 'HttpRequestError'
    this.status = status
    this.path = path
  }
}

function wrapRouteUpgradeError(path: string, err: unknown): never {
  if (
    err instanceof HttpRequestError &&
    err.status === 404 &&
    (path.startsWith('/fs/browse') || path === '/vault/select')
  ) {
    throw new Error(
      'Your ZenNotes server is running an older build and does not support the new vault picker yet. Restart `npm run dev:server` and reload the page.'
    )
  }
  throw err instanceof Error ? err : new Error(String(err))
}

async function jsonRequest<T>(
  path: string,
  init?: JsonRequestInit
): Promise<T> {
  const headers = new Headers(init?.headers)
  const hasBody = init?.body !== undefined
  if (hasBody && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    body: hasBody ? JSON.stringify(init!.body) : undefined,
    credentials: 'same-origin'
  })
  if (!res.ok) {
    if (res.status === 401) {
      throw new HttpRequestError(
        res.status,
        path,
        'This ZenNotes server requires you to sign in with its auth token.'
      )
    }
    const text = await res.text().catch(() => '')
    throw new HttpRequestError(
      res.status,
      path,
      `HTTP ${res.status} ${res.statusText} for ${path}${text ? `: ${text}` : ''}`
    )
  }
  if (res.status === 204) return undefined as unknown as T
  const ctype = res.headers.get('Content-Type') || ''
  if (ctype.includes('application/json')) {
    return (await res.json()) as T
  }
  return (await res.text()) as unknown as T
}

function notImplemented(name: string): never {
  throw new Error(`zen.${name} is not available in the web build`)
}

// --------------------------------------------------------------------
// Platform / system
// --------------------------------------------------------------------

let cachedPlatform: NodeJS.Platform | null = null
async function platform(): Promise<NodeJS.Platform> {
  if (cachedPlatform) return cachedPlatform
  const ua = navigator.userAgent.toLowerCase()
  let guess: NodeJS.Platform = 'linux'
  if (ua.includes('mac') || ua.includes('iphone') || ua.includes('ipad')) guess = 'darwin'
  else if (ua.includes('win')) guess = 'win32'
  try {
    const resp = await jsonRequest<{ platform: NodeJS.Platform }>('/platform')
    cachedPlatform = resp.platform || guess
  } catch {
    cachedPlatform = guess
  }
  return cachedPlatform
}

function platformSync(): NodeJS.Platform {
  if (cachedPlatform) return cachedPlatform
  const ua = navigator.userAgent.toLowerCase()
  if (ua.includes('mac') || ua.includes('iphone') || ua.includes('ipad')) return 'darwin'
  if (ua.includes('win')) return 'win32'
  return 'linux'
}

// --------------------------------------------------------------------
// Vault info
// --------------------------------------------------------------------

async function getCurrentVault(): Promise<VaultInfo | null> {
  try {
    return await jsonRequest<VaultInfo | null>('/vault')
  } catch {
    return null
  }
}

function getServerCapabilities(): Promise<ServerCapabilities | null> {
  return jsonRequest<ServerCapabilities>('/capabilities').catch((err) => {
    if (err instanceof HttpRequestError && err.status === 404) return null
    throw err
  })
}

function getServerSession(): Promise<ServerSessionStatus> {
  return jsonRequest<ServerSessionStatus>('/session')
}

function loginServerSession(token: string): Promise<ServerSessionStatus> {
  return jsonRequest<ServerSessionStatus>('/session/login', {
    method: 'POST',
    body: { token }
  })
}

function logoutServerSession(): Promise<ServerSessionStatus> {
  return jsonRequest<ServerSessionStatus>('/session/logout', {
    method: 'POST'
  })
}

function getRemoteWorkspaceInfo(): Promise<RemoteWorkspaceInfo | null> {
  return Promise.resolve(null)
}

function connectRemoteWorkspace(): Promise<{ vault: VaultInfo | null; capabilities: ServerCapabilities }> {
  return Promise.reject(new Error('Remote workspace connection is only available in the desktop build'))
}

function disconnectRemoteWorkspace(): Promise<VaultInfo | null> {
  return Promise.reject(new Error('Remote workspace switching is only available in the desktop build'))
}

function listRemoteWorkspaceProfiles(): Promise<RemoteWorkspaceProfile[]> {
  return Promise.resolve([])
}

function saveRemoteWorkspaceProfile(): Promise<RemoteWorkspaceProfile> {
  return Promise.reject(new Error('Saved remote workspaces are only available in the desktop build'))
}

function deleteRemoteWorkspaceProfile(): Promise<void> {
  return Promise.reject(new Error('Saved remote workspaces are only available in the desktop build'))
}

function connectRemoteWorkspaceProfile(): Promise<{ vault: VaultInfo | null; capabilities: ServerCapabilities }> {
  return Promise.reject(new Error('Saved remote workspaces are only available in the desktop build'))
}

function getVaultSettings(): Promise<VaultSettings> {
  return jsonRequest<VaultSettings>('/vault/settings')
}

function setVaultSettings(next: VaultSettings): Promise<VaultSettings> {
  return jsonRequest<VaultSettings>('/vault/settings', {
    method: 'POST',
    body: next as unknown as Record<string, unknown>
  })
}

async function pickVault(): Promise<VaultInfo | null> {
  const current = await getCurrentVault()
  const suggested = current?.root ?? ''
  const nextPath = window.prompt(
    'Enter the path to the vault directory on the server running ZenNotes.',
    suggested
  )
  if (!nextPath || !nextPath.trim()) return null
  try {
    return await jsonRequest<VaultInfo>('/vault/select', {
      method: 'POST',
      body: { path: nextPath.trim() }
    })
  } catch (err) {
    window.alert((err as Error).message)
    return null
  }
}

function selectVaultPath(path: string): Promise<VaultInfo> {
  return jsonRequest<VaultInfo>('/vault/select', {
    method: 'POST',
    body: { path }
  }).catch((err) => wrapRouteUpgradeError('/vault/select', err))
}

function browseServerDirectories(path = ''): Promise<DirectoryBrowseResult> {
  const query = path ? `?path=${encodeURIComponent(path)}` : ''
  return jsonRequest<DirectoryBrowseResult>(`/fs/browse${query}`).catch((err) =>
    wrapRouteUpgradeError('/fs/browse', err)
  )
}

// --------------------------------------------------------------------
// Note listing / reading / writing
// --------------------------------------------------------------------

function listNotes(): Promise<NoteMeta[]> {
  return jsonRequest<NoteMeta[]>('/notes')
}

function listFolders(): Promise<FolderEntry[]> {
  return jsonRequest<FolderEntry[]>('/folders')
}

function listAssets(): Promise<AssetMeta[]> {
  return jsonRequest<AssetMeta[]>('/assets')
}

function hasAssetsDir(): Promise<boolean> {
  return jsonRequest<{ exists: boolean }>('/assets/exists').then(r => r.exists)
}

function readNote(relPath: string): Promise<NoteContent> {
  return jsonRequest<NoteContent>(`/notes/read?path=${encodeURIComponent(relPath)}`)
}

function writeNote(relPath: string, body: string): Promise<NoteMeta> {
  return jsonRequest<NoteMeta>('/notes/write', {
    method: 'POST',
    body: { path: relPath, body }
  })
}

function createNote(
  folder: NoteFolder,
  title?: string,
  subpath?: string
): Promise<NoteMeta> {
  return jsonRequest<NoteMeta>('/notes/create', {
    method: 'POST',
    body: { folder, title, subpath }
  })
}

function renameNote(relPath: string, nextTitle: string): Promise<NoteMeta> {
  return jsonRequest<NoteMeta>('/notes/rename', {
    method: 'POST',
    body: { path: relPath, title: nextTitle }
  })
}

function deleteNote(relPath: string): Promise<void> {
  return jsonRequest<void>('/notes/delete', {
    method: 'POST',
    body: { path: relPath }
  })
}

function moveToTrash(relPath: string): Promise<NoteMeta> {
  return jsonRequest<NoteMeta>('/notes/trash', {
    method: 'POST',
    body: { path: relPath }
  })
}

function restoreFromTrash(relPath: string): Promise<NoteMeta> {
  return jsonRequest<NoteMeta>('/notes/restore', {
    method: 'POST',
    body: { path: relPath }
  })
}

function emptyTrash(): Promise<void> {
  return jsonRequest<void>('/notes/empty-trash', { method: 'POST' })
}

function archiveNote(relPath: string): Promise<NoteMeta> {
  return jsonRequest<NoteMeta>('/notes/archive', {
    method: 'POST',
    body: { path: relPath }
  })
}

function unarchiveNote(relPath: string): Promise<NoteMeta> {
  return jsonRequest<NoteMeta>('/notes/unarchive', {
    method: 'POST',
    body: { path: relPath }
  })
}

function duplicateNote(relPath: string): Promise<NoteMeta> {
  return jsonRequest<NoteMeta>('/notes/duplicate', {
    method: 'POST',
    body: { path: relPath }
  })
}

function moveNote(
  relPath: string,
  targetFolder: NoteFolder,
  targetSubpath: string
): Promise<NoteMeta> {
  return jsonRequest<NoteMeta>('/notes/move', {
    method: 'POST',
    body: { path: relPath, targetFolder, targetSubpath }
  })
}

async function revealNote(_relPath: string): Promise<void> {
  // No OS file manager on the web.
}

async function revealFolder(_folder: NoteFolder, _subpath: string): Promise<void> {
  // No OS file manager on the web.
}

async function revealAssetsDir(): Promise<void> {
  // No OS file manager on the web.
}

// --------------------------------------------------------------------
// Folders
// --------------------------------------------------------------------

function createFolder(folder: NoteFolder, subpath: string): Promise<void> {
  return jsonRequest<void>('/folders/create', {
    method: 'POST',
    body: { folder, subpath }
  })
}

function renameFolder(
  folder: NoteFolder,
  oldSubpath: string,
  newSubpath: string
): Promise<string> {
  return jsonRequest<{ subpath: string }>('/folders/rename', {
    method: 'POST',
    body: { folder, oldSubpath, newSubpath }
  }).then(r => r.subpath)
}

function deleteFolder(folder: NoteFolder, subpath: string): Promise<void> {
  return jsonRequest<void>('/folders/delete', {
    method: 'POST',
    body: { folder, subpath }
  })
}

function duplicateFolder(folder: NoteFolder, subpath: string): Promise<string> {
  return jsonRequest<{ subpath: string }>('/folders/duplicate', {
    method: 'POST',
    body: { folder, subpath }
  }).then(r => r.subpath)
}

// --------------------------------------------------------------------
// Search
// --------------------------------------------------------------------

function getVaultTextSearchCapabilities(
  _paths: VaultTextSearchToolPaths = {}
): Promise<VaultTextSearchCapabilities> {
  return jsonRequest<VaultTextSearchCapabilities>('/search/capabilities')
}

function searchVaultText(
  query: string,
  backend: VaultTextSearchBackendPreference = 'auto',
  _paths: VaultTextSearchToolPaths = {}
): Promise<VaultTextSearchMatch[]> {
  const qs = new URLSearchParams({ q: query, backend })
  return jsonRequest<VaultTextSearchMatch[]>(`/search/text?${qs.toString()}`)
}

// --------------------------------------------------------------------
// Tasks
// --------------------------------------------------------------------

function scanTasks(): Promise<VaultTask[]> {
  return jsonRequest<VaultTask[]>('/tasks')
}

function scanTasksForPath(relPath: string): Promise<VaultTask[]> {
  return jsonRequest<VaultTask[]>(`/tasks/for?path=${encodeURIComponent(relPath)}`)
}

// --------------------------------------------------------------------
// Demo tour
// --------------------------------------------------------------------

function generateDemoTour(): Promise<VaultDemoTourResult> {
  return jsonRequest<VaultDemoTourResult>('/demo/generate', { method: 'POST' })
}

function removeDemoTour(): Promise<VaultDemoTourResult> {
  return jsonRequest<VaultDemoTourResult>('/demo/remove', { method: 'POST' })
}

// --------------------------------------------------------------------
// Assets (uploads, zen-asset URL resolution)
// --------------------------------------------------------------------

async function importFilesToNote(
  notePath: string,
  sourcePaths: string[]
): Promise<ImportedAsset[]> {
  // In the browser "sourcePaths" carries File[] smuggled through
  // getPathForFile (which returns the File object itself in the web
  // build — see below). Upload each as multipart.
  const results: ImportedAsset[] = []
  for (const raw of sourcePaths) {
    const file = webDroppedFiles.get(raw)
    if (!file) continue
    const form = new FormData()
    form.append('file', file, file.name)
    form.append('notePath', notePath)
    const res = await fetch(`${API_BASE}/assets/upload`, {
      method: 'POST',
      body: form,
      credentials: 'same-origin'
    })
    if (!res.ok) throw new Error(`upload failed: ${res.status}`)
    const asset = (await res.json()) as ImportedAsset
    results.push(asset)
    webDroppedFiles.delete(raw)
  }
  return results
}

// Bucket for File objects "pretending" to be filesystem paths. The
// renderer expects `getPathForFile` to return a string it can later
// pass to `importFilesToNote`. On the web, we mint a synthetic token
// here and look it up at import time.
const webDroppedFiles = new Map<string, File>()

function getPathForFile(file: File): string | null {
  if (!file) return null
  const token = `web-drop://${crypto.randomUUID()}/${encodeURIComponent(file.name)}`
  webDroppedFiles.set(token, file)
  return token
}

function resolveLocalAssetUrl(
  _vaultRoot: string,
  notePath: string,
  href: string
): string | null {
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

  const noteDir = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : ''
  const decodedHref = decodeHrefPath(trimmed)
  let target: string
  if (decodedHref.startsWith('/')) {
    target = decodedHref.replace(/^\/+/, '')
  } else if (noteDir) {
    target = posixJoin(noteDir, decodedHref)
  } else {
    target = decodedHref
  }
  target = posixNormalize(target)
  if (target.startsWith('../') || target === '..') return null
  return `${API_BASE}/assets/raw?path=${encodeURIComponent(target)}`
}

function resolveVaultAssetUrl(_vaultRoot: string, assetPath: string): string | null {
  const trimmed = assetPath.trim()
  if (!trimmed) return null
  const normalized = posixNormalize(trimmed.replace(/^\/+/, ''))
  if (normalized.startsWith('../') || normalized === '..') return null
  return `${API_BASE}/assets/raw?path=${encodeURIComponent(normalized)}`
}

function posixJoin(a: string, b: string): string {
  if (!a) return b
  if (!b) return a
  if (a.endsWith('/')) return `${a}${b}`
  return `${a}/${b}`
}

function posixNormalize(input: string): string {
  const parts = input.split('/')
  const out: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (out.length === 0) return '..'
      out.pop()
    } else {
      out.push(part)
    }
  }
  return out.join('/')
}

// --------------------------------------------------------------------
// WebSocket watcher (vault change events)
// --------------------------------------------------------------------

type VaultChangeListener = (ev: VaultChangeEvent) => void
const vaultChangeListeners = new Set<VaultChangeListener>()
let watchSocket: WebSocket | null = null
let watchReconnectTimer: number | null = null

function ensureWatchSocket(): void {
  if (watchSocket && watchSocket.readyState <= 1) return
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = `${proto}//${window.location.host}${API_BASE}/watch`
  const ws = new WebSocket(url)
  watchSocket = ws
  ws.addEventListener('message', e => {
    try {
      const ev = JSON.parse(String(e.data)) as VaultChangeEvent
      for (const cb of vaultChangeListeners) cb(ev)
    } catch {
      // ignore malformed frames
    }
  })
  ws.addEventListener('close', () => {
    watchSocket = null
    if (vaultChangeListeners.size > 0 && watchReconnectTimer === null) {
      watchReconnectTimer = window.setTimeout(() => {
        watchReconnectTimer = null
        ensureWatchSocket()
      }, 1500)
    }
  })
  ws.addEventListener('error', () => {
    ws.close()
  })
}

function onVaultChange(cb: VaultChangeListener): () => void {
  vaultChangeListeners.add(cb)
  ensureWatchSocket()
  return () => {
    vaultChangeListeners.delete(cb)
    if (vaultChangeListeners.size === 0 && watchSocket) {
      watchSocket.close()
      watchSocket = null
    }
  }
}

// --------------------------------------------------------------------
// Settings / updater / window (stubs for web)
// --------------------------------------------------------------------

const settingsListeners = new Set<() => void>()
function onOpenSettings(cb: () => void): () => void {
  settingsListeners.add(cb)
  return () => settingsListeners.delete(cb)
}

async function getAppIconDataUrl(): Promise<string | null> {
  return null
}

async function listSystemFonts(): Promise<string[]> {
  // Baseline cross-platform fonts. The desktop build enumerates via
  // node-font-list; the browser can't. This gives the settings
  // font-picker a usable default set.
  return [
    'Arial',
    'Avenir',
    'Charter',
    'Georgia',
    'Helvetica',
    'Helvetica Neue',
    'Iowan Old Style',
    'JetBrains Mono',
    'Menlo',
    'Monaco',
    'SF Mono',
    'SF Pro Text',
    'Segoe UI',
    'Source Serif Pro',
    'Times New Roman',
    'Verdana'
  ]
}

async function zoomInApp(): Promise<number> {
  return 1
}
async function zoomOutApp(): Promise<number> {
  return 1
}
async function resetAppZoom(): Promise<number> {
  return 1
}

const unsupportedUpdateState: AppUpdateState = {
  phase: 'unsupported',
  currentVersion: '0.0.0-web',
  availableVersion: null,
  releaseName: null,
  releaseDate: null,
  releaseNotes: null,
  progressPercent: null,
  transferredBytes: null,
  totalBytes: null,
  bytesPerSecond: null,
  message: 'The web build updates automatically when you reload.'
}

async function getAppUpdateState(): Promise<AppUpdateState> {
  return unsupportedUpdateState
}
async function checkForAppUpdates(): Promise<AppUpdateState> {
  return unsupportedUpdateState
}
async function checkForAppUpdatesWithUi(): Promise<void> {
  window.location.reload()
}
async function downloadAppUpdate(): Promise<AppUpdateState> {
  return unsupportedUpdateState
}
async function installAppUpdate(): Promise<void> {
  window.location.reload()
}

function onAppUpdateState(_cb: (state: AppUpdateState) => void): () => void {
  return () => {}
}

function windowMinimize(): void {}
function windowToggleMaximize(): void {}
function windowClose(): void {}
async function openNoteWindow(relPath: string): Promise<void> {
  const url = `${window.location.origin}/?note=${encodeURIComponent(relPath)}`
  window.open(url, '_blank', 'noopener')
}

async function renderTikz(_source: string): Promise<TikzRenderResponse> {
  return { ok: false, error: 'TikZ rendering is not available in the web build yet.' }
}

// --------------------------------------------------------------------
// MCP (web build cannot install into local clients — return disabled)
// --------------------------------------------------------------------

async function mcpGetRuntime(): Promise<McpServerRuntime> {
  return {
    nodePath: null,
    scriptPath: null,
    available: false,
    reason: 'MCP client installation is only available in the desktop build.'
  } as unknown as McpServerRuntime
}

async function mcpGetStatuses(): Promise<McpClientStatus[]> {
  return []
}

async function mcpInstall(_id: McpClientId): Promise<McpClientStatus> {
  return notImplemented('mcpInstall')
}

async function mcpUninstall(_id: McpClientId): Promise<McpClientStatus> {
  return notImplemented('mcpUninstall')
}

async function mcpGetInstructions(): Promise<McpInstructionsPayload> {
  return { custom: null, effective: '', defaults: '' } as unknown as McpInstructionsPayload
}

async function mcpSetInstructions(
  _next: string | null
): Promise<McpInstructionsPayload> {
  return notImplemented('mcpSetInstructions')
}

// --------------------------------------------------------------------
// Clipboard (web build uses navigator.clipboard)
// --------------------------------------------------------------------

function clipboardWriteText(text: string): void {
  try {
    void navigator.clipboard?.writeText(text)
  } catch {
    // ignore
  }
}

function clipboardReadText(): string {
  // navigator.clipboard.readText is async — the desktop build has a
  // synchronous Electron clipboard. Return empty string; callers that
  // need the value should fall back to async paste events.
  return ''
}

// --------------------------------------------------------------------
// Assemble the `zen` API object
// --------------------------------------------------------------------

export const httpBridge: ZenBridge = {
  getCapabilities: (): ZenCapabilities => WEB_CAPABILITIES,
  getAppInfo: (): ZenAppInfo => WEB_APP_INFO,
  platform,
  platformSync,
  listSystemFonts,
  getAppIconDataUrl,
  zoomInApp,
  zoomOutApp,
  resetAppZoom,
  getAppUpdateState,
  checkForAppUpdates,
  checkForAppUpdatesWithUi,
  downloadAppUpdate,
  installAppUpdate,
  getServerCapabilities,
  getServerSession,
  loginServerSession,
  logoutServerSession,
  getRemoteWorkspaceInfo,
  connectRemoteWorkspace,
  disconnectRemoteWorkspace,
  listRemoteWorkspaceProfiles,
  saveRemoteWorkspaceProfile: (_input: RemoteWorkspaceProfileInput) => saveRemoteWorkspaceProfile(),
  deleteRemoteWorkspaceProfile: (_id: string) => deleteRemoteWorkspaceProfile(),
  connectRemoteWorkspaceProfile: (_id: string) => connectRemoteWorkspaceProfile(),

  getCurrentVault,
  pickVault,
  selectVaultPath,
  browseServerDirectories,
  getVaultSettings,
  setVaultSettings,

  listNotes,
  listFolders,
  listAssets,
  hasAssetsDir,
  generateDemoTour,
  removeDemoTour,
  getVaultTextSearchCapabilities,
  searchVaultText,
  readNote,
  scanTasks,
  scanTasksForPath,
  writeNote,
  createNote,
  renameNote,
  deleteNote,
  moveToTrash,
  restoreFromTrash,
  emptyTrash,
  archiveNote,
  unarchiveNote,
  duplicateNote,
  revealNote,
  moveNote,
  importFilesToNote,
  createFolder,
  renameFolder,
  deleteFolder,
  duplicateFolder,
  revealFolder,
  revealAssetsDir,
  getPathForFile,
  resolveLocalAssetUrl,
  resolveVaultAssetUrl,

  onVaultChange,
  onOpenSettings,
  onAppUpdateState,

  windowMinimize,
  windowToggleMaximize,
  windowClose,
  openNoteWindow,
  renderTikz,

  mcpGetRuntime,
  mcpGetStatuses,
  mcpInstall,
  mcpUninstall,
  mcpGetInstructions,
  mcpSetInstructions,
  clipboardWriteText,
  clipboardReadText
}

export function installBridge(): void {
  if (typeof window === 'undefined') return
  installZenBridge(httpBridge)
}
