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
  CustomTemplateFile,
  WriteTemplateInput
} from '@zennotes/bridge-contract/templates'
import type {
  ApplyWorkflowInput,
  WorkflowFile,
  WorkflowRunReceipt,
  WorkflowRunSummary,
  WorkflowUndoResult,
  WriteWorkflowInput
} from '@zennotes/bridge-contract/workflows'
import type {
  AppUpdateState,
  AssetMeta,
  CliInstallStatus,
  DeletedAsset,
  DirectoryBrowseResult,
  ExternalFileContent,
  FolderEntry,
  ImportedAsset,
  LinkMetadata,
  LocalVaultEntry,
  MoveExternalFileResult,
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
import { createDatabaseOps, type DatabaseVaultLayout } from '@shared/database-ops'
import { isUnknownRouteResponse, parseServerErrorBody } from '@shared/server-error-shape'
import { pastedImageFilename } from '@shared/pasted-image'
import { createAbsenceAwareReader } from '@shared/remote-absence'
import type {
  McpClientId,
  McpClientStatus,
  McpInstructionsPayload,
  McpServerRuntime
} from '@shared/mcp-clients'
import type {
  CustomCodeLanguageInstallInput,
  CustomCodeLanguageUpdateInput
} from '@shared/custom-code-languages'

const WEB_CAPABILITIES: ZenCapabilities = {
  supportsUpdater: false,
  supportsNativeMenus: false,
  supportsFloatingWindows: false,
  supportsLocalFilesystemPickers: false,
  supportsRemoteWorkspace: false,
  supportsCloudSync: false,
  supportsCliInstall: false,
  supportsCustomTemplates: false,
  supportsCustomCodeLanguages: false
}

const WEB_APP_INFO: ZenAppInfo = {
  name: appPackage.name,
  productName: 'ZenNotes',
  version: appPackage.version,
  description: appPackage.description,
  homepage: appPackage.homepage,
  runtime: 'web'
}

// Base path under which the server is mounted (e.g. "/zennotes" when
// running behind a reverse proxy at example.com/zennotes/). The Go
// server injects a `<meta name="zn-base-path" content="...">` tag into
// the HTML shell when a non-empty `ZENNOTES_BASE_PATH` is configured;
// root deployments leave the tag out.
function resolveBasePath(): string {
  const meta =
    typeof document !== 'undefined'
      ? document.querySelector('meta[name="zn-base-path"]')
      : null
  const raw = meta?.getAttribute('content') ?? ''
  let trimmed = raw.trim()
  if (!trimmed || trimmed === '/') return ''
  if (!trimmed.startsWith('/')) trimmed = '/' + trimmed
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1)
  return trimmed
}

const BASE_PATH = resolveBasePath()
const API_BASE = `${BASE_PATH}/api`

// Deployment base path (e.g. "" at the root, "/zennotes" behind a proxy), so
// entrypoint code can build same-origin asset URLs that survive subpath mounts.
export const webBasePath = BASE_PATH

type JsonBody = Record<string, unknown> | unknown[]
type JsonRequestInit = Omit<RequestInit, 'body'> & { body?: JsonBody }

class HttpRequestError extends Error {
  status: number
  path: string
  /** The response body verbatim, so callers can read the server's structured
   *  error shape (see `parseServerErrorBody`) without re-reading the stream. */
  body: string

  constructor(status: number, path: string, message: string, body = '') {
    super(message)
    this.name = 'HttpRequestError'
    this.status = status
    this.path = path
    this.body = body
  }
}

function wrapRouteUpgradeError(path: string, err: unknown): never {
  // A 404 that carries the server's structured body came from the route
  // itself: the directory is gone, or the path is outside the allowed browse
  // roots. Only a BARE 404 (the router's own, on a server that has no such
  // route) means the server predates the vault picker, and claiming otherwise
  // replaced every real error on the first-run screen with a bogus "upgrade
  // your server".
  if (
    err instanceof HttpRequestError &&
    isUnknownRouteResponse(err.status, err.body) &&
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
      `HTTP ${res.status} ${res.statusText} for ${path}${text ? `: ${parseServerErrorBody(text)?.message || text}` : ''}`,
      text
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

/** Last capabilities this page saw, so the absence reader can consult them
 *  without a request of its own. Null until the first successful fetch. */
let lastServerCapabilities: ServerCapabilities | null = null

function getServerCapabilities(): Promise<ServerCapabilities | null> {
  return jsonRequest<ServerCapabilities>('/capabilities')
    .then((caps) => {
      lastServerCapabilities = caps
      return caps
    })
    .catch((err) => {
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

// The web app talks to exactly one server (its own); "retry the configured
// workspace" is simply asking it again for the current vault.
function retryWorkspaceBoot(): Promise<VaultInfo | null> {
  return getCurrentVault()
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

// Workspace state lives in the desktop vault's .zennotes/ on disk (#292); the
// web build has no local vault filesystem, so these are no-ops.
function readWorkspaceState(): Promise<string | null> {
  return Promise.resolve(null)
}

function writeWorkspaceState(_json: string): Promise<void> {
  return Promise.resolve()
}

function rootContentHiddenByInboxMode(): Promise<boolean> {
  // Desktop-local concern; the web/server build never hides root content this way.
  return Promise.resolve(false)
}

function listLocalVaults(): Promise<LocalVaultEntry[]> {
  return Promise.resolve([])
}

function openLocalVault(_root: string): Promise<VaultInfo | null> {
  return Promise.resolve(null)
}

function closeVault(): Promise<VaultInfo | null> {
  return Promise.resolve(null)
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

function readNoteComments(relPath: string): Promise<NoteComment[]> {
  return jsonRequest<NoteComment[]>(`/comments/read?path=${encodeURIComponent(relPath)}`)
}

function writeNoteComments(
  relPath: string,
  comments: NoteCommentInput[]
): Promise<NoteComment[]> {
  return jsonRequest<NoteComment[]>('/comments/write', {
    method: 'POST',
    body: { path: relPath, comments }
  })
}

function writeNote(relPath: string, body: string): Promise<NoteMeta> {
  return jsonRequest<NoteMeta>('/notes/write', {
    method: 'POST',
    body: { path: relPath, body }
  })
}

async function appendToNote(
  relPath: string,
  body: string,
  position: 'start' | 'end'
): Promise<NoteMeta> {
  const current = await readNote(relPath)
  const trimmed = body.replace(/\s+$/u, '')
  if (!trimmed) return current
  const next =
    position === 'end'
      ? `${current.body}${current.body.endsWith('\n') ? '' : '\n'}\n${trimmed}\n`
      : `${trimmed}\n\n${current.body}`
  return await writeNote(relPath, next)
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

function createExcalidraw(
  folder: NoteFolder,
  subpath?: string,
  title?: string
): Promise<NoteMeta> {
  return jsonRequest<NoteMeta>('/excalidraw/create', {
    method: 'POST',
    body: { folder, subpath, title }
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

// Word export renders in the desktop main process (it reads local image files
// for embedding); the web app has neither, so the honest answer is a message.
function exportNoteDocx(_relPath: string): Promise<string | null> {
  return Promise.reject(new Error('Word export is available in the desktop app.'))
}

async function exportNotePdf(_relPath: string): Promise<string | null> {
  const url = new URL(window.location.href)
  url.search = ''
  url.hash = ''
  url.searchParams.set('exportNote', _relPath)
  const exportWindow = window.open(url.toString(), 'zennotes-pdf-export')
  if (!exportWindow) {
    throw new Error(
      'ZenNotes could not open the PDF export window. Allow pop-ups for this site and try again.'
    )
  }
  exportWindow.focus()
  return null
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

async function revealNoteTarget(_relPath: string): Promise<void> {
  // No OS file manager on the web.
}

async function revealFilePath(_absPath: string): Promise<void> {
  // No OS file manager on the web.
}

async function openExternalFile(_href: string): Promise<{ ok: boolean; error?: string }> {
  // The web app has no access to the machine's filesystem or default apps.
  return { ok: false, error: 'desktop-only' }
}

async function openAssetExternally(_relPath: string): Promise<{ ok: boolean; error?: string }> {
  // Same story as openExternalFile: no OS opener in a browser.
  return { ok: false, error: 'desktop-only' }
}

async function fetchLinkMetadata(url: string): Promise<LinkMetadata> {
  // The browser can't fetch arbitrary cross-origin pages (CORS); a bookmark on
  // web falls back to a bare link card until a server-side proxy is added.
  return { url, ok: false }
}

async function revealFolder(_folder: NoteFolder, _subpath: string): Promise<void> {
  // No OS file manager on the web.
}

async function revealFolderTarget(_folder: NoteFolder, _subpath: string): Promise<void> {
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
// Databases — the shared composition (@shared/database-ops) bound to this
// bridge's generic endpoints: reads/writes go through /notes/read|write
// (which accept any vault path, including `.base/` internals) and the
// `.base` folder is created/renamed via the folder endpoints. The desktop
// app binds the same composition to its remote-workspace client (#499),
// so the on-disk format is identical everywhere by construction.
// --------------------------------------------------------------------

/** Read a vault file's text, or null when the server says it is ABSENT.
 *
 *  404 always means absent. Any other status means absent only if this
 *  server cannot answer 404 for a missing file, which the reader settles by
 *  asking it once (see remote-absence.ts). That keeps a 2.20+ server's 500
 *  surfacing as an error, because `openDatabase` reads an absent sidecar as
 *  "bare CSV, adopt it" and would write an inferred schema over whatever was
 *  there, while leaving a pre-2.20 server (500 for both) usable at all. */
const readFileTextOrNull = createAbsenceAwareReader({
  read: async (relPath) => (await readNote(relPath)).body,
  statusOf: (err) => (err instanceof HttpRequestError ? err.status : null),
  serverReportsMissingAsNotFound: () =>
    lastServerCapabilities?.reportsMissingAsNotFound === true
})

/** Errors propagate: answering "defaults" for an unreachable server sends
 *  every database path composition to a literal `inbox/`, writing sidecars
 *  where nothing will ever look for them. */
async function vaultLayout(): Promise<DatabaseVaultLayout> {
  const settings = await getVaultSettings()
  return {
    primaryNotesAtRoot: settings.primaryNotesLocation === 'root',
    systemFolderPaths: settings.systemFolderPaths
  }
}

const dbOps = createDatabaseOps({
  readFileTextOrNull,
  writeFile: async (relPath, text) => {
    await writeNote(relPath, text)
  },
  createFolder,
  renameFolder,
  listFolders,
  vaultLayout
})

const {
  openDatabase,
  writeDatabaseRows,
  writeDatabaseSchema,
  createDatabase,
  createRecordPage,
  renameDatabase,
  listDatabases
} = dbOps

// --------------------------------------------------------------------
// Demo tour
// --------------------------------------------------------------------

function generateDemoTour(): Promise<VaultDemoTourResult> {
  return jsonRequest<VaultDemoTourResult>('/demo/generate', { method: 'POST' })
}

function removeDemoTour(): Promise<VaultDemoTourResult> {
  return jsonRequest<VaultDemoTourResult>('/demo/remove', { method: 'POST' })
}

// Workflows are authored as files under `.zennotes/workflows`, which the web
// app cannot reach, so it simply has none. The canvas still renders, it is
// just empty, which is friendlier than an error the user cannot act on.
function listWorkflows(): Promise<WorkflowFile[]> {
  return Promise.resolve([])
}

// Authoring is a different matter from listing: rejecting is the only honest
// answer, because resolving would leave the editor showing a saved workflow
// that exists nowhere.
function writeWorkflow(_input: WriteWorkflowInput): Promise<WorkflowFile> {
  return Promise.reject(new Error('Editing workflows is unavailable on the web'))
}

function deleteWorkflow(_sourcePath: string): Promise<void> {
  return Promise.reject(new Error('Editing workflows is unavailable on the web'))
}

// Applying, undoing and the run history all need the local filesystem: the
// journal that makes a run undoable is a file in the vault, and without it
// there is no honest way to promise an undo. Rejecting is the only answer that
// does not overstate what the web app can do, and it means a run can never land
// somewhere its undo could not reach.
function applyWorkflow(_input: ApplyWorkflowInput): Promise<WorkflowRunReceipt> {
  return Promise.reject(new Error('Running workflows is unavailable on the web'))
}

function undoWorkflowRun(_runId: string): Promise<WorkflowUndoResult> {
  return Promise.reject(new Error('Running workflows is unavailable on the web'))
}

// A read, not a run: a vault the web app cannot run workflows in simply has no
// recorded runs, the same answer `listWorkflows` gives for the files. A future
// history panel then shows an empty list here instead of tripping on a
// rejection where the workflow list quietly showed nothing.
function listWorkflowRuns(): Promise<WorkflowRunSummary[]> {
  return Promise.resolve([])
}

// Nothing can have recorded a run here (see above), so there is never anything
// to delete: zero, not a rejection, for the same reason the list is empty.
function deleteWorkflowRuns(_workflowId: string): Promise<number> {
  return Promise.resolve(0)
}

// Custom templates require local-filesystem CRUD, which the web app does not
// have (supportsCustomTemplates is false). Built-in templates still work since
// they are renderer constants. List is empty; mutations are rejected.
function listTemplates(): Promise<CustomTemplateFile[]> {
  return Promise.resolve([])
}

function readTemplate(_sourcePath: string): Promise<string> {
  return Promise.reject(new Error('Custom templates are unavailable on the web'))
}

function writeTemplate(_input: WriteTemplateInput): Promise<CustomTemplateFile> {
  return Promise.reject(new Error('Custom templates are unavailable on the web'))
}

function deleteTemplate(_sourcePath: string): Promise<void> {
  return Promise.reject(new Error('Custom templates are unavailable on the web'))
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

async function importPastedImage(input: PastedImageInput): Promise<ImportedAsset> {
  const blob = new Blob([input.data as BlobPart], { type: input.mimeType })
  if (blob.size === 0) throw new Error('Clipboard image is empty.')
  // Named by the shared helper the desktop paste uses, so the stem is
  // scrubbed of the characters that break the `![[...]]` wikilink returned
  // below ([ ] # ^ and friends). The server's upload cleaning leaves those
  // in, and a raw "diagram [v2] #3.png" rendered as a broken embed.
  const filename = pastedImageFilename(input, new Date())
  const form = new FormData()
  form.append('file', blob, filename)
  form.append('notePath', '')
  const res = await fetch(`${API_BASE}/assets/upload`, {
    method: 'POST',
    body: form,
    credentials: 'same-origin'
  })
  if (!res.ok) throw new Error(`paste upload failed: ${res.status}`)
  const uploaded = (await res.json()) as ImportedAsset
  // A paste embeds as a wikilink, matching the desktop paste path; the
  // server's markdown is note-relative and meant for drag-drop imports.
  return { name: uploaded.name, path: uploaded.path, markdown: `![[${uploaded.path}]]`, kind: 'image' }
}

function renameAsset(relPath: string, nextName: string): Promise<AssetMeta> {
  return jsonRequest<AssetMeta>('/assets/rename', {
    method: 'POST',
    body: { path: relPath, name: nextName }
  })
}

function moveAsset(relPath: string, targetDir: string): Promise<AssetMeta> {
  return jsonRequest<AssetMeta>('/assets/move', {
    method: 'POST',
    body: { path: relPath, targetDir }
  })
}

function duplicateAsset(relPath: string): Promise<AssetMeta> {
  return jsonRequest<AssetMeta>('/assets/duplicate', {
    method: 'POST',
    body: { path: relPath }
  })
}

function deleteAsset(relPath: string): Promise<DeletedAsset> {
  return jsonRequest<DeletedAsset>('/assets/delete', {
    method: 'POST',
    body: { path: relPath }
  })
}

function restoreDeletedAsset(asset: DeletedAsset): Promise<AssetMeta> {
  return jsonRequest<AssetMeta>('/assets/restore', {
    method: 'POST',
    body: { ...asset }
  })
}

function listDeletedAssets(): Promise<DeletedAsset[]> {
  return jsonRequest<DeletedAsset[]>('/assets/deleted')
}

async function purgeDeletedAsset(undoToken: string): Promise<void> {
  await jsonRequest<void>('/assets/purge', {
    method: 'POST',
    body: { undoToken }
  })
}

async function emptyDeletedAssets(): Promise<void> {
  await jsonRequest<void>('/assets/empty-deleted', { method: 'POST' })
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

async function readVaultAssetBase64(assetPath: string): Promise<string> {
  const url = resolveVaultAssetUrl('', assetPath)
  if (!url) throw new Error('Asset path is invalid.')
  const response = await fetch(url)
  if (!response.ok) throw new Error('Asset could not be read.')
  const bytes = new Uint8Array(await response.arrayBuffer())
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
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
// A dropped socket means lost events, not just downtime: once the next
// connection opens, tell listeners to re-pull everything rather than
// resuming the stream as if nothing happened.
let watchHadGap = false

function ensureWatchSocket(): void {
  if (watchSocket && watchSocket.readyState <= 1) return
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = `${proto}//${window.location.host}${API_BASE}/watch`
  const ws = new WebSocket(url)
  watchSocket = ws
  ws.addEventListener('open', () => {
    if (!watchHadGap) return
    watchHadGap = false
    const resync: VaultChangeEvent = { kind: 'change', path: '', folder: 'inbox', scope: 'resync' }
    for (const cb of vaultChangeListeners) cb(resync)
  })
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
    if (vaultChangeListeners.size > 0) {
      watchHadGap = true
      if (watchReconnectTimer === null) {
        watchReconnectTimer = window.setTimeout(() => {
          watchReconnectTimer = null
          ensureWatchSocket()
        }, 1500)
      }
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

function onOpenNoteRequested(_cb: (relPath: string) => void): () => void {
  // Deep-link note delivery is desktop-only. The web bridge still
  // exposes the hook so shared app-core startup code can remain runtime
  // agnostic.
  return () => {}
}

function notifyRendererReady(): void {
  // Desktop uses this to flush queued zennotes:// deep-link requests.
  // Browser builds do not register the zennotes:// protocol.
}

function windowMinimize(): void {}
function windowToggleMaximize(): void {}
function windowClose(): void {}
async function openNoteWindow(relPath: string): Promise<void> {
  const url = `${window.location.origin}/?note=${encodeURIComponent(relPath)}`
  window.open(url, '_blank', 'noopener')
}

async function openVaultWindow(_root?: string): Promise<VaultInfo | null> {
  return null
}

async function readExternalFile(): Promise<ExternalFileContent> {
  return notImplemented('readExternalFile')
}

async function writeExternalFile(_body: string): Promise<void> {
  notImplemented('writeExternalFile')
}

async function moveExternalFileToVault(): Promise<MoveExternalFileResult> {
  return notImplemented('moveExternalFileToVault')
}

async function openMarkdownFile(_absPath: string): Promise<boolean> {
  // The web client has no OS filesystem to open standalone markdown files
  // from; drag-and-drop-to-open is a desktop-only capability.
  return false
}

async function openFileDialog(): Promise<boolean> {
  // Native "Open File…" picker is desktop-only (no OS file dialog on web).
  return false
}

async function openFolderTemporary(_absPath: string): Promise<void> {
  // Temporary folder sessions are a desktop-only capability (no OS paths on web).
}

async function toggleQuickCapture(): Promise<void> {
  // Web build can't bind a system-wide shortcut; the quick capture
  // window is desktop-only.
}

async function getQuickCaptureHotkey(): Promise<string> {
  return ''
}

async function setQuickCaptureHotkey(
  _hotkey: string
): Promise<{ ok: boolean; hotkey: string; error?: string }> {
  return {
    ok: false,
    hotkey: '',
    error: 'Quick capture is only available in the desktop build.'
  }
}

async function getQuickCapturePinned(): Promise<boolean> {
  return false
}

async function setQuickCapturePinned(_pinned: boolean): Promise<boolean> {
  // No native always-on-top window in the web build.
  return false
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
// CLI install (desktop-only)
// --------------------------------------------------------------------

const WEB_CLI_STATUS: CliInstallStatus = {
  available: false,
  reason: 'CLI installation is only available in the desktop build.',
  defaultTarget: '',
  requiresSudo: false,
  targetOnPath: false,
  pathHint: null,
  installedAt: null,
  installedByThisApp: false,
  supportedPlatform: false
}

async function cliGetStatus(): Promise<CliInstallStatus> {
  return WEB_CLI_STATUS
}

async function cliInstall(): Promise<CliInstallStatus> {
  return notImplemented('cliInstall')
}

async function cliUninstall(): Promise<CliInstallStatus> {
  return notImplemented('cliUninstall')
}

const WEB_RAYCAST_STATUS: RaycastExtensionStatus = {
  available: false,
  reason: 'Raycast extension installation is only available in the macOS desktop build.',
  supportedPlatform: false,
  installed: false,
  upToDate: false,
  extensionPath: '',
  sourcePath: null,
  raycastInstalled: false,
  nodeAvailable: false,
  npmAvailable: false,
  nodePath: null,
  npmPath: null,
  nodeVersion: null,
  npmVersion: null,
  nodeMeetsMinimum: false,
  npmMeetsMinimum: false,
  installedVersion: null,
  bundledVersion: WEB_APP_INFO.version,
  lastInstalledAt: null
}

async function raycastGetStatus(): Promise<RaycastExtensionStatus> {
  return WEB_RAYCAST_STATUS
}

async function raycastInstall(): Promise<RaycastExtensionStatus> {
  return notImplemented('raycastInstall')
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
  getCloudAccountStatus: async () => ({ state: 'disconnected', account: null }),
  connectCloudAccount: async () => notImplemented('connectCloudAccount'),
  logoutCloudAccount: async () => ({ state: 'disconnected', account: null }),
  onCloudAccountChange: () => () => {},
  getCloudServiceAccount: async () => notImplemented('getCloudServiceAccount'),
  listCloudPublishedNotes: async () => notImplemented('listCloudPublishedNotes'),
  publishCloudNote: async () => notImplemented('publishCloudNote'),
  updateCloudPublishedNote: async () => notImplemented('updateCloudPublishedNote'),
  unpublishCloudNote: async () => notImplemented('unpublishCloudNote'),
  listCloudVaults: async () => notImplemented('listCloudVaults'),
  getCloudVaultLink: async () => null,
  linkCloudVault: async () => notImplemented('linkCloudVault'),
  createAndLinkCloudVault: async () => notImplemented('createAndLinkCloudVault'),
  unlinkCloudVault: async () => notImplemented('unlinkCloudVault'),
  syncCloudVault: async () => notImplemented('syncCloudVault'),
  getCloudSettingsConflict: async () => null,
  resolveCloudSettingsConflict: async () => notImplemented('resolveCloudSettingsConflict'),
  listCloudBackups: async () => notImplemented('listCloudBackups'),
  getCloudBackupSchedule: async () => notImplemented('getCloudBackupSchedule'),
  updateCloudBackupSchedule: async () => notImplemented('updateCloudBackupSchedule'),
  listCloudBackupItems: async () => notImplemented('listCloudBackupItems'),
  createCloudBackup: async () => notImplemented('createCloudBackup'),
  downloadCloudBackup: async () => notImplemented('downloadCloudBackup'),
  deleteCloudBackup: async () => notImplemented('deleteCloudBackup'),
  restoreCloudBackup: async () => notImplemented('restoreCloudBackup'),
  restoreCloudBackupNote: async () => notImplemented('restoreCloudBackupNote'),
  getServerCapabilities,
  getServerSession,
  loginServerSession,
  logoutServerSession,
  getRemoteWorkspaceInfo,
  connectRemoteWorkspace,
  disconnectRemoteWorkspace,
  retryWorkspaceBoot,
  listRemoteWorkspaceProfiles,
  saveRemoteWorkspaceProfile: (_input: RemoteWorkspaceProfileInput) => saveRemoteWorkspaceProfile(),
  deleteRemoteWorkspaceProfile: (_id: string) => deleteRemoteWorkspaceProfile(),
  connectRemoteWorkspaceProfile: (_id: string) => connectRemoteWorkspaceProfile(),

  getCurrentVault,
  listLocalVaults,
  openLocalVault,
  closeVault,
  pickVault,
  selectVaultPath,
  browseServerDirectories,
  getVaultSettings,
  setVaultSettings,
  readWorkspaceState,
  writeWorkspaceState,
  rootContentHiddenByInboxMode,

  listNotes,
  listFolders,
  listAssets,
  hasAssetsDir,
  generateDemoTour,
  removeDemoTour,
  listWorkflows,
  writeWorkflow,
  deleteWorkflow,
  applyWorkflow,
  undoWorkflowRun,
  listWorkflowRuns,
  deleteWorkflowRuns,
  listTemplates,
  readTemplate,
  writeTemplate,
  deleteTemplate,
  getVaultTextSearchCapabilities,
  searchVaultText,
  readNote,
  readNoteComments,
  writeNoteComments,
  scanTasks,
  scanTasksForPath,
  openDatabase,
  writeDatabaseRows,
  writeDatabaseSchema,
  createDatabase,
  renameDatabase,
  createRecordPage,
  listDatabases,
  writeNote,
  appendToNote,
  createNote,
  createExcalidraw,
  renameNote,
  deleteNote,
  moveToTrash,
  restoreFromTrash,
  emptyTrash,
  archiveNote,
  unarchiveNote,
  duplicateNote,
  exportNotePdf,
  exportNoteDocx,
  revealNote,
  openExternalFile,
  openAssetExternally,
  fetchLinkMetadata,
  revealNoteTarget,
  revealFilePath,
  moveNote,
  importFilesToNote,
  importPastedImage,
  readVaultAssetBase64,
  renameAsset,
  moveAsset,
  duplicateAsset,
  deleteAsset,
  restoreDeletedAsset,
  listDeletedAssets,
  purgeDeletedAsset,
  emptyDeletedAssets,
  createFolder,
  renameFolder,
  deleteFolder,
  duplicateFolder,
  revealFolder,
  revealFolderTarget,
  revealAssetsDir,
  getPathForFile,
  resolveLocalAssetUrl,
  resolveVaultAssetUrl,

  onVaultChange,
  onOpenSettings,
  onOpenNoteRequested,
  notifyRendererReady,
  onAppUpdateState,

  windowMinimize,
  windowToggleMaximize,
  windowClose,
  openNoteWindow,
  openVaultWindow,
  readExternalFile,
  writeExternalFile,
  moveExternalFileToVault,
  openMarkdownFile,
  openFileDialog,
  openFolderTemporary,
  toggleQuickCapture,
  getQuickCaptureHotkey,
  setQuickCaptureHotkey,
  getQuickCapturePinned,
  setQuickCapturePinned,
  renderTikz,

  mcpGetRuntime,
  mcpGetStatuses,
  mcpInstall,
  mcpUninstall,
  mcpGetInstructions,
  mcpSetInstructions,
  cliGetStatus,
  cliInstall,
  cliUninstall,
  raycastGetStatus,
  raycastInstall,
  clipboardWriteText,
  clipboardReadText,

  // Plain-text config file is a desktop-only feature (needs ~/.config access).
  // On web, the renderer falls back to localStorage when getConfigSync is null.
  getConfigSync: () => null,
  setConfig: async () => {},
  getConfigPath: async () => null,
  revealConfigFile: async () => {},
  onConfigChange: () => () => {},

  // Custom themes + CSS overrides are desktop-only (they read/write files under
  // ~/.config/zennotes). On web these are no-ops so the shared bridge contract
  // is still satisfied.
  listCustomThemes: async () => [],
  getCustomThemesDir: async () => null,
  revealCustomThemesDir: async () => {},
  deleteCustomTheme: async () => {},
  createCustomTheme: async () => null,
  onCustomThemesChange: () => () => {},
  listCustomCodeLanguages: async () => [],
  installCustomCodeLanguage: async (_input: CustomCodeLanguageInstallInput) => {
    throw new Error('Custom code languages are available in the desktop app.')
  },
  updateCustomCodeLanguage: async (_input: CustomCodeLanguageUpdateInput) => {
    throw new Error('Custom code languages are available in the desktop app.')
  },
  revealCustomCodeLanguagesDir: async () => {},
  deleteCustomCodeLanguage: async () => {},
  onCustomCodeLanguagesChange: () => () => {},
  listOverrides: async () => [],
  revealOverridesDir: async () => {},
  deleteOverride: async () => {},
  onOverridesChange: () => () => {},
  toggleDevTools: async () => {}
}

export function installBridge(): void {
  if (typeof window === 'undefined') return
  installZenBridge(httpBridge)
}
