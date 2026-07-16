import { promises as fs, type Dirent } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import { recordMainPerf } from './perf'
import { resolveCommandViaLoginShell } from './login-shell-path'
import { isEphemeralRoot } from './ephemeral-vaults'
import {
  resolveWikilinkTarget,
  rewriteWikilinksForRename,
  type RenameNoteRef
} from './wikilink-rename'
import {
  DEFAULT_DAILY_NOTE_LOCALE,
  DEFAULT_DAILY_NOTE_TITLE_PATTERN,
  DEFAULT_DAILY_NOTES_DIRECTORY,
  DEFAULT_WEEKLY_NOTE_LOCALE,
  DEFAULT_WEEKLY_NOTE_TITLE_PATTERN,
  DEFAULT_WEEKLY_NOTES_DIRECTORY,
  DEFAULT_MONTHLY_NOTE_LOCALE,
  DEFAULT_MONTHLY_NOTE_TITLE_PATTERN,
  DEFAULT_MONTHLY_NOTES_DIRECTORY,
  AssetMeta,
  DeletedAsset,
  type FolderIconId,
  type FolderColorId,
  type PrimaryNotesLocation,
  type VaultSettings,
  type VaultViewSettings,
  type FileLocationSetting,
  FolderEntry,
  ImportedAsset,
  ImportedAssetKind,
  NoteComment,
  NoteCommentInput,
  NoteContent,
  NoteFolder,
  NoteMeta,
  PastedImageInput,
  LocalVaultEntry,
  VaultDemoTourResult,
  VaultTextSearchBackendPreference,
  VaultTextSearchCapabilities,
  VaultTextSearchBackendResolved,
  VaultTextSearchToolPaths,
  VaultTextSearchMatch,
  VaultInfo
} from '@shared/ipc'
import { DEMO_TOUR_DIR } from '@shared/demo-tour'
import {
  DATABASE_SIDECAR_SUFFIX,
  databaseCsvPathFor,
  databaseSchemaPathFor,
  FORM_DATA_FILE,
  FORM_DIR_SUFFIX,
  FORM_SCHEMA_FILE,
  isDatabaseInternalPath,
  isFormDirName
} from '@shared/databases'
import {
  isExcalidrawPath,
  emptyExcalidrawDocument,
  extractObsidianExcalidrawScene,
  isObsidianExcalidrawPath,
  isObsidianExcalidrawMarkdown
} from '@shared/excalidraw'
import { DEMO_TOUR_ASSETS, DEMO_TOUR_NOTES } from './demo-tour-data'

const CONFIG_FILE = 'zennotes.config.json'
const FOLDERS: NoteFolder[] = ['inbox', 'quick', 'archive', 'trash']
const SYSTEM_FOLDERS = new Set<NoteFolder>(FOLDERS)
// Assets are unified under a top-level `assets/` folder. `attachements`/`_assets`
// are recognized legacy dirs (read + migrated, never the import target). (#185)
const ASSETS_DIR = 'assets'
const PRIMARY_ATTACHMENTS_DIR = 'attachements'
const LEGACY_ATTACHMENTS_DIRS = [PRIMARY_ATTACHMENTS_DIR, '_assets']
const ATTACHMENTS_DIRS = [ASSETS_DIR, ...LEGACY_ATTACHMENTS_DIRS]
const INTERNAL_VAULT_DIR = '.zennotes'
const DELETED_ASSETS_DIR = 'deleted-assets'
// Sidecar metadata written next to each deleted asset so it survives a restart
// and can be listed + restored to its original location from the Trash view.
// A dotfile with an app-specific name so it never collides with an asset file.
const DELETED_ASSET_META = '.zn-deleted.json'
const VAULT_SETTINGS_FILE = 'vault.json'
const NOTE_META_CACHE_FILE = 'note-meta-cache-v1.json'
const NOTE_META_CACHE_VERSION = 2
const NOTE_COMMENTS_DIR = 'comments'
const NOTE_COMMENTS_SUFFIX = '.comments.json'
const RESERVED_ROOT_NAMES = new Set<string>([...FOLDERS, ...ATTACHMENTS_DIRS, INTERNAL_VAULT_DIR])
const HIDDEN_PRIMARY_ROOT_NAMES = new Set<string>([
  'quick',
  'archive',
  'trash',
  ...ATTACHMENTS_DIRS,
  INTERNAL_VAULT_DIR
])
const IMAGE_EXTENSIONS = new Set([
  '.apng',
  '.avif',
  '.gif',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.webp'
])
const PASTED_IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  'image/apng': '.apng',
  'image/avif': '.avif',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/webp': '.webp'
}
const PDF_EXTENSIONS = new Set(['.pdf'])
const AUDIO_EXTENSIONS = new Set(['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.wav'])
const VIDEO_EXTENSIONS = new Set(['.m4v', '.mov', '.mp4', '.ogv', '.webm'])
const execFileAsync = promisify(execFile)
const SEARCHABLE_TEXT_FOLDERS: NoteFolder[] = ['inbox', 'quick', 'archive']
const COMMAND_CHECK_TIMEOUT_MS = 1500
const SEARCH_EXEC_MAX_BUFFER = 64 * 1024 * 1024
const SEARCH_CANDIDATE_CACHE_TTL_MS = 30_000
const NOTE_META_READ_CONCURRENCY = 256
const SEARCH_CANDIDATE_READ_CONCURRENCY = 256
const SEARCH_EXECUTABLE_NAMES = {
  ripgrep: new Set(['rg', 'rg.exe']),
  fzf: new Set(['fzf', 'fzf.exe'])
} as const
const VALID_FOLDER_ICON_IDS = new Set<FolderIconId>([
  'folder',
  'bolt',
  'tray',
  'archive',
  'trash',
  'book',
  'bookmark',
  'calendar',
  'briefcase',
  'tag',
  'document',
  'sparkle',
  'code',
  'user',
  'star',
  'heart',
  'link',
  'lightbulb',
  'flask',
  'graduation',
  'music',
  'image',
  'palette',
  'terminal',
  'wrench',
  'globe',
  'map',
  'chart',
  'home'
])

function isFolderIconId(value: unknown): value is FolderIconId {
  return typeof value === 'string' && VALID_FOLDER_ICON_IDS.has(value as FolderIconId)
}

const VALID_FOLDER_COLOR_IDS = new Set<FolderColorId>([
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'sky',
  'blue',
  'indigo',
  'violet',
  'pink'
])

function isFolderColorId(value: unknown): value is FolderColorId {
  return typeof value === 'string' && VALID_FOLDER_COLOR_IDS.has(value as FolderColorId)
}

function normalizeFolderColors(value: unknown): Record<string, FolderColorId> {
  const out: Record<string, FolderColorId> = {}
  if (value && typeof value === 'object') {
    for (const [key, colorId] of Object.entries(value as Record<string, unknown>)) {
      if (!key || !isFolderColorId(colorId)) continue
      out[key] = colorId
    }
  }
  return out
}

const DEFAULT_VAULT_SETTINGS: VaultSettings = {
  primaryNotesLocation: 'inbox',
  dailyNotes: {
    enabled: false,
    directory: DEFAULT_DAILY_NOTES_DIRECTORY,
    titlePattern: DEFAULT_DAILY_NOTE_TITLE_PATTERN,
    locale: DEFAULT_DAILY_NOTE_LOCALE,
    tasksDueOnNoteDate: true,
    rolloverUnfinishedTasks: false
  },
  weeklyNotes: {
    enabled: false,
    directory: DEFAULT_WEEKLY_NOTES_DIRECTORY,
    titlePattern: DEFAULT_WEEKLY_NOTE_TITLE_PATTERN,
    locale: DEFAULT_WEEKLY_NOTE_LOCALE
  },
  monthlyNotes: {
    enabled: false,
    directory: DEFAULT_MONTHLY_NOTES_DIRECTORY,
    titlePattern: DEFAULT_MONTHLY_NOTE_TITLE_PATTERN,
    locale: DEFAULT_MONTHLY_NOTE_LOCALE
  },
  folderIcons: {},
  folderColors: {},
  favorites: []
}

interface VaultTextSearchCandidate {
  path: string
  title: string
  folder: NoteFolder
  lineNumber: number
  lineText: string
  offset?: number
}

interface ScoredVaultTextSearchCandidate extends VaultTextSearchCandidate {
  score: number
}

let cachedVaultTextSearchCapabilities:
  | { at: number; key: string; value: VaultTextSearchCapabilities }
  | null = null
let cachedVaultTextSearchCandidates:
  | {
      at: number
      key: string
      root: string
      value: VaultTextSearchCandidate[]
    }
  | null = null
const noteMetaCache = new Map<
  string,
  {
    mtimeMs: number
    size: number
    meta: NoteMeta
  }
>()
const loadedPersistedNoteMetaCacheRoots = new Set<string>()
const noteMetaCachePersistTimers = new Map<string, ReturnType<typeof setTimeout>>()

export interface PersistedWindowState {
  x: number
  y: number
  width: number
  height: number
  isMaximized: boolean
}

export interface PersistedRemoteWorkspaceConfig {
  baseUrl: string
  authToken?: string | null
}

export interface PersistedRemoteWorkspaceProfile extends PersistedRemoteWorkspaceConfig {
  id: string
  name: string
  vaultPath: string | null
  lastConnectedAt: number | null
}

export type PersistedLocalVault = LocalVaultEntry

export interface PersistedConfig {
  workspaceMode: 'local' | 'remote'
  vaultRoot: string | null
  localVaults: PersistedLocalVault[]
  remoteWorkspace: PersistedRemoteWorkspaceConfig | null
  remoteWorkspaceProfileId: string | null
  remoteWorkspaceProfiles: PersistedRemoteWorkspaceProfile[]
  windowState: PersistedWindowState | null
  zoomFactor: number
  /** Electron accelerator string for the system-wide quick capture hotkey.
   *  Empty string disables the global shortcut. */
  quickCaptureHotkey: string
  /** When true, the quick-capture window stays pinned on top of all windows
   *  and does not auto-hide when it loses focus. */
  quickCapturePinned: boolean
}

export const DEFAULT_QUICK_CAPTURE_HOTKEY = 'CommandOrControl+Shift+Space'

const DEFAULT_CONFIG: PersistedConfig = {
  workspaceMode: 'local',
  vaultRoot: null,
  localVaults: [],
  remoteWorkspace: null,
  remoteWorkspaceProfileId: null,
  remoteWorkspaceProfiles: [],
  windowState: null,
  zoomFactor: 1,
  quickCaptureHotkey: DEFAULT_QUICK_CAPTURE_HOTKEY,
  quickCapturePinned: false
}

let configWriteQueue = Promise.resolve()

function configPath(): string {
  return path.join(app.getPath('userData'), CONFIG_FILE)
}

function normalizeWindowState(value: unknown): PersistedWindowState | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  const x = candidate['x']
  const y = candidate['y']
  const width = candidate['width']
  const height = candidate['height']
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    return null
  }
  return {
    x,
    y,
    width,
    height,
    isMaximized: Boolean(candidate['isMaximized'])
  }
}

function normalizePersistedConfig(value: unknown): PersistedConfig {
  if (!value || typeof value !== 'object') return { ...DEFAULT_CONFIG }
  const candidate = value as Partial<PersistedConfig>
  const zoomFactor =
    typeof candidate.zoomFactor === 'number' && Number.isFinite(candidate.zoomFactor)
      ? Math.min(3, Math.max(0.5, Math.round(candidate.zoomFactor * 100) / 100))
      : DEFAULT_CONFIG.zoomFactor
  const normalizeProfile = (candidate: unknown): PersistedRemoteWorkspaceProfile | null => {
    if (!candidate || typeof candidate !== 'object') return null
    const value = candidate as Record<string, unknown>
    const baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl.trim() : ''
    const name = typeof value.name === 'string' ? value.name.trim() : ''
    if (!baseUrl || !name) return null
    return {
      id: typeof value.id === 'string' && value.id.trim() ? value.id : randomUUID(),
      name,
      baseUrl,
      authToken: typeof value.authToken === 'string' ? value.authToken : null,
      vaultPath: typeof value.vaultPath === 'string' && value.vaultPath.trim() ? value.vaultPath : null,
      lastConnectedAt:
        typeof value.lastConnectedAt === 'number' && Number.isFinite(value.lastConnectedAt)
          ? value.lastConnectedAt
          : null
    }
  }
  const normalizeLocalVault = (candidate: unknown): PersistedLocalVault | null => {
    if (!candidate || typeof candidate !== 'object') return null
    const value = candidate as Record<string, unknown>
    const rawRoot = typeof value.root === 'string' ? value.root.trim() : ''
    if (!rawRoot) return null
    const root = path.resolve(rawRoot)
    const name =
      typeof value.name === 'string' && value.name.trim()
        ? value.name.trim()
        : path.basename(root)
    const lastOpenedAt =
      typeof value.lastOpenedAt === 'number' && Number.isFinite(value.lastOpenedAt)
        ? value.lastOpenedAt
        : 0
    return { root, name, lastOpenedAt }
  }
  const legacyRemoteWorkspace =
    candidate.remoteWorkspace &&
    typeof candidate.remoteWorkspace === 'object' &&
    typeof candidate.remoteWorkspace.baseUrl === 'string'
      ? {
          baseUrl: candidate.remoteWorkspace.baseUrl,
          authToken:
            typeof candidate.remoteWorkspace.authToken === 'string'
              ? candidate.remoteWorkspace.authToken
              : null
        }
      : null
  const remoteWorkspaceProfiles = Array.isArray(candidate.remoteWorkspaceProfiles)
    ? candidate.remoteWorkspaceProfiles
        .map((entry) => normalizeProfile(entry))
        .filter((entry): entry is PersistedRemoteWorkspaceProfile => !!entry)
    : []
  if (legacyRemoteWorkspace && !remoteWorkspaceProfiles.some((entry) => entry.baseUrl === legacyRemoteWorkspace.baseUrl)) {
    remoteWorkspaceProfiles.unshift({
      id: randomUUID(),
      name: 'ZenNotes Server',
      baseUrl: legacyRemoteWorkspace.baseUrl,
      authToken: legacyRemoteWorkspace.authToken,
      vaultPath: null,
      lastConnectedAt: null
    })
  }
  const localVaultsByRoot = new Map<string, PersistedLocalVault>()
  const rawLocalVaults = Array.isArray(candidate.localVaults) ? candidate.localVaults : []
  for (const raw of rawLocalVaults) {
    const entry = normalizeLocalVault(raw)
    if (!entry) continue
    const existing = localVaultsByRoot.get(entry.root)
    if (!existing || entry.lastOpenedAt > existing.lastOpenedAt) {
      localVaultsByRoot.set(entry.root, entry)
    }
  }
  const quickCaptureHotkey =
    typeof candidate.quickCaptureHotkey === 'string'
      ? candidate.quickCaptureHotkey.trim()
      : DEFAULT_QUICK_CAPTURE_HOTKEY
  const quickCapturePinned = candidate.quickCapturePinned === true
  return {
    workspaceMode: candidate.workspaceMode === 'remote' ? 'remote' : 'local',
    vaultRoot: typeof candidate.vaultRoot === 'string' ? candidate.vaultRoot : null,
    localVaults: [...localVaultsByRoot.values()].sort(
      (a, b) => b.lastOpenedAt - a.lastOpenedAt || a.name.localeCompare(b.name)
    ),
    remoteWorkspace: legacyRemoteWorkspace,
    remoteWorkspaceProfileId:
      typeof candidate.remoteWorkspaceProfileId === 'string' &&
      remoteWorkspaceProfiles.some((entry) => entry.id === candidate.remoteWorkspaceProfileId)
        ? candidate.remoteWorkspaceProfileId
        : null,
    remoteWorkspaceProfiles,
    windowState: normalizeWindowState(candidate.windowState),
    zoomFactor,
    quickCaptureHotkey,
    quickCapturePinned
  }
}

export function rememberLocalVault(
  entries: PersistedLocalVault[],
  vault: VaultInfo,
  openedAt = Date.now()
): PersistedLocalVault[] {
  const root = path.resolve(vault.root)
  const next: PersistedLocalVault = {
    root,
    name: vault.name || path.basename(root),
    lastOpenedAt: openedAt
  }
  return [
    next,
    ...entries
      .filter((entry) => path.resolve(entry.root) !== root)
      .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt || a.name.localeCompare(b.name))
  ].slice(0, 20)
}

export function forgetLocalVault(
  entries: PersistedLocalVault[],
  root: string
): PersistedLocalVault[] {
  const target = path.resolve(root)
  return entries.filter((entry) => path.resolve(entry.root) !== target)
}

function configBackupPath(): string {
  return `${configPath()}.bak`
}

function isMissingFileError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: string }).code === 'ENOENT'
}

async function readConfigFile(target: string): Promise<PersistedConfig | null> {
  try {
    const raw = await fs.readFile(target, 'utf8')
    const trimmed = raw.trim()
    if (!trimmed) return null
    return normalizePersistedConfig(JSON.parse(trimmed))
  } catch (err) {
    if (isMissingFileError(err)) return null
    throw err
  }
}

/** Internal: reads the persisted config and reports whether the bytes on
 *  disk were actually readable. Distinguishes three states:
 *  - `{ readable: true, config }`           — a valid config was read (primary or backup)
 *  - `{ readable: true, config: defaults }` — neither file exists (first run)
 *  - `{ readable: false }`                  — file exists but couldn't be parsed/read
 *
 *  `readable: false` is the dangerous state: returning defaults here lets a
 *  subsequent `saveConfig` clobber the (recoverable) on-disk vault path. */
async function loadConfigSafely(): Promise<
  { readable: true; config: PersistedConfig } | { readable: false }
> {
  const target = configPath()
  const backup = configBackupPath()
  try {
    const primary = await readConfigFile(target)
    if (primary) return { readable: true, config: primary }
  } catch (err) {
    // Primary file exists but is unreadable/corrupt. Try the backup before
    // giving up — losing settings is bad, losing the vault is worse.
    console.error('Failed to read primary config; trying backup', err)
    try {
      const fromBackup = await readConfigFile(backup)
      if (fromBackup) {
        console.warn('Restored config from backup after primary read failure')
        return { readable: true, config: fromBackup }
      }
    } catch (backupErr) {
      console.error('Backup config also unreadable', backupErr)
    }
    return { readable: false }
  }
  // Primary missing or empty. Try backup as a last resort (e.g. crash mid-rename).
  try {
    const fromBackup = await readConfigFile(backup)
    if (fromBackup) {
      console.warn('Primary config missing; restored from backup')
      return { readable: true, config: fromBackup }
    }
  } catch (backupErr) {
    console.error('Backup config unreadable', backupErr)
  }
  return { readable: true, config: { ...DEFAULT_CONFIG } }
}

/** Reads the persisted config, returning defaults if nothing readable is on
 *  disk. Read callers (createWindow, listLocalVaults, etc.) tolerate a stale
 *  view of the config — only writes need the stricter contract enforced in
 *  `updateConfig`. */
export async function loadConfig(): Promise<PersistedConfig> {
  const result = await loadConfigSafely()
  if (result.readable) return result.config
  // Unreadable: callers reading for display can fall back to defaults rather
  // than crashing. Writes go through `updateConfig`, which uses
  // `loadConfigSafely` directly and aborts instead of clobbering.
  return { ...DEFAULT_CONFIG }
}

function sanitizeForPersist(cfg: PersistedConfig): PersistedConfig {
  const normalized = normalizePersistedConfig(cfg)
  return {
    ...normalized,
    remoteWorkspace: normalized.remoteWorkspace
      ? {
          baseUrl: normalized.remoteWorkspace.baseUrl
        }
      : null,
    remoteWorkspaceProfiles: normalized.remoteWorkspaceProfiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl,
      vaultPath: profile.vaultPath,
      lastConnectedAt: profile.lastConnectedAt
    }))
  }
}

const CONFIG_TMP_SUFFIX_RE = /\.\d+\.\d+\.tmp$/

/** Removes orphaned `<configPath>.<pid>.<ts>.tmp` files left behind when a
 *  previous save was interrupted between `fs.open` and `fs.rename`. Best
 *  effort — a missing parent dir or unreadable entries are not fatal. */
async function cleanupStaleConfigTmpFiles(): Promise<void> {
  const dir = path.dirname(configPath())
  const prefix = `${path.basename(configPath())}.`
  let entries: Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.startsWith(prefix) &&
          CONFIG_TMP_SUFFIX_RE.test(entry.name)
      )
      .map(async (entry) => {
        try {
          await fs.unlink(path.join(dir, entry.name))
        } catch {
          /* ignore */
        }
      })
  )
}

/** Persists the config atomically: write to a temp file, fsync, then rename
 *  over the live file. Before the rename, the previous live file is copied
 *  to `<path>.bak` so a crash mid-rename can't strand the user without a
 *  recoverable config. */
export async function saveConfig(cfg: PersistedConfig): Promise<void> {
  const sanitized = sanitizeForPersist(cfg)
  const target = configPath()
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  const backup = configBackupPath()
  const payload = JSON.stringify(sanitized, null, 2)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await cleanupStaleConfigTmpFiles()

  // Write + fsync the temp file so the bytes are on disk before we rename.
  const handle = await fs.open(tmp, 'w')
  try {
    await handle.writeFile(payload, 'utf8')
    try {
      await handle.sync()
    } catch (syncErr) {
      // fsync isn't supported on every filesystem. Don't abort the save.
      console.warn('fsync failed for config temp file', syncErr)
    }
  } finally {
    await handle.close()
  }

  // Keep the previous good file as a backup before overwriting. Best-effort:
  // missing primary just means there's nothing to back up yet.
  try {
    await fs.copyFile(target, backup)
  } catch (err) {
    if (!isMissingFileError(err)) {
      console.warn('Failed to refresh config backup', err)
    }
  }

  try {
    await fs.rename(tmp, target)
  } catch (err) {
    // Rename failed — clean up the temp file so it doesn't accumulate.
    try {
      await fs.unlink(tmp)
    } catch {
      /* ignore */
    }
    throw err
  }
}

/**
 * Atomically write a file: temp file + fsync + rename. The rename is atomic, so
 * readers never see a half-written file. Exposed for the databases feature
 * (CSV + sidecar). No `.bak` is left behind — those files live next to the
 * user's data and are just clutter.
 */
export async function writeFileAtomic(absPath: string, data: string): Promise<void> {
  const tmp = `${absPath}.${process.pid}.${Date.now()}.tmp`
  await fs.mkdir(path.dirname(absPath), { recursive: true })
  const handle = await fs.open(tmp, 'w')
  try {
    await handle.writeFile(data, 'utf8')
    try {
      await handle.sync()
    } catch (syncErr) {
      console.warn('fsync failed for atomic write', syncErr)
    }
  } finally {
    await handle.close()
  }
  try {
    await fs.rename(tmp, absPath)
  } catch (err) {
    try {
      await fs.unlink(tmp)
    } catch {
      /* ignore */
    }
    throw err
  }
}

export async function updateConfig(
  updater: (cfg: PersistedConfig) => PersistedConfig | Promise<PersistedConfig>
): Promise<PersistedConfig> {
  let nextConfig = { ...DEFAULT_CONFIG }
  configWriteQueue = configWriteQueue
    .catch(() => {})
    .then(async () => {
      // If the existing config is on disk but unreadable, refuse to write —
      // otherwise a transient read failure (or a half-written file from a
      // crash) would clobber the user's vault path. The in-memory update
      // is still returned so callers behave as expected this session; only
      // persistence is skipped.
      const result = await loadConfigSafely()
      if (!result.readable) {
        nextConfig = normalizePersistedConfig(await updater({ ...DEFAULT_CONFIG }))
        throw new Error('Refusing to persist over unreadable config')
      }
      nextConfig = normalizePersistedConfig(await updater(result.config))
      await saveConfig(nextConfig)
    })
  try {
    await configWriteQueue
  } catch (err) {
    // Don't propagate: a single failed write shouldn't crash the caller.
    // The queue's own `.catch(() => {})` on the next call clears the
    // rejection so subsequent writes can still proceed.
    if (
      !(err instanceof Error) ||
      err.message !== 'Refusing to persist over unreadable config'
    ) {
      console.error('updateConfig failed', err)
    }
  }
  return nextConfig
}

function vaultSettingsPath(root: string): string {
  return path.join(root, INTERNAL_VAULT_DIR, VAULT_SETTINGS_FILE)
}

function noteMetaCachePath(root: string): string {
  return path.join(root, INTERNAL_VAULT_DIR, NOTE_META_CACHE_FILE)
}

function noteCommentsRoot(root: string): string {
  return path.join(root, INTERNAL_VAULT_DIR, NOTE_COMMENTS_DIR)
}

function noteCommentsPath(root: string, rel: string): string {
  return resolveSafe(noteCommentsRoot(root), `${toPosix(rel)}${NOTE_COMMENTS_SUFFIX}`)
}

/** Absolute path of a database's `.csv` data file (a normal vault file). */
export function databaseDataPath(root: string, rel: string): string {
  return resolveSafe(root, toPosix(rel))
}

/**
 * Absolute path of a database's schema/sidecar. New layout: `<Name>.base/
 * schema.json`. A legacy loose `.csv` (not in a `.base` folder) falls back to
 * the co-located `<rel>.csv.base.json` so old vaults still read.
 */
export function databaseSidecarPath(root: string, rel: string): string {
  const schemaRel = databaseSchemaPathFor(toPosix(rel))
  return resolveSafe(root, schemaRel ?? `${toPosix(rel)}${DATABASE_SIDECAR_SUFFIX}`)
}

function cloneVaultSettings(settings: VaultSettings): VaultSettings {
  return {
    primaryNotesLocation: settings.primaryNotesLocation,
    dailyNotes: {
      enabled: settings.dailyNotes.enabled,
      directory: settings.dailyNotes.directory,
      titlePattern: settings.dailyNotes.titlePattern,
      locale: settings.dailyNotes.locale,
      legacyPatterns: settings.dailyNotes.legacyPatterns?.map((pattern) => ({ ...pattern })),
      templateId: settings.dailyNotes.templateId,
      tasksDueOnNoteDate: settings.dailyNotes.tasksDueOnNoteDate,
      rolloverUnfinishedTasks: settings.dailyNotes.rolloverUnfinishedTasks
    },
    weeklyNotes: {
      enabled: settings.weeklyNotes.enabled,
      directory: settings.weeklyNotes.directory,
      titlePattern: settings.weeklyNotes.titlePattern,
      locale: settings.weeklyNotes.locale,
      legacyPatterns: settings.weeklyNotes.legacyPatterns?.map((pattern) => ({ ...pattern })),
      templateId: settings.weeklyNotes.templateId
    },
    monthlyNotes: {
      enabled: settings.monthlyNotes.enabled,
      directory: settings.monthlyNotes.directory,
      titlePattern: settings.monthlyNotes.titlePattern,
      locale: settings.monthlyNotes.locale,
      legacyPatterns: settings.monthlyNotes.legacyPatterns?.map((pattern) => ({ ...pattern })),
      templateId: settings.monthlyNotes.templateId
    },
    folderIcons: { ...settings.folderIcons },
    folderColors: { ...settings.folderColors },
    favorites: [...settings.favorites],
    ...(settings.view ? { view: cloneVaultViewSettings(settings.view) } : {}),
    ...(settings.drawingsLocation
      ? { drawingsLocation: { ...settings.drawingsLocation } }
      : {}),
    ...(settings.databasesLocation
      ? { databasesLocation: { ...settings.databasesLocation } }
      : {})
  }
}

/** Deep-clone the per-vault view overrides (#292) — plain data, but the nested
 *  records need their own copies so callers can't mutate the stored object. */
function cloneVaultViewSettings(view: VaultViewSettings): VaultViewSettings {
  return {
    ...view,
    ...(view.kanbanColumnTitles ? { kanbanColumnTitles: { ...view.kanbanColumnTitles } } : {}),
    ...(view.kanbanColumnOrder
      ? {
          kanbanColumnOrder: Object.fromEntries(
            Object.entries(view.kanbanColumnOrder).map(([group, ids]) => [group, [...ids]])
          )
        }
      : {}),
    ...(view.systemFolderLabels ? { systemFolderLabels: { ...view.systemFolderLabels } } : {})
  }
}

function normalizeDailyNotesDirectory(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_DAILY_NOTES_DIRECTORY
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '')
  return trimmed || DEFAULT_DAILY_NOTES_DIRECTORY
}

function normalizeDailyNoteTitlePattern(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_DAILY_NOTE_TITLE_PATTERN
  const trimmed = value.trim().replace(/[\\/]+/g, '-')
  return trimmed || DEFAULT_DAILY_NOTE_TITLE_PATTERN
}

function normalizeDailyNoteLocale(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_DAILY_NOTE_LOCALE
  const trimmed = value.trim()
  return trimmed || DEFAULT_DAILY_NOTE_LOCALE
}

function normalizeWeeklyNoteTitlePattern(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_WEEKLY_NOTE_TITLE_PATTERN
  const trimmed = value.trim().replace(/[\\/]+/g, '-')
  return trimmed || DEFAULT_WEEKLY_NOTE_TITLE_PATTERN
}

function normalizeWeeklyNoteLocale(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_WEEKLY_NOTE_LOCALE
  const trimmed = value.trim()
  return trimmed || DEFAULT_WEEKLY_NOTE_LOCALE
}

function normalizeWeeklyNotesDirectory(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_WEEKLY_NOTES_DIRECTORY
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '')
  return trimmed || DEFAULT_WEEKLY_NOTES_DIRECTORY
}

function normalizeMonthlyNoteTitlePattern(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_MONTHLY_NOTE_TITLE_PATTERN
  const trimmed = value.trim().replace(/[\\/]+/g, '-')
  return trimmed || DEFAULT_MONTHLY_NOTE_TITLE_PATTERN
}

function normalizeMonthlyNoteLocale(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_MONTHLY_NOTE_LOCALE
  const trimmed = value.trim()
  return trimmed || DEFAULT_MONTHLY_NOTE_LOCALE
}

function normalizeMonthlyNotesDirectory(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_MONTHLY_NOTES_DIRECTORY
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '')
  return trimmed || DEFAULT_MONTHLY_NOTES_DIRECTORY
}

function normalizeTemplateId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function normalizeDailyNoteLegacyPatterns(value: unknown): VaultSettings['dailyNotes']['legacyPatterns'] {
  if (!Array.isArray(value)) return []
  const out: NonNullable<VaultSettings['dailyNotes']['legacyPatterns']> = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const pattern = item as { directory?: unknown; titlePattern?: unknown; locale?: unknown }
    const next = {
      directory: normalizeDailyNotesDirectory(pattern.directory),
      titlePattern: normalizeDailyNoteTitlePattern(pattern.titlePattern),
      locale: normalizeDailyNoteLocale(pattern.locale)
    }
    const key = `${next.directory}\0${next.titlePattern}\0${next.locale}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(next)
  }
  return out
}

function normalizeWeeklyNoteLegacyPatterns(value: unknown): VaultSettings['weeklyNotes']['legacyPatterns'] {
  if (!Array.isArray(value)) return []
  const out: NonNullable<VaultSettings['weeklyNotes']['legacyPatterns']> = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const pattern = item as { directory?: unknown; titlePattern?: unknown; locale?: unknown }
    const next = {
      directory: normalizeWeeklyNotesDirectory(pattern.directory),
      titlePattern: normalizeWeeklyNoteTitlePattern(pattern.titlePattern),
      locale: normalizeWeeklyNoteLocale(pattern.locale)
    }
    const key = `${next.directory}\0${next.titlePattern}\0${next.locale}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(next)
  }
  return out
}

function normalizeMonthlyNoteLegacyPatterns(
  value: unknown
): VaultSettings['monthlyNotes']['legacyPatterns'] {
  if (!Array.isArray(value)) return []
  const out: NonNullable<VaultSettings['monthlyNotes']['legacyPatterns']> = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const pattern = item as { directory?: unknown; titlePattern?: unknown; locale?: unknown }
    const next = {
      directory: normalizeMonthlyNotesDirectory(pattern.directory),
      titlePattern: normalizeMonthlyNoteTitlePattern(pattern.titlePattern),
      locale: normalizeMonthlyNoteLocale(pattern.locale)
    }
    const key = `${next.directory}\0${next.titlePattern}\0${next.locale}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(next)
  }
  return out
}

function normalizePrimaryNotesLocation(value: unknown): PrimaryNotesLocation {
  return value === 'root' ? 'root' : 'inbox'
}

/** Persist a drawings/databases file-location setting; mirrors the renderer's
 *  normalizer so the round-trip through vault.json keeps the value. (#362) */
function normalizeFileLocation(value: unknown): FileLocationSetting {
  const v = value as { mode?: unknown; folder?: unknown } | null | undefined
  if (v?.mode === 'active-note') return { mode: 'active-note' }
  if (v?.mode === 'folder') {
    // Keep `folder` mode even when empty so the setting sticks while the user is
    // still typing the folder; an empty folder resolves to the primary root.
    const folder = (typeof v.folder === 'string' ? v.folder : '')
      .trim()
      .replace(/^\/+|\/+$/g, '')
    return { mode: 'folder', folder }
  }
  return { mode: 'primary' }
}

function normalizeVaultSettings(
  value: unknown,
  fallbackPrimary: PrimaryNotesLocation = DEFAULT_VAULT_SETTINGS.primaryNotesLocation
): VaultSettings {
  if (!value || typeof value !== 'object') {
    return {
      primaryNotesLocation: fallbackPrimary,
      dailyNotes: {
        enabled: DEFAULT_VAULT_SETTINGS.dailyNotes.enabled,
        directory: DEFAULT_DAILY_NOTES_DIRECTORY,
        titlePattern: DEFAULT_DAILY_NOTE_TITLE_PATTERN,
        locale: DEFAULT_DAILY_NOTE_LOCALE,
        tasksDueOnNoteDate: DEFAULT_VAULT_SETTINGS.dailyNotes.tasksDueOnNoteDate,
        rolloverUnfinishedTasks: DEFAULT_VAULT_SETTINGS.dailyNotes.rolloverUnfinishedTasks
      },
      weeklyNotes: {
        enabled: DEFAULT_VAULT_SETTINGS.weeklyNotes.enabled,
        directory: DEFAULT_WEEKLY_NOTES_DIRECTORY,
        titlePattern: DEFAULT_WEEKLY_NOTE_TITLE_PATTERN,
        locale: DEFAULT_WEEKLY_NOTE_LOCALE
      },
      monthlyNotes: {
        enabled: DEFAULT_VAULT_SETTINGS.monthlyNotes.enabled,
        directory: DEFAULT_MONTHLY_NOTES_DIRECTORY,
        titlePattern: DEFAULT_MONTHLY_NOTE_TITLE_PATTERN,
        locale: DEFAULT_MONTHLY_NOTE_LOCALE
      },
      drawingsLocation: { mode: 'primary' },
      databasesLocation: { mode: 'primary' },
      folderIcons: {},
      folderColors: {},
      favorites: []
    }
  }
  const candidate = value as {
    primaryNotesLocation?: unknown
    dailyNotes?: {
      enabled?: unknown
      directory?: unknown
      titlePattern?: unknown
      locale?: unknown
      legacyPatterns?: unknown
      templateId?: unknown
      tasksDueOnNoteDate?: unknown
      rolloverUnfinishedTasks?: unknown
    } | null
    weeklyNotes?: {
      enabled?: unknown
      directory?: unknown
      titlePattern?: unknown
      locale?: unknown
      legacyPatterns?: unknown
      templateId?: unknown
    } | null
    monthlyNotes?: {
      enabled?: unknown
      directory?: unknown
      titlePattern?: unknown
      locale?: unknown
      legacyPatterns?: unknown
      templateId?: unknown
    } | null
    drawingsLocation?: unknown
    databasesLocation?: unknown
    folderIcons?: Record<string, unknown> | null
    folderColors?: Record<string, unknown> | null
    favorites?: unknown
    view?: unknown
  }
  const folderIcons: Record<string, FolderIconId> = {}
  if (candidate.folderIcons && typeof candidate.folderIcons === 'object') {
    for (const [key, iconId] of Object.entries(candidate.folderIcons)) {
      if (!key || !isFolderIconId(iconId)) continue
      folderIcons[key] = iconId
    }
  }
  return {
    primaryNotesLocation: normalizePrimaryNotesLocation(
      candidate.primaryNotesLocation ?? fallbackPrimary
    ),
    dailyNotes: {
      enabled:
        typeof candidate.dailyNotes?.enabled === 'boolean'
          ? candidate.dailyNotes.enabled
          : DEFAULT_VAULT_SETTINGS.dailyNotes.enabled,
      directory: normalizeDailyNotesDirectory(candidate.dailyNotes?.directory),
      titlePattern: normalizeDailyNoteTitlePattern(candidate.dailyNotes?.titlePattern),
      locale: normalizeDailyNoteLocale(candidate.dailyNotes?.locale),
      legacyPatterns: normalizeDailyNoteLegacyPatterns(candidate.dailyNotes?.legacyPatterns),
      templateId: normalizeTemplateId(candidate.dailyNotes?.templateId),
      tasksDueOnNoteDate: candidate.dailyNotes?.tasksDueOnNoteDate !== false,
      rolloverUnfinishedTasks: candidate.dailyNotes?.rolloverUnfinishedTasks === true
    },
    weeklyNotes: {
      enabled:
        typeof candidate.weeklyNotes?.enabled === 'boolean'
          ? candidate.weeklyNotes.enabled
          : DEFAULT_VAULT_SETTINGS.weeklyNotes.enabled,
      directory: normalizeWeeklyNotesDirectory(candidate.weeklyNotes?.directory),
      titlePattern: normalizeWeeklyNoteTitlePattern(candidate.weeklyNotes?.titlePattern),
      locale: normalizeWeeklyNoteLocale(candidate.weeklyNotes?.locale),
      legacyPatterns: normalizeWeeklyNoteLegacyPatterns(candidate.weeklyNotes?.legacyPatterns),
      templateId: normalizeTemplateId(candidate.weeklyNotes?.templateId)
    },
    monthlyNotes: {
      enabled:
        typeof candidate.monthlyNotes?.enabled === 'boolean'
          ? candidate.monthlyNotes.enabled
          : DEFAULT_VAULT_SETTINGS.monthlyNotes.enabled,
      directory: normalizeMonthlyNotesDirectory(candidate.monthlyNotes?.directory),
      titlePattern: normalizeMonthlyNoteTitlePattern(candidate.monthlyNotes?.titlePattern),
      locale: normalizeMonthlyNoteLocale(candidate.monthlyNotes?.locale),
      legacyPatterns: normalizeMonthlyNoteLegacyPatterns(candidate.monthlyNotes?.legacyPatterns),
      templateId: normalizeTemplateId(candidate.monthlyNotes?.templateId)
    },
    drawingsLocation: normalizeFileLocation(candidate.drawingsLocation),
    databasesLocation: normalizeFileLocation(candidate.databasesLocation),
    folderIcons,
    folderColors: normalizeFolderColors(candidate.folderColors),
    favorites: normalizeFavorites(candidate.favorites),
    view: normalizeVaultViewSettings(candidate.view)
  }
}

/** Carry the per-vault view overrides (#292) through the round-trip, keeping
 *  only known keys. The renderer validates the values strictly; here we just
 *  preserve a clean object (or undefined when there are no overrides). */
function normalizeVaultViewSettings(raw: unknown): VaultViewSettings | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const c = raw as Record<string, unknown>
  const view: VaultViewSettings = {}
  if (typeof c.noteSortOrder === 'string') view.noteSortOrder = c.noteSortOrder
  if (typeof c.groupByKind === 'boolean') view.groupByKind = c.groupByKind
  if (typeof c.tasksViewMode === 'string') view.tasksViewMode = c.tasksViewMode
  if (typeof c.kanbanGroupBy === 'string') view.kanbanGroupBy = c.kanbanGroupBy
  if (c.kanbanColumnTitles && typeof c.kanbanColumnTitles === 'object') {
    view.kanbanColumnTitles = c.kanbanColumnTitles as Record<string, string>
  }
  if (c.kanbanColumnOrder && typeof c.kanbanColumnOrder === 'object') {
    view.kanbanColumnOrder = c.kanbanColumnOrder as Record<string, string[]>
  }
  if (typeof c.autoReveal === 'boolean') view.autoReveal = c.autoReveal
  if (c.systemFolderLabels && typeof c.systemFolderLabels === 'object') {
    view.systemFolderLabels = c.systemFolderLabels as Record<string, unknown>
  }
  if (typeof c.unifiedSidebar === 'boolean') view.unifiedSidebar = c.unifiedSidebar
  return Object.keys(view).length > 0 ? view : undefined
}

function normalizeFavorites(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry || seen.has(entry)) continue
    seen.add(entry)
    out.push(entry)
  }
  return out
}

function folderIconKey(folder: NoteFolder, subpath: string): string {
  return `${folder}:${subpath}`
}

function rewriteFolderIconsForRename(
  folderIcons: Record<string, FolderIconId>,
  folder: NoteFolder,
  oldSubpath: string,
  newSubpath: string
): Record<string, FolderIconId> {
  const next: Record<string, FolderIconId> = {}
  const exactKey = folderIconKey(folder, oldSubpath)
  const prefix = `${exactKey}/`
  for (const [key, value] of Object.entries(folderIcons)) {
    if (key === exactKey) {
      next[folderIconKey(folder, newSubpath)] = value
      continue
    }
    if (key.startsWith(prefix)) {
      next[folderIconKey(folder, newSubpath) + key.slice(exactKey.length)] = value
      continue
    }
    next[key] = value
  }
  return next
}

function removeFolderIcons(
  folderIcons: Record<string, FolderIconId>,
  folder: NoteFolder,
  subpath: string
): Record<string, FolderIconId> {
  const next: Record<string, FolderIconId> = {}
  const exactKey = folderIconKey(folder, subpath)
  const prefix = `${exactKey}/`
  for (const [key, value] of Object.entries(folderIcons)) {
    if (key === exactKey || key.startsWith(prefix)) continue
    next[key] = value
  }
  return next
}

function rewriteFolderColorsForRename(
  folderColors: Record<string, FolderColorId>,
  folder: NoteFolder,
  oldSubpath: string,
  newSubpath: string
): Record<string, FolderColorId> {
  const next: Record<string, FolderColorId> = {}
  const exactKey = folderIconKey(folder, oldSubpath)
  const prefix = `${exactKey}/`
  for (const [key, value] of Object.entries(folderColors)) {
    if (key === exactKey) {
      next[folderIconKey(folder, newSubpath)] = value
      continue
    }
    if (key.startsWith(prefix)) {
      next[folderIconKey(folder, newSubpath) + key.slice(exactKey.length)] = value
      continue
    }
    next[key] = value
  }
  return next
}

function removeFolderColors(
  folderColors: Record<string, FolderColorId>,
  folder: NoteFolder,
  subpath: string
): Record<string, FolderColorId> {
  const next: Record<string, FolderColorId> = {}
  const exactKey = folderIconKey(folder, subpath)
  const prefix = `${exactKey}/`
  for (const [key, value] of Object.entries(folderColors)) {
    if (key === exactKey || key.startsWith(prefix)) continue
    next[key] = value
  }
  return next
}

function duplicateFolderIcons(
  folderIcons: Record<string, FolderIconId>,
  folder: NoteFolder,
  sourceSubpath: string,
  targetSubpath: string
): Record<string, FolderIconId> {
  const next: Record<string, FolderIconId> = { ...folderIcons }
  const exactKey = folderIconKey(folder, sourceSubpath)
  const prefix = `${exactKey}/`
  for (const [key, value] of Object.entries(folderIcons)) {
    if (key === exactKey) {
      next[folderIconKey(folder, targetSubpath)] = value
      continue
    }
    if (key.startsWith(prefix)) {
      next[folderIconKey(folder, targetSubpath) + key.slice(exactKey.length)] = value
    }
  }
  return next
}

async function inferPrimaryNotesLocation(root: string): Promise<PrimaryNotesLocation> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return DEFAULT_VAULT_SETTINGS.primaryNotesLocation
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (RESERVED_ROOT_NAMES.has(entry.name)) continue
    if (entry.isDirectory()) return 'root'
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) return 'root'
  }
  return DEFAULT_VAULT_SETTINGS.primaryNotesLocation
}

/**
 * True when the vault is in `inbox` primary-notes mode but its root holds
 * markdown files or non-system folders that only `root` mode would surface —
 * i.e. an Obsidian-style flat vault that was detected as Inbox (e.g. a flaky
 * first directory read on an iCloud/symlinked folder fell back to the default)
 * and is now silently hiding the user's notes. Drives the "Switch to Vault
 * root" banner so an empty-looking vault is explained instead of silent.
 */
export async function rootContentHiddenByInboxMode(root: string): Promise<boolean> {
  const settings = await getVaultSettings(root)
  if (settings.primaryNotesLocation !== 'inbox') return false
  return (await inferPrimaryNotesLocation(root)) === 'root'
}

async function vaultLooksEmpty(root: string): Promise<boolean> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return true
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.name === INTERNAL_VAULT_DIR) continue
    return false
  }
  return true
}

export async function getVaultSettings(root: string): Promise<VaultSettings> {
  let fallbackPrimary = DEFAULT_VAULT_SETTINGS.primaryNotesLocation
  try {
    fallbackPrimary = await inferPrimaryNotesLocation(root)
    const raw = await fs.readFile(vaultSettingsPath(root), 'utf8')
    return normalizeVaultSettings(JSON.parse(raw), fallbackPrimary)
  } catch {
    return normalizeVaultSettings(null, fallbackPrimary)
  }
}

export async function setVaultSettings(
  root: string,
  next: VaultSettings
): Promise<VaultSettings> {
  const fallbackPrimary = await inferPrimaryNotesLocation(root)
  const normalized = normalizeVaultSettings(next, fallbackPrimary)
  // Temporary folder session (#): never write .zennotes/vault.json into a
  // folder the user only dropped in to read. Keep the change in memory.
  if (isEphemeralRoot(root)) return cloneVaultSettings(normalized)
  await fs.mkdir(path.dirname(vaultSettingsPath(root)), { recursive: true })
  await fs.writeFile(vaultSettingsPath(root), JSON.stringify(normalized, null, 2), 'utf8')
  if (normalized.primaryNotesLocation === 'inbox') {
    await fs.mkdir(path.join(root, 'inbox'), { recursive: true })
  }
  return cloneVaultSettings(normalized)
}

async function primaryNotesRoot(root: string): Promise<string> {
  const settings = await getVaultSettings(root)
  return settings.primaryNotesLocation === 'root' ? root : path.join(root, 'inbox')
}

function shouldHidePrimaryRootEntry(name: string): boolean {
  return HIDDEN_PRIMARY_ROOT_NAMES.has(name)
}

export async function folderRoot(root: string, folder: NoteFolder): Promise<string> {
  if (folder === 'inbox') return await primaryNotesRoot(root)
  return path.join(root, folder)
}

export function folderForRelativePath(rel: string): NoteFolder | null {
  const normalized = normalizeVaultRelativePath(rel)
  const top = normalized.split('/')[0]
  if (SYSTEM_FOLDERS.has(top as NoteFolder)) return top as NoteFolder
  if (!top || top.startsWith('.')) return null
  if (RESERVED_ROOT_NAMES.has(top)) return null
  return 'inbox'
}

/**
 * Ensure the expected vault folder layout exists and seed a welcome note
 * the very first time a vault is opened.
 */
export async function ensureVaultLayout(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true })
  const wasEmpty = await vaultLooksEmpty(root)
  const settings = await getVaultSettings(root)
  for (const f of FOLDERS) {
    if (f === 'inbox' && settings.primaryNotesLocation === 'root') continue
    await fs.mkdir(path.join(root, f), { recursive: true })
  }
  if (wasEmpty) {
    const welcomeDir = await primaryNotesRoot(root)
    await fs.mkdir(welcomeDir, { recursive: true })
    const welcomePath = path.join(welcomeDir, 'Welcome.md')
    try {
      await fs.access(welcomePath)
    } catch {
      await fs.writeFile(welcomePath, WELCOME_NOTE, 'utf8')
    }
  }
  if (!wasEmpty) {
    try {
      await migrateLegacyDatabases(root)
    } catch (err) {
      console.error('legacy database migration failed', err)
    }
    try {
      await migrateLooseAssets(root)
    } catch (err) {
      console.error('loose asset migration failed', err)
    }
  }
}

/**
 * One-time, idempotent migration: unify assets under `assets/`. Moves loose
 * root-level attachments and any files in the legacy `attachements/` / `_assets/`
 * dirs into `assets/`, skipping a file whose basename already exists there (so
 * the basename-fallback resolution of `![[…]]`/`![](…)` embeds stays
 * unambiguous). Never touches notes (`.md`) or database files. Safe on every
 * open. Returns the moved (assets-relative) and skipped (source) paths.
 */
export async function migrateLooseAssets(
  root: string
): Promise<{ moved: string[]; skipped: string[] }> {
  const moved: string[] = []
  const skipped: string[] = []
  const assetsAbs = path.join(root, ASSETS_DIR)

  const moveIntoAssets = async (srcRel: string): Promise<void> => {
    const destRel = `${ASSETS_DIR}/${path.basename(srcRel)}`
    if (toPosix(srcRel) === destRel) return
    const destAbs = resolveSafe(root, destRel)
    try {
      await fs.access(destAbs) // a same-named asset already exists — don't clobber/rename
      skipped.push(toPosix(srcRel))
      return
    } catch {
      /* destination free */
    }
    await fs.mkdir(assetsAbs, { recursive: true })
    await fs.rename(resolveSafe(root, srcRel), destAbs)
    moved.push(destRel)
  }

  // 1. Loose asset files sitting directly at the vault root.
  //
  // Skip this for a vault managed by another app — an `.obsidian/` directory
  // marks an Obsidian vault. Those loose root files (`.canvas`, images, PDFs,
  // anything) are the user's own, not ZenNotes' legacy attachments, and
  // silently relocating them into `assets/` surprised users who pointed
  // ZenNotes at an existing Obsidian vault (#202). The legacy ZenNotes
  // attachment dirs below never exist in such a vault, so they stay safe.
  let isExternalVault = false
  try {
    await fs.access(path.join(root, '.obsidian'))
    isExternalVault = true
  } catch {
    /* not an Obsidian vault */
  }
  if (!isExternalVault) {
    let rootEntries: Dirent[] = []
    try {
      rootEntries = await fs.readdir(root, { withFileTypes: true })
    } catch {
      rootEntries = []
    }
    for (const entry of rootEntries) {
      if (entry.name.startsWith('.') || !entry.isFile()) continue
      if (entry.name.toLowerCase().endsWith('.md')) continue // a note
      if (databaseCsvPathFor(entry.name) || isDatabaseInternalPath(entry.name)) continue // a database
      await moveIntoAssets(entry.name)
    }
  }

  // 2. Files in the legacy attachment dirs, then drop the dir if it empties.
  for (const dir of LEGACY_ATTACHMENTS_DIRS) {
    let entries: Dirent[]
    try {
      entries = await fs.readdir(path.join(root, dir), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || !entry.isFile()) continue
      await moveIntoAssets(`${dir}/${entry.name}`)
    }
    try {
      await fs.rmdir(path.join(root, dir))
    } catch {
      /* not empty — leave it */
    }
  }

  if (moved.length > 0) {
    console.log(`[zen] migrated ${moved.length} asset(s) into ${ASSETS_DIR}/`)
  }
  return { moved, skipped }
}

/**
 * One-time, idempotent migration: convert legacy loose databases — a
 * `<dir>/<Name>.csv` + co-located `<dir>/<Name>.csv.base.json` sidecar, with
 * record-page notes under `<dir>/<Name>/` — into the self-contained
 * `<dir>/<Name>.base/` folder (data.csv + schema.json + record `.md` pages).
 * Safe to run on every open: anything already in `.base` form, or whose target
 * folder exists, is skipped. Per-database failures are logged, not fatal.
 * Returns the number of databases migrated.
 */
export async function migrateLegacyDatabases(root: string): Promise<number> {
  let migrated = 0
  const walk = async (dirRel: string): Promise<void> => {
    const dirAbs = dirRel ? path.join(root, dirRel) : root
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const name = entry.name
      if (name.startsWith('.')) continue
      const childRel = dirRel ? `${dirRel}/${name}` : name
      if (entry.isDirectory()) {
        if (isFormDirName(name)) continue // already a database folder
        await walk(childRel)
        continue
      }
      const lower = name.toLowerCase()
      if (!lower.endsWith('.csv') || lower.endsWith(`.csv${DATABASE_SIDECAR_SUFFIX}`)) continue
      // Only migrate a managed database (a `.csv` with a sibling sidecar); a
      // plain CSV without one is left as a file.
      const sidecarRel = `${childRel}${DATABASE_SIDECAR_SUFFIX}`
      try {
        await fs.access(resolveSafe(root, sidecarRel))
      } catch {
        continue
      }
      try {
        if (await migrateOneLegacyDatabase(root, childRel, sidecarRel)) migrated++
      } catch (err) {
        console.error(`database migration failed for ${childRel}`, err)
      }
    }
  }
  await walk('')
  if (migrated > 0) {
    console.log(`[zen] migrated ${migrated} database(s) to the .base folder layout`)
  }
  return migrated
}

async function migrateOneLegacyDatabase(
  root: string,
  csvRel: string,
  sidecarRel: string
): Promise<boolean> {
  const name = path.basename(csvRel).replace(/\.csv$/i, '')
  const parentRel = csvRel.includes('/') ? csvRel.slice(0, csvRel.lastIndexOf('/')) : ''
  const formDirRel = parentRel ? `${parentRel}/${name}${FORM_DIR_SUFFIX}` : `${name}${FORM_DIR_SUFFIX}`
  const formDirAbs = resolveSafe(root, formDirRel)
  // Idempotent / collision safety: never clobber an existing folder.
  try {
    await fs.access(formDirAbs)
    return false
  } catch {
    /* target free — proceed */
  }

  let sidecar: Record<string, unknown> = {}
  try {
    sidecar = JSON.parse(await fs.readFile(resolveSafe(root, sidecarRel), 'utf8')) as Record<
      string,
      unknown
    >
  } catch {
    /* unreadable sidecar — still migrate the data, infer schema on next open */
  }

  await fs.mkdir(formDirAbs, { recursive: true })

  // Move record-page notes into the folder; rewrite pages → relative basenames.
  const pages =
    sidecar.pages && typeof sidecar.pages === 'object'
      ? (sidecar.pages as Record<string, unknown>)
      : {}
  const newPages: Record<string, string> = {}
  const oldPageDirs = new Set<string>()
  for (const [rowId, p] of Object.entries(pages)) {
    if (typeof p !== 'string') continue
    const srcAbs = resolveSafe(root, p)
    try {
      await fs.access(srcAbs)
    } catch {
      continue // page note already gone — drop the mapping
    }
    const finalTitle = await uniqueTitle(formDirAbs, sanitizeNoteTitle(path.basename(p, '.md')))
    await fs.rename(srcAbs, resolveSafe(root, `${formDirRel}/${finalTitle}.md`))
    newPages[rowId] = `${finalTitle}.md`
    if (p.includes('/')) oldPageDirs.add(p.slice(0, p.lastIndexOf('/')))
  }

  // Move the data file, write schema.json (relative pages), drop the old sidecar.
  await fs.rename(resolveSafe(root, csvRel), resolveSafe(root, `${formDirRel}/${FORM_DATA_FILE}`))
  const outSidecar: Record<string, unknown> = { ...sidecar }
  if (Object.keys(newPages).length > 0) outSidecar.pages = newPages
  else delete outSidecar.pages
  await writeFileAtomic(
    resolveSafe(root, `${formDirRel}/${FORM_SCHEMA_FILE}`),
    `${JSON.stringify(outSidecar, null, 2)}\n`
  )
  await fs.rm(resolveSafe(root, sidecarRel), { force: true })

  // Remove now-empty legacy per-database page folders (e.g. `<dir>/<Name>/`).
  for (const d of oldPageDirs) {
    try {
      await fs.rmdir(resolveSafe(root, d))
    } catch {
      /* not empty / not ours — leave it */
    }
  }
  return true
}

export function vaultInfo(root: string): VaultInfo {
  return { root, name: path.basename(root) }
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/')
}

function normalizeVaultRelativePath(rel: string): string {
  const normalized = toPosix(path.normalize(rel)).replace(/^(\.\/)+/, '')
  return normalized === '.' ? '' : normalized
}

function markdownDestination(p: string): string {
  return `<${p.replace(/>/g, '%3E')}>`
}

function folderOf(root: string, absPath: string): NoteFolder | null {
  return folderForRelativePath(path.relative(root, absPath))
}

/**
 * Blank out fenced and inline code spans so the #tag / [[link]] / asset
 * scanners never read code as content. Fence detection is line-based and
 * indentation-tolerant: a fence nested under a list item is still a code block,
 * so its contents (e.g. a C `#include` line) must not be scanned. A
 * column-0-anchored regex missed indented fences and leaked them as tags (#293).
 * Mirrors `stripCodeContent` in packages/app-core/src/lib/tags.ts and
 * apps/server/internal/vault/parse.go — keep the three in sync.
 */
function stripCodeContent(body: string): string {
  if (!body.includes('`') && !body.includes('~')) return body
  const lines = body.split('\n')
  let inFence = false
  let fenceChar = ''
  let fenceLen = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const m = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line)
    if (m) {
      const marker = m[1] as string
      const char = marker[0] as string
      const rest = m[2] as string
      if (!inFence) {
        // A backtick fence's info string may not contain a backtick (CommonMark),
        // which keeps a single-line ``` ```inline``` ``` out of fence handling.
        if (char === '~' || !rest.includes('`')) {
          inFence = true
          fenceChar = char
          fenceLen = marker.length
          lines[i] = ' '
          continue
        }
      } else if (char === fenceChar && marker.length >= fenceLen && rest.trim() === '') {
        inFence = false
        lines[i] = ' '
        continue
      }
    }
    if (inFence) lines[i] = ' '
  }
  return lines.join('\n').replace(/`[^`\n]*`/g, ' ')
}

function localAssetTargetKind(target: string): ImportedAssetKind | null {
  const clean = target.split('#')[0]?.split('?')[0] ?? target
  const lastDot = clean.lastIndexOf('.')
  if (lastDot === -1) return null
  const ext = clean.slice(lastDot).toLowerCase()
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (PDF_EXTENSIONS.has(ext)) return 'pdf'
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio'
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  return 'file'
}

/** Pull unique `#tags` out of markdown text, ignoring fenced/inline code. */
function extractTags(body: string): string[] {
  if (!body.includes('#')) return []
  const stripped = stripCodeContent(body)
  const matches = stripped.match(/(?:^|\s)#(\p{L}[\p{L}\d_/-]*)/gu) || []
  const seen = new Set<string>()
  for (const m of matches) seen.add(m.trim().slice(1))
  return [...seen]
}

/**
 * Whether a note body references at least one local asset (any
 * markdown link / image whose href looks like a relative file path
 * with a known asset extension). Quick heuristic — used purely for
 * the sidebar "has attachments" indicator. Skips fenced / inline code.
 */
function bodyHasLocalAsset(body: string): boolean {
  if (!body.includes('](') && !body.includes('![[')) return false
  const stripped = stripCodeContent(body)
  const linkRe = /(!?)\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\)/g
  const embedRe = /!\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/g
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(stripped)) !== null) {
    let href = (m[2] ?? '').trim()
    if (href.startsWith('<') && href.endsWith('>')) href = href.slice(1, -1)
    if (!href || href.startsWith('#') || href.startsWith('//')) continue
    // Skip URLs (anything with a scheme like http:, mailto:, file:, …).
    if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(href)) continue
    if (localAssetTargetKind(href)) return true
  }
  while ((m = embedRe.exec(stripped)) !== null) {
    if (localAssetTargetKind((m[1] ?? '').trim())) return true
  }
  return false
}

/** Pull unique `[[wikilink]]` targets out of markdown text. Supports
 *  `[[target|label]]` by discarding the label. Ignores fenced/inline code. */
function extractWikilinks(body: string): string[] {
  if (!body.includes('[[')) return []
  const stripped = stripCodeContent(body)
  const re = /(!?)\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/g
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(stripped)) !== null) {
    const bang = m[1] ?? ''
    const target = (m[2] ?? '').trim()
    if (!target) continue
    if (bang === '!' && localAssetTargetKind(target)) continue
    seen.add(target)
  }
  return [...seen]
}

/** Pull unique asset-embed targets out of markdown — both `![[asset]]` (which
 *  extractWikilinks deliberately skips) and `![](path)` image/file embeds. The
 *  raw targets are resolved to assets per-note by the renderer (relative path +
 *  basename fallback), to show which notes use each asset. */
function extractAssetEmbeds(body: string): string[] {
  const stripped = stripCodeContent(body)
  const seen = new Set<string>()
  if (stripped.includes('![[')) {
    const re = /!\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(stripped)) !== null) {
      const t = (m[1] ?? '').trim()
      if (t && localAssetTargetKind(t)) seen.add(t)
    }
  }
  if (stripped.includes('](')) {
    const re = /!\[[^\]]*\]\(\s*<?([^)>\s]+)>?[^)]*\)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(stripped)) !== null) {
      const raw = (m[1] ?? '').trim()
      if (!raw || raw.startsWith('#') || /^[a-zA-Z][\w+.-]*:/.test(raw)) continue // skip URLs/anchors
      try {
        seen.add(decodeURIComponent(raw))
      } catch {
        seen.add(raw)
      }
    }
  }
  return [...seen]
}

/** Build a short plaintext preview from markdown. */
function buildExcerpt(body: string): string {
  const withoutFront = body.startsWith('---\n') ? body.replace(/^---\n[\s\S]*?\n---\n/, '') : body
  let text = stripCodeContent(withoutFront)
  if (text.includes('](')) {
    text = text
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  }
  if (text.includes('![[')) {
    text = text.replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) => b || a)
  }
  if (text.includes('[[')) {
    text = text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) => b || a)
  }
  if (text.includes('#')) text = text.replace(/^#{1,6}\s+/gm, '')
  if (/[*_~>]/.test(text)) text = text.replace(/[*_~>]+/g, '')
  text = text.replace(/\s+/g, ' ').trim()
  return text.slice(0, 220)
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function scoreMatch(query: string, text: string): number {
  if (!query) return 1
  if (!text) return 0
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (t === q) return 1000
  if (t.startsWith(q)) return 900 - t.length * 0.5
  const wordBoundary = new RegExp(`(?:^|[\\s·:_\\-/])${escapeRegex(q)}`)
  if (wordBoundary.test(t)) return 700 - t.length * 0.5
  if (t.includes(q)) return 500 - t.length * 0.5

  let i = 0
  let gaps = 0
  let prev = -1
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] === q[i]) {
      if (prev === -1) gaps += j
      else gaps += j - prev - 1
      prev = j
      i++
    }
  }
  if (i === q.length) return Math.max(1, 200 - gaps * 3 - t.length * 0.2)
  return 0
}

function firstMatchColumn(query: string, text: string): number {
  const q = query.trim().toLowerCase()
  const t = text.toLowerCase()
  const direct = t.indexOf(q)
  if (direct >= 0) return direct

  let qi = 0
  let start = -1
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] !== q[qi]) continue
    if (start === -1) start = i
    qi++
  }
  return start >= 0 ? start : 0
}

function collapseSearchLine(line: string): string {
  return line.replace(/\s+/g, ' ').trim()
}

function normalizeToolPath(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  if (trimmed === '~') return app.getPath('home')
  if (trimmed.startsWith('~/')) return path.join(app.getPath('home'), trimmed.slice(2))
  return trimmed
}

function normalizeVaultTextSearchToolPaths(
  paths: VaultTextSearchToolPaths | null | undefined
): Required<VaultTextSearchToolPaths> {
  return {
    ripgrepPath: normalizeToolPath(paths?.ripgrepPath),
    fzfPath: normalizeToolPath(paths?.fzfPath)
  }
}

function capabilityCacheKey(paths: Required<VaultTextSearchToolPaths>): string {
  return JSON.stringify(paths)
}

function candidateCacheKey(
  root: string,
  source: 'builtin' | 'ripgrep',
  paths: Required<VaultTextSearchToolPaths>
): string {
  return JSON.stringify({
    root: path.resolve(root),
    source,
    paths
  })
}

export function invalidateVaultTextSearchCache(root?: string): void {
  if (!cachedVaultTextSearchCandidates) return
  if (!root || path.resolve(cachedVaultTextSearchCandidates.root) === path.resolve(root)) {
    cachedVaultTextSearchCandidates = null
  }
}

function noteMetaCacheKey(root: string, abs: string): string {
  return `${path.resolve(root)}\0${path.resolve(abs)}`
}

function sameMtimeMs(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.001
}

function normalizeCachedNoteMeta(value: unknown): NoteMeta | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<NoteMeta>
  if (
    typeof candidate.path !== 'string' ||
    typeof candidate.title !== 'string' ||
    !SYSTEM_FOLDERS.has(candidate.folder as NoteFolder) ||
    typeof candidate.siblingOrder !== 'number' ||
    typeof candidate.createdAt !== 'number' ||
    typeof candidate.updatedAt !== 'number' ||
    typeof candidate.size !== 'number' ||
    !Array.isArray(candidate.tags) ||
    !candidate.tags.every((tag) => typeof tag === 'string') ||
    !Array.isArray(candidate.wikilinks) ||
    !candidate.wikilinks.every((wikilink) => typeof wikilink === 'string') ||
    !Array.isArray(candidate.assetEmbeds) ||
    !candidate.assetEmbeds.every((embed) => typeof embed === 'string') ||
    typeof candidate.hasAttachments !== 'boolean' ||
    typeof candidate.excerpt !== 'string'
  ) {
    return null
  }
  return {
    path: candidate.path,
    title: candidate.title,
    folder: candidate.folder as NoteFolder,
    siblingOrder: candidate.siblingOrder,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    size: candidate.size,
    tags: candidate.tags,
    wikilinks: candidate.wikilinks,
    assetEmbeds: candidate.assetEmbeds,
    hasAttachments: candidate.hasAttachments,
    excerpt: candidate.excerpt
  }
}

async function hydratePersistedNoteMetaCache(root: string): Promise<void> {
  const rootAbs = path.resolve(root)
  if (loadedPersistedNoteMetaCacheRoots.has(rootAbs)) return
  loadedPersistedNoteMetaCacheRoots.add(rootAbs)

  try {
    const raw = await fs.readFile(noteMetaCachePath(root), 'utf8')
    const parsed = JSON.parse(raw) as {
      version?: unknown
      entries?: unknown
    }
    if (parsed.version !== NOTE_META_CACHE_VERSION || !Array.isArray(parsed.entries)) return

    for (const entry of parsed.entries) {
      if (!entry || typeof entry !== 'object') continue
      const candidate = entry as {
        path?: unknown
        mtimeMs?: unknown
        size?: unknown
        meta?: unknown
      }
      if (
        typeof candidate.path !== 'string' ||
        typeof candidate.mtimeMs !== 'number' ||
        typeof candidate.size !== 'number'
      ) {
        continue
      }
      const meta = normalizeCachedNoteMeta(candidate.meta)
      if (!meta || meta.path !== candidate.path) continue
      try {
        const abs = resolveSafe(root, candidate.path)
        noteMetaCache.set(noteMetaCacheKey(root, abs), {
          mtimeMs: candidate.mtimeMs,
          size: candidate.size,
          meta
        })
      } catch {
        /* ignore invalid cache paths */
      }
    }
  } catch {
    /* missing or corrupt cache files should never block vault loading */
  }
}

function snapshotNoteMetaCache(root: string, metas: NoteMeta[]): Array<{
  path: string
  mtimeMs: number
  size: number
  meta: NoteMeta
}> {
  const entries: Array<{ path: string; mtimeMs: number; size: number; meta: NoteMeta }> = []
  for (const meta of metas) {
    try {
      const abs = resolveSafe(root, meta.path)
      const cached = noteMetaCache.get(noteMetaCacheKey(root, abs))
      if (!cached) continue
      entries.push({
        path: meta.path,
        mtimeMs: cached.mtimeMs,
        size: cached.size,
        meta: { ...cached.meta, siblingOrder: meta.siblingOrder }
      })
    } catch {
      /* ignore invalid paths */
    }
  }
  return entries
}

async function persistNoteMetaCacheSnapshot(
  root: string,
  entries: Array<{ path: string; mtimeMs: number; size: number; meta: NoteMeta }>
): Promise<void> {
  const target = noteMetaCachePath(root)
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`
  try {
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(
      temp,
      `${JSON.stringify({ version: NOTE_META_CACHE_VERSION, entries })}\n`,
      'utf8'
    )
    await fs.rename(temp, target)
  } catch {
    await fs.rm(temp, { force: true }).catch(() => {})
  }
}

function schedulePersistNoteMetaCache(root: string, metas: NoteMeta[]): void {
  if (process.env.ZEN_PERF_DISABLE_PERSISTED_META_CACHE === '1') return
  // Temporary folder session (#): keep the note-meta cache in memory; don't
  // write .zennotes/ into a folder the user is only browsing.
  if (isEphemeralRoot(root)) return
  const rootAbs = path.resolve(root)
  clearScheduledPersistNoteMetaCache(rootAbs)

  const timer = setTimeout(() => {
    noteMetaCachePersistTimers.delete(rootAbs)
    const entries = snapshotNoteMetaCache(root, metas)
    if (entries.length === 0) return
    void persistNoteMetaCacheSnapshot(root, entries)
  }, 1000)
  if (typeof timer === 'object' && 'unref' in timer) timer.unref()
  noteMetaCachePersistTimers.set(rootAbs, timer)
}

function clearScheduledPersistNoteMetaCache(rootAbs: string): void {
  const existing = noteMetaCachePersistTimers.get(rootAbs)
  if (existing) clearTimeout(existing)
  noteMetaCachePersistTimers.delete(rootAbs)
}

export function invalidateNoteMetaCache(root: string, rel?: string): void {
  const rootAbs = path.resolve(root)
  clearScheduledPersistNoteMetaCache(rootAbs)
  if (!rel) {
    for (const key of noteMetaCache.keys()) {
      if (key.startsWith(`${rootAbs}\0`)) noteMetaCache.delete(key)
    }
    loadedPersistedNoteMetaCacheRoots.delete(rootAbs)
    return
  }

  try {
    noteMetaCache.delete(noteMetaCacheKey(root, resolveSafe(root, rel)))
  } catch {
    /* ignore invalid relative paths */
  }
}

async function getCachedVaultTextSearchCandidates(
  root: string,
  source: 'builtin' | 'ripgrep',
  paths: Required<VaultTextSearchToolPaths>,
  collect: () => Promise<VaultTextSearchCandidate[]>
): Promise<VaultTextSearchCandidate[]> {
  const key = candidateCacheKey(root, source, paths)
  const now = Date.now()
  if (
    cachedVaultTextSearchCandidates &&
    cachedVaultTextSearchCandidates.key === key &&
    now - cachedVaultTextSearchCandidates.at < SEARCH_CANDIDATE_CACHE_TTL_MS
  ) {
    recordMainPerf('main.vaultTextSearch.candidates.cacheHit', 0, {
      source,
      candidates: cachedVaultTextSearchCandidates.value.length
    })
    return cachedVaultTextSearchCandidates.value
  }

  const startedAt = performance.now()
  const value = await collect()
  cachedVaultTextSearchCandidates = {
    at: Date.now(),
    key,
    root: path.resolve(root),
    value
  }
  recordMainPerf('main.vaultTextSearch.candidates.refresh', performance.now() - startedAt, {
    source,
    candidates: value.length
  })
  return value
}

async function searchExecutable(
  kind: 'ripgrep' | 'fzf',
  paths: Required<VaultTextSearchToolPaths>
): Promise<string | null> {
  const configured = kind === 'ripgrep' ? paths.ripgrepPath : paths.fzfPath
  if (!configured) {
    // Auto mode. GUI apps launched from Finder/Dock inherit only a minimal
    // PATH (/usr/bin:/bin:/usr/sbin:/sbin), so the bare command name often
    // isn't resolvable even when rg/fzf are installed in a non-standard place
    // (Homebrew, cargo, nix, …). Resolve through the user's login shell so the
    // absolute path flows into both detection and execution; fall back to the
    // bare name so an already-correct PATH (and Windows) keeps working. (#73)
    const command = kind === 'ripgrep' ? 'rg' : 'fzf'
    return (await resolveCommandViaLoginShell(command)) ?? command
  }
  if (!path.isAbsolute(configured)) return null

  const normalized = path.resolve(configured)
  const basename = path.basename(normalized).toLowerCase()
  if (!SEARCH_EXECUTABLE_NAMES[kind].has(basename)) return null

  try {
    const stat = await fs.stat(normalized)
    return stat.isFile() ? normalized : null
  } catch {
    return null
  }
}

async function commandAvailable(command: string): Promise<boolean> {
  try {
    await execFileAsync(command, ['--version'], {
      timeout: COMMAND_CHECK_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 256 * 1024
    })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return false
    return false
  }
}

export async function searchVaultTextCapabilities(
  rawPaths: VaultTextSearchToolPaths = {},
  force = false
): Promise<VaultTextSearchCapabilities> {
  const paths = normalizeVaultTextSearchToolPaths(rawPaths)
  const key = capabilityCacheKey(paths)
  const now = Date.now()
  if (
    !force &&
    cachedVaultTextSearchCapabilities &&
    cachedVaultTextSearchCapabilities.key === key &&
    now - cachedVaultTextSearchCapabilities.at < 30_000
  ) {
    return cachedVaultTextSearchCapabilities.value
  }

  const ripgrep = await searchExecutable('ripgrep', paths)
  const fzf = await searchExecutable('fzf', paths)
  const value = {
    ripgrep: ripgrep ? await commandAvailable(ripgrep) : false,
    fzf: fzf ? await commandAvailable(fzf) : false
  }
  cachedVaultTextSearchCapabilities = { at: now, key, value }
  return value
}

function resolveSearchBackend(
  preferred: VaultTextSearchBackendPreference,
  capabilities: VaultTextSearchCapabilities
): VaultTextSearchBackendResolved {
  if (preferred === 'builtin') return 'builtin'
  if (preferred === 'ripgrep') return capabilities.ripgrep ? 'ripgrep' : 'builtin'
  if (preferred === 'fzf') return capabilities.fzf ? 'fzf' : 'builtin'
  if (capabilities.fzf) return 'fzf'
  if (capabilities.ripgrep) return 'ripgrep'
  return 'builtin'
}

function noteFolderFromRelPath(relPath: string): NoteFolder | null {
  return folderForRelativePath(relPath)
}

// A directory entry counts as a markdown note when it's a real .md file
// or a symlink that resolves to one. readdir's Dirent reports a symlink
// as isSymbolicLink() (never isFile()), so without this stat fallback a
// note symlinked into the vault is invisible.
async function isMarkdownNoteEntry(full: string, entry: Dirent): Promise<boolean> {
  if (!entry.name.toLowerCase().endsWith('.md')) return false
  if (entry.isFile()) return true
  if (entry.isSymbolicLink()) {
    try {
      return (await fs.stat(full)).isFile()
    } catch {
      return false
    }
  }
  return false
}

// `.excalidraw` drawings are listed alongside notes (so they show in the sidebar
// tree); the sidebar/editor route them by extension to the drawing view.
async function isExcalidrawFileEntry(full: string, entry: Dirent): Promise<boolean> {
  if (!isExcalidrawPath(entry.name)) return false
  if (entry.isFile()) return true
  if (entry.isSymbolicLink()) {
    try {
      return (await fs.stat(full)).isFile()
    } catch {
      return false
    }
  }
  return false
}

async function realpathOrResolve(p: string): Promise<string> {
  try {
    return await fs.realpath(p)
  } catch {
    return path.resolve(p)
  }
}

// Decide whether a readdir entry is a directory the vault walk should
// descend into, returning its resolved real path (for cycle tracking) or
// null. Real directories always qualify; a symlink qualifies only when it
// resolves to a directory. Returns null when descending would revisit an
// ancestor on the current path — that's a cycle (a link back into the
// vault, or an external loop) that would otherwise recurse forever.
async function resolveDirDescent(
  full: string,
  entry: Dirent,
  parentReal: string,
  ancestors: Set<string>
): Promise<string | null> {
  let real: string
  if (entry.isDirectory()) {
    real = path.join(parentReal, entry.name)
  } else if (entry.isSymbolicLink()) {
    try {
      if (!(await fs.stat(full)).isDirectory()) return null
      real = await fs.realpath(full)
    } catch {
      return null
    }
  } else {
    return null
  }
  return ancestors.has(real) ? null : real
}

async function collectBuiltinSearchCandidates(root: string): Promise<VaultTextSearchCandidate[]> {
  const files: Array<{ full: string; folder: NoteFolder }> = []
  const walkFolder = async (
    folder: NoteFolder,
    dirAbs: string,
    dirReal: string,
    topAbs: string,
    isPrimaryRoot: boolean,
    ancestors: Set<string>
  ): Promise<void> => {
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const full = path.join(dirAbs, entry.name)
      const childReal = await resolveDirDescent(full, entry, dirReal, ancestors)
      if (childReal !== null) {
        if (entry.name.startsWith('.')) continue
        if (isPrimaryRoot && dirAbs === topAbs && shouldHidePrimaryRootEntry(entry.name)) continue
        ancestors.add(childReal)
        await walkFolder(folder, full, childReal, topAbs, isPrimaryRoot, ancestors)
        ancestors.delete(childReal)
        continue
      }
      if (!(await isMarkdownNoteEntry(full, entry))) continue
      files.push({ full, folder })
    }
  }

  for (const folder of SEARCHABLE_TEXT_FOLDERS) {
    const topAbs = await folderRoot(root, folder)
    const isPrimaryRoot = folder === 'inbox' && path.resolve(topAbs) === path.resolve(root)
    const topReal = await realpathOrResolve(topAbs)
    await walkFolder(folder, topAbs, topReal, topAbs, isPrimaryRoot, new Set([topReal]))
  }

  const candidateGroups = await mapLimit(
    files,
    SEARCH_CANDIDATE_READ_CONCURRENCY,
    async ({ full, folder }) => {
      let body = ''
      try {
        body = await fs.readFile(full, 'utf8')
      } catch {
        return []
      }

      const candidates: VaultTextSearchCandidate[] = []
      const relPath = toPosix(path.relative(root, full))
      const title = path.basename(full, path.extname(full))
      const lines = body.split('\n')
      let lineOffset = 0

      for (let index = 0; index < lines.length; index += 1) {
        const rawLine = lines[index] ?? ''
        candidates.push({
          path: relPath,
          title,
          folder,
          lineNumber: index + 1,
          offset: lineOffset,
          lineText: collapseSearchLine(rawLine).slice(0, 220)
        })
        lineOffset += rawLine.length + 1
      }
      return candidates
    }
  )
  return candidateGroups.flat()
}

async function collectRipgrepSearchCandidates(
  root: string,
  paths: Required<VaultTextSearchToolPaths>
): Promise<VaultTextSearchCandidate[]> {
  let stdout = ''
  try {
    const ripgrep = await searchExecutable('ripgrep', paths)
    if (!ripgrep) return []
    const resolvedSearchRoots = await Promise.all(
      SEARCHABLE_TEXT_FOLDERS.map(async (folder) => {
        const dir = await folderRoot(root, folder)
        return normalizeVaultRelativePath(path.relative(root, dir)) || '.'
      })
    )
    const searchRoots = resolvedSearchRoots.includes('.') ? ['.'] : resolvedSearchRoots
    const result = await execFileAsync(
      ripgrep,
      [
        '--json',
        '--line-number',
        '--with-filename',
        '--no-heading',
        '--color=never',
        '-g',
        '*.md',
        '^',
        ...searchRoots
      ],
      {
        cwd: root,
        windowsHide: true,
        maxBuffer: SEARCH_EXEC_MAX_BUFFER
      }
    )
    stdout = result.stdout
  } catch (error) {
    if ((error as { code?: number }).code === 1) return []
    throw error
  }

  const candidates: VaultTextSearchCandidate[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (!event || typeof event !== 'object') continue
    const type = (event as { type?: unknown }).type
    if (type !== 'match') continue
    const data = (event as { data?: Record<string, unknown> }).data
    const rawPath = data?.path
    const rawLines = data?.lines
    const lineNumber = data?.line_number
    const relPath =
      rawPath && typeof rawPath === 'object' && typeof (rawPath as { text?: unknown }).text === 'string'
        ? normalizeVaultRelativePath((rawPath as { text: string }).text)
        : null
    const rawLineText =
      rawLines && typeof rawLines === 'object' && typeof (rawLines as { text?: unknown }).text === 'string'
        ? (rawLines as { text: string }).text.replace(/\r?\n$/, '')
        : null
    if (!relPath || rawLineText == null || typeof lineNumber !== 'number') continue
    const folder = noteFolderFromRelPath(relPath)
    if (!folder || !SEARCHABLE_TEXT_FOLDERS.includes(folder)) continue
    candidates.push({
      path: relPath,
      title: path.basename(relPath, path.extname(relPath)),
      folder,
      lineNumber,
      lineText: collapseSearchLine(rawLineText).slice(0, 220)
    })
  }
  return candidates
}

function rankSearchCandidates(
  query: string,
  candidates: VaultTextSearchCandidate[],
  limit: number
): ScoredVaultTextSearchCandidate[] {
  const ranked: ScoredVaultTextSearchCandidate[] = []
  for (const candidate of candidates) {
    const bodyScore = scoreMatch(query, candidate.lineText)
    if (bodyScore <= 0) continue
    const titleScore = scoreMatch(query, candidate.title) * 0.18
    const pathScore = scoreMatch(query, candidate.path) * 0.1
    ranked.push({
      ...candidate,
      score: bodyScore + titleScore + pathScore
    })
  }
  ranked.sort((a, b) => b.score - a.score)
  return ranked.slice(0, limit)
}

async function runFzfSearch(
  query: string,
  candidates: VaultTextSearchCandidate[],
  limit: number,
  paths: Required<VaultTextSearchToolPaths>
): Promise<VaultTextSearchCandidate[]> {
  const fzf = await searchExecutable('fzf', paths)
  if (!fzf) {
    return rankSearchCandidates(query, candidates, limit).map(
      ({ score: _score, ...candidate }) => candidate
    )
  }
  return await new Promise((resolve, reject) => {
    const child = spawn(
      fzf,
      ['--filter', query, '--delimiter=\t', '--nth=1,2,5', '--tiebreak=index'],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    )

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0 && code !== 1) {
        reject(new Error(stderr.trim() || `fzf exited with code ${code ?? 'unknown'}`))
        return
      }
      const matches = stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(0, limit)
        .map((line) => {
          const [pathValue, title, folderValue, lineNumberValue, lineText] = line.split('\t')
          const folder = folderValue === 'quick' || folderValue === 'archive' ? folderValue : 'inbox'
          return {
            path: pathValue,
            title,
            folder,
            lineNumber: Number(lineNumberValue),
            lineText
          } as VaultTextSearchCandidate
        })
      if (matches.length > 0) {
        resolve(matches)
        return
      }
      resolve(
        rankSearchCandidates(query, candidates, limit).map(
          ({ score: _score, ...candidate }) => candidate
        )
      )
    })

    for (const candidate of candidates) {
      const row = [
        candidate.path.replace(/\t/g, ' '),
        candidate.title.replace(/\t/g, ' '),
        candidate.folder,
        String(candidate.lineNumber),
        candidate.lineText.replace(/\t/g, ' ')
      ].join('\t')
      child.stdin.write(`${row}\n`)
    }
    child.stdin.end()
  })
}

async function hydrateSearchOffsets(
  root: string,
  query: string,
  candidates: VaultTextSearchCandidate[]
): Promise<VaultTextSearchMatch[]> {
  const bodyCache = new Map<string, string>()
  return await Promise.all(
    candidates.map(async (candidate) => {
      if (typeof candidate.offset === 'number') {
        const rawPath = resolveSafe(root, candidate.path)
        let body = bodyCache.get(candidate.path)
        if (body == null) {
          body = await fs.readFile(rawPath, 'utf8')
          bodyCache.set(candidate.path, body)
        }
        const rawLine = body.split('\n')[candidate.lineNumber - 1] ?? ''
        return {
          path: candidate.path,
          title: candidate.title,
          folder: candidate.folder,
          lineNumber: candidate.lineNumber,
          offset: candidate.offset + Math.max(0, Math.min(firstMatchColumn(query, rawLine), rawLine.length)),
          lineText: candidate.lineText
        }
      }

      const abs = resolveSafe(root, candidate.path)
      let body = bodyCache.get(candidate.path)
      if (body == null) {
        body = await fs.readFile(abs, 'utf8')
        bodyCache.set(candidate.path, body)
      }
      const lines = body.split('\n')
      let lineOffset = 0
      for (let index = 0; index < candidate.lineNumber - 1; index += 1) {
        lineOffset += (lines[index] ?? '').length + 1
      }
      const rawLine = lines[candidate.lineNumber - 1] ?? ''
      return {
        path: candidate.path,
        title: candidate.title,
        folder: candidate.folder,
        lineNumber: candidate.lineNumber,
        offset: lineOffset + Math.max(0, Math.min(firstMatchColumn(query, rawLine), rawLine.length)),
        lineText: candidate.lineText
      }
    })
  )
}

async function readMeta(
  root: string,
  abs: string,
  folder: NoteFolder,
  siblingOrder?: number,
  isSymlink?: boolean
): Promise<NoteMeta> {
  const stat = await fs.stat(abs)
  const relPath = toPosix(path.relative(root, abs))
  const cacheKey = noteMetaCacheKey(root, abs)
  const cached = noteMetaCache.get(cacheKey)
  const resolvedSiblingOrder = siblingOrder ?? (await readSiblingOrder(abs))
  // stat() follows symlinks, so it can't tell us whether `abs` itself is a
  // link. The walk already knows from the readdir entry and passes it in;
  // fall back to lstat for callers that don't. Resolved fresh every call so
  // it can't go stale behind the body cache (like siblingOrder).
  let linked = isSymlink
  if (linked === undefined) {
    try {
      linked = (await fs.lstat(abs)).isSymbolicLink()
    } catch {
      linked = false
    }
  }
  if (
    cached &&
    sameMtimeMs(cached.mtimeMs, stat.mtimeMs) &&
    cached.size === stat.size &&
    cached.meta.path === relPath &&
    cached.meta.folder === folder
  ) {
    return { ...cached.meta, siblingOrder: resolvedSiblingOrder, isSymlink: linked }
  }

  // Excalidraw drawings are JSON, not Markdown — don't parse their body for
  // tags/links/excerpt (that would be garbage) or even read it for meta.
  if (isExcalidrawPath(relPath)) {
    const meta: NoteMeta = {
      path: relPath,
      title: path.basename(abs, path.extname(abs)),
      folder,
      siblingOrder: resolvedSiblingOrder,
      createdAt: stat.birthtimeMs || stat.ctimeMs,
      updatedAt: stat.mtimeMs,
      size: stat.size,
      tags: [],
      wikilinks: [],
      assetEmbeds: [],
      hasAttachments: false,
      excerpt: '',
      isSymlink: linked
    }
    noteMetaCache.set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size, meta })
    return meta
  }

  let body = ''
  try {
    body = await fs.readFile(abs, 'utf8')
  } catch {
    /* ignore — treat as empty */
  }
  const meta: NoteMeta = {
    path: relPath,
    title: path.basename(abs, path.extname(abs)),
    folder,
    siblingOrder: resolvedSiblingOrder,
    createdAt: stat.birthtimeMs || stat.ctimeMs,
    updatedAt: stat.mtimeMs,
    size: stat.size,
    tags: extractTags(body),
    wikilinks: extractWikilinks(body),
    assetEmbeds: extractAssetEmbeds(body),
    hasAttachments: bodyHasLocalAsset(body),
    excerpt: buildExcerpt(body),
    isSymlink: linked
  }
  noteMetaCache.set(cacheKey, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    meta
  })
  return meta
}

async function readSiblingOrder(abs: string): Promise<number> {
  try {
    const entries = await fs.readdir(path.dirname(abs), { withFileTypes: true })
    const name = path.basename(abs)
    const index = entries.findIndex((entry) => entry.name === name)
    return index === -1 ? Number.MAX_SAFE_INTEGER : index
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

async function mapLimit<T, U>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<U>
): Promise<U[]> {
  const results = new Array<U>(items.length)
  let nextIndex = 0

  const run = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await worker(items[index], index)
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => run()
  )
  await Promise.all(workers)
  return results
}

/**
 * Walk every directory under the three top-level folders and return a
 * flat list of folder entries. This is the source of truth for the
 * sidebar tree — empty folders that contain no notes are otherwise
 * invisible, because notes are the only things we track per-file.
 */
export async function listFolders(root: string): Promise<FolderEntry[]> {
  const out: FolderEntry[] = []
  for (const folder of FOLDERS) {
    const topAbs = await folderRoot(root, folder)
    const isPrimaryRoot = folder === 'inbox' && path.resolve(topAbs) === path.resolve(root)
    const topReal = await realpathOrResolve(topAbs)
    const ancestors = new Set<string>([topReal])
    const walk = async (dirAbs: string, dirReal: string, subpath: string): Promise<void> => {
      let entries: Dirent[]
      try {
        entries = await fs.readdir(dirAbs, { withFileTypes: true })
      } catch {
        return
      }
      for (const [index, e] of entries.entries()) {
        const full = path.join(dirAbs, e.name)
        const childReal = await resolveDirDescent(full, e, dirReal, ancestors)
        if (childReal === null) continue
        if (e.name.startsWith('.')) continue
        if (isPrimaryRoot && dirAbs === topAbs && shouldHidePrimaryRootEntry(e.name)) continue
        const nextSub = subpath ? `${subpath}/${e.name}` : e.name
        out.push({ folder, subpath: nextSub, siblingOrder: index, isSymlink: e.isSymbolicLink() })
        // A `<Name>.base` database folder is listed (the renderer shows it as a
        // database), but we don't descend — its data.csv/schema.json internals
        // aren't folders, and its record-page notes are surfaced via listNotes.
        if (isFormDirName(e.name)) continue
        ancestors.add(childReal)
        await walk(full, childReal, nextSub)
        ancestors.delete(childReal)
      }
    }
    await walk(topAbs, topReal, '')
  }
  return out
}

export async function listNotes(root: string): Promise<NoteMeta[]> {
  const startedAt = performance.now()
  await hydratePersistedNoteMetaCache(root)
  const noteFiles: Array<{
    full: string
    folder: NoteFolder
    siblingOrder: number
    isSymlink: boolean
  }> = []
  const walkFolder = async (
    folder: NoteFolder,
    dirAbs: string,
    dirReal: string,
    topAbs: string,
    isPrimaryRoot: boolean,
    ancestors: Set<string>
  ): Promise<void> => {
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true })
    } catch {
      return
    }
    for (const [index, entry] of entries.entries()) {
      const full = path.join(dirAbs, entry.name)
      const childReal = await resolveDirDescent(full, entry, dirReal, ancestors)
      if (childReal !== null) {
        if (entry.name.startsWith('.')) continue
        if (isPrimaryRoot && dirAbs === topAbs && shouldHidePrimaryRootEntry(entry.name)) continue
        ancestors.add(childReal)
        await walkFolder(folder, full, childReal, topAbs, isPrimaryRoot, ancestors)
        ancestors.delete(childReal)
        continue
      }
      if (
        (await isMarkdownNoteEntry(full, entry)) ||
        (await isExcalidrawFileEntry(full, entry))
      ) {
        noteFiles.push({ full, folder, siblingOrder: index, isSymlink: entry.isSymbolicLink() })
      }
    }
  }

  for (const folder of FOLDERS) {
    const topAbs = await folderRoot(root, folder)
    const isPrimaryRoot = folder === 'inbox' && path.resolve(topAbs) === path.resolve(root)
    const topReal = await realpathOrResolve(topAbs)
    await walkFolder(folder, topAbs, topReal, topAbs, isPrimaryRoot, new Set([topReal]))
  }

  const metas = (
    await mapLimit(noteFiles, NOTE_META_READ_CONCURRENCY, async (file) => {
      try {
        return await readMeta(root, file.full, file.folder, file.siblingOrder, file.isSymlink)
      } catch {
        return null
      }
    })
  ).filter((meta): meta is NoteMeta => meta !== null)

  recordMainPerf('main.vault.listNotes', performance.now() - startedAt, {
    notes: metas.length
  })
  schedulePersistNoteMetaCache(root, metas)
  return metas
}

export async function searchVaultText(
  root: string,
  query: string,
  preferredBackend: VaultTextSearchBackendPreference = 'auto',
  rawPaths: VaultTextSearchToolPaths = {},
  limit = 80
): Promise<VaultTextSearchMatch[]> {
  const trimmed = query.trim()
  if (!trimmed) return []
  const paths = normalizeVaultTextSearchToolPaths(rawPaths)
  const capabilities = await searchVaultTextCapabilities(paths)
  const backend = resolveSearchBackend(preferredBackend, capabilities)

  if (backend === 'builtin') {
    const candidates = await getCachedVaultTextSearchCandidates(root, 'builtin', paths, () =>
      collectBuiltinSearchCandidates(root)
    )
    const ranked = rankSearchCandidates(trimmed, candidates, limit)
    return await hydrateSearchOffsets(root, trimmed, ranked)
  }

  if (backend === 'ripgrep') {
    const candidates = await getCachedVaultTextSearchCandidates(root, 'ripgrep', paths, () =>
      collectRipgrepSearchCandidates(root, paths)
    )
    const ranked = rankSearchCandidates(
      trimmed,
      candidates,
      limit
    )
    return await hydrateSearchOffsets(root, trimmed, ranked)
  }

  const candidates = capabilities.ripgrep
    ? await getCachedVaultTextSearchCandidates(root, 'ripgrep', paths, () =>
        collectRipgrepSearchCandidates(root, paths)
      )
    : await getCachedVaultTextSearchCandidates(root, 'builtin', paths, () =>
        collectBuiltinSearchCandidates(root)
      )
  const ranked = await runFzfSearch(trimmed, candidates, limit, paths)
  return await hydrateSearchOffsets(root, trimmed, ranked)
}

function resolveSafe(root: string, rel: string): string {
  const abs = path.resolve(root, rel)
  const rootAbs = path.resolve(root)
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new Error(`Path escapes vault: ${rel}`)
  }
  return abs
}

export async function readNote(root: string, rel: string): Promise<NoteContent> {
  const abs = resolveSafe(root, rel)
  const folder = folderOf(root, abs)
  if (!folder) throw new Error(`Note not in a known folder: ${rel}`)
  const body = await fs.readFile(abs, 'utf8')
  const meta = await readMeta(root, abs, folder)
  return { ...meta, body }
}

export async function writeNote(root: string, rel: string, body: string): Promise<NoteMeta> {
  const abs = resolveSafe(root, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, body, 'utf8')
  invalidateNoteMetaCache(root, rel)
  invalidateVaultTextSearchCache(root)
  const folder = folderOf(root, abs)
  if (!folder) throw new Error(`Note not in a known folder: ${rel}`)
  return await readMeta(root, abs, folder)
}

function normalizeNoteComment(input: NoteCommentInput, notePath: string): NoteComment | null {
  const body = typeof input.body === 'string' ? input.body.trim() : ''
  if (!body) return null
  const now = Date.now()
  const rawStart = Number.isFinite(input.anchorStart) ? Math.max(0, Math.floor(input.anchorStart)) : 0
  const rawEnd = Number.isFinite(input.anchorEnd) ? Math.max(0, Math.floor(input.anchorEnd)) : rawStart
  const anchorStart = Math.min(rawStart, rawEnd)
  const anchorEnd = Math.max(rawStart, rawEnd)
  const anchorText =
    typeof input.anchorText === 'string'
      ? input.anchorText.replace(/\s+/g, ' ').trim().slice(0, 500)
      : ''
  return {
    id: typeof input.id === 'string' && input.id.trim() ? input.id.trim() : randomUUID(),
    notePath,
    anchorStart,
    anchorEnd,
    anchorText,
    body,
    createdAt:
      typeof input.createdAt === 'number' && Number.isFinite(input.createdAt)
        ? input.createdAt
        : now,
    updatedAt:
      typeof input.updatedAt === 'number' && Number.isFinite(input.updatedAt)
        ? input.updatedAt
        : now,
    resolvedAt:
      typeof input.resolvedAt === 'number' && Number.isFinite(input.resolvedAt)
        ? input.resolvedAt
        : null
  }
}

function normalizeNoteComments(raw: unknown, notePath: string): NoteComment[] {
  const values = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { comments?: unknown }).comments)
      ? (raw as { comments: unknown[] }).comments
      : []
  const seen = new Set<string>()
  const comments: NoteComment[] = []
  for (const value of values) {
    if (!value || typeof value !== 'object') continue
    const comment = normalizeNoteComment(value as NoteCommentInput, notePath)
    if (!comment || seen.has(comment.id)) continue
    seen.add(comment.id)
    comments.push(comment)
  }
  comments.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  return comments
}

export async function readNoteComments(root: string, rel: string): Promise<NoteComment[]> {
  const notePath = toPosix(rel)
  const abs = noteCommentsPath(root, notePath)
  try {
    const raw = await fs.readFile(abs, 'utf8')
    return normalizeNoteComments(JSON.parse(raw), notePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    if (err instanceof SyntaxError) return []
    throw err
  }
}

export async function writeNoteComments(
  root: string,
  rel: string,
  comments: NoteCommentInput[]
): Promise<NoteComment[]> {
  const notePath = toPosix(rel)
  const normalized = normalizeNoteComments(comments, notePath)
  const abs = noteCommentsPath(root, notePath)
  if (normalized.length === 0) {
    await fs.rm(abs, { force: true })
    return []
  }
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, JSON.stringify({ version: 1, comments: normalized }, null, 2), 'utf8')
  return normalized
}

async function removeNoteComments(root: string, rel: string): Promise<void> {
  await fs.rm(noteCommentsPath(root, rel), { force: true })
}

async function moveNoteComments(root: string, oldRel: string, nextRel: string): Promise<void> {
  const oldAbs = noteCommentsPath(root, oldRel)
  const nextAbs = noteCommentsPath(root, nextRel)
  if (oldAbs === nextAbs) return
  try {
    await fs.access(oldAbs)
  } catch {
    return
  }
  await fs.mkdir(path.dirname(nextAbs), { recursive: true })
  try {
    await fs.access(nextAbs)
    const [existing, moving] = await Promise.all([
      readNoteComments(root, nextRel),
      readNoteComments(root, oldRel)
    ])
    await writeNoteComments(root, nextRel, [...existing, ...moving])
    await fs.rm(oldAbs, { force: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    await fs.rename(oldAbs, nextAbs)
  }
}

async function copyNoteComments(root: string, sourceRel: string, nextRel: string): Promise<void> {
  const source = await readNoteComments(root, sourceRel)
  if (source.length === 0) return
  const now = Date.now()
  await writeNoteComments(
    root,
    nextRel,
    source.map((comment) => ({
      ...comment,
      id: randomUUID(),
      notePath: nextRel,
      createdAt: now,
      updatedAt: now
    }))
  )
}

export async function appendToNote(
  root: string,
  rel: string,
  body: string,
  position: 'start' | 'end'
): Promise<NoteMeta> {
  const abs = resolveSafe(root, rel)
  const folder = folderOf(root, abs)
  if (!folder) throw new Error(`Note not in a known folder: ${rel}`)
  const existing = await fs.readFile(abs, 'utf8')
  const trimmedAddition = body.replace(/\s+$/u, '')
  if (!trimmedAddition) return await readMeta(root, abs, folder)
  const next =
    position === 'end'
      ? `${existing}${existing.endsWith('\n') ? '' : '\n'}\n${trimmedAddition}\n`
      : `${trimmedAddition}\n\n${existing}`
  await fs.writeFile(abs, next, 'utf8')
  invalidateNoteMetaCache(root, rel)
  invalidateVaultTextSearchCache(root)
  return await readMeta(root, abs, folder)
}

export async function uniqueTitle(dir: string, baseTitle: string): Promise<string> {
  let candidate = baseTitle
  let n = 1
  while (true) {
    try {
      await fs.access(path.join(dir, `${candidate}.md`))
      n += 1
      candidate = `${baseTitle} ${n}`
    } catch {
      return candidate
    }
  }
}

async function uniqueFilename(dir: string, filename: string): Promise<string> {
  const ext = path.extname(filename)
  const base = path.basename(filename, ext)
  let candidate = filename
  let n = 2
  while (true) {
    try {
      await fs.access(path.join(dir, candidate))
      candidate = `${base} ${n}${ext}`
      n += 1
    } catch {
      return candidate
    }
  }
}

function classifyImportedAsset(filename: string): ImportedAssetKind {
  const ext = path.extname(filename).toLowerCase()
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (PDF_EXTENSIONS.has(ext)) return 'pdf'
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio'
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  return 'file'
}

async function assetMetaForPath(root: string, abs: string): Promise<AssetMeta> {
  const stat = await fs.stat(abs)
  const rel = toPosix(path.relative(root, abs))
  return {
    path: rel,
    name: path.basename(abs),
    kind: classifyImportedAsset(abs),
    siblingOrder: 0,
    size: stat.size,
    updatedAt: stat.mtimeMs
  }
}

async function assertAssetFile(root: string, rel: string): Promise<{ rel: string; abs: string }> {
  const normalized = normalizeVaultRelativePath(rel)
  if (!normalized) throw new Error('Asset path is required.')
  if (normalized.split('/').includes(INTERNAL_VAULT_DIR)) {
    throw new Error('Cannot modify internal ZenNotes files.')
  }
  if (path.extname(normalized).toLowerCase() === '.md') {
    throw new Error('Use note actions to modify markdown notes.')
  }
  const abs = resolveSafe(root, normalized)
  const info = await fs.stat(abs)
  if (!info.isFile()) throw new Error('Asset path is not a file.')
  return { rel: normalized, abs }
}

function cleanAssetFilename(name: string): string {
  const raw = name.trim()
  if (/[\\/]/.test(raw)) throw new Error('Use only a file name.')
  const trimmed = path.basename(raw)
  if (!trimmed || trimmed === '.' || trimmed === '..') throw new Error('Asset name is required.')
  if (path.extname(trimmed).toLowerCase() === '.md') {
    throw new Error('Use note actions for markdown notes.')
  }
  return trimmed
}

function cleanAssetTargetDir(root: string, targetDir: string): string {
  const normalized = normalizeVaultRelativePath(targetDir).replace(/^\/+|\/+$/g, '')
  // No explicit target → the unified `assets/` folder (not loose at the root).
  if (!normalized) return resolveSafe(root, ASSETS_DIR)
  if (normalized.split('/').includes(INTERNAL_VAULT_DIR)) {
    throw new Error('Cannot move assets into internal ZenNotes files.')
  }
  return resolveSafe(root, normalized)
}

function cleanDeletedAssetPath(rel: string): string {
  const normalized = normalizeVaultRelativePath(rel)
  if (!normalized) throw new Error('Deleted asset path is required.')
  if (normalized.split('/').includes(INTERNAL_VAULT_DIR)) {
    throw new Error('Cannot restore internal ZenNotes files.')
  }
  if (path.extname(normalized).toLowerCase() === '.md') {
    throw new Error('Use note actions to restore markdown notes.')
  }
  return normalized
}

function cleanDeletedAssetToken(token: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(token)) {
    throw new Error('Deleted asset restore token is invalid.')
  }
  return token
}

function markdownForImportedAsset(
  relativeFromNote: string,
  filename: string,
  kind: ImportedAssetKind
): string {
  const destination = markdownDestination(relativeFromNote)
  if (kind === 'image') {
    return `![${path.basename(filename, path.extname(filename))}](${destination})`
  }
  return `[${filename}](${destination})`
}

function padPastedImageDatePart(value: number): string {
  return String(value).padStart(2, '0')
}

function pastedImageTimestamp(now: Date): string {
  const date = [
    now.getFullYear(),
    padPastedImageDatePart(now.getMonth() + 1),
    padPastedImageDatePart(now.getDate())
  ].join('-')
  const time = [
    padPastedImageDatePart(now.getHours()),
    padPastedImageDatePart(now.getMinutes()),
    padPastedImageDatePart(now.getSeconds())
  ].join('')
  return `${date} ${time}`
}

function pastedImageExtension(input: Pick<PastedImageInput, 'mimeType' | 'suggestedName'>): string {
  const suggestedExt = path.extname(input.suggestedName ?? '').toLowerCase()
  if (IMAGE_EXTENSIONS.has(suggestedExt)) return suggestedExt

  const mimeExt = PASTED_IMAGE_MIME_EXTENSIONS[input.mimeType.toLowerCase()]
  if (mimeExt) return mimeExt
  if (input.mimeType.toLowerCase().startsWith('image/')) return '.png'
  throw new Error('Clipboard item is not an image.')
}

function pastedImageFilename(input: Pick<PastedImageInput, 'mimeType' | 'suggestedName'>, now: Date): string {
  const ext = pastedImageExtension(input)
  const rawName = path.basename(input.suggestedName ?? '')
  const nameExt = path.extname(rawName)
  const rawBase = nameExt ? path.basename(rawName, nameExt) : rawName
  const base = rawBase
    .replace(/[\\/:%*?"<>|\[\]#^]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
  const fallbackBase = `Pasted Image ${pastedImageTimestamp(now)}`
  const finalBase = base && base !== '.' && base !== '..' ? base : fallbackBase
  return `${finalBase}${ext}`
}

function pastedImageBuffer(data: PastedImageInput['data']): Buffer {
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  }
  throw new Error('Clipboard image data is invalid.')
}

/**
 * Make a title safe to use as a filename on macOS, Windows, and Linux:
 * strip path separators, control chars, and reserved characters so a title
 * like "RFC / Design Doc" cannot escape into a nonexistent subdirectory.
 */
export function sanitizeNoteTitle(raw: string | undefined): string {
  return (
    (raw ?? '')
      .replace(/[\\/:\u0000-\u001f*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200) || 'Untitled'
  )
}

export async function createNote(
  root: string,
  folder: NoteFolder,
  title?: string,
  subpath = ''
): Promise<NoteMeta> {
  const base = sanitizeNoteTitle(title)
  const clean = subpath.replace(/^\/+|\/+$/g, '')
  const topRoot = await folderRoot(root, folder)
  const dir = clean ? resolveSafe(topRoot, clean) : topRoot
  await fs.mkdir(dir, { recursive: true })
  const finalTitle = await uniqueTitle(dir, base)
  const abs = path.join(dir, `${finalTitle}.md`)
  const body = `# ${finalTitle}\n\n`
  await fs.writeFile(abs, body, 'utf8')
  invalidateNoteMetaCache(root, toPosix(path.relative(root, abs)))
  invalidateVaultTextSearchCache(root)
  return await readMeta(root, abs, folder)
}

// Create a new `.excalidraw` drawing seeded with an empty scene. Mirrors
// createNote (unique title, same folder/subpath resolution) but writes the
// Excalidraw JSON instead of a Markdown stub.
export async function createExcalidraw(
  root: string,
  folder: NoteFolder,
  subpath = '',
  title?: string
): Promise<NoteMeta> {
  const base = sanitizeNoteTitle(title) || 'Untitled drawing'
  const clean = subpath.replace(/^\/+|\/+$/g, '')
  const topRoot = await folderRoot(root, folder)
  const dir = clean ? resolveSafe(topRoot, clean) : topRoot
  await fs.mkdir(dir, { recursive: true })
  let finalTitle = base
  for (let n = 2; ; n++) {
    try {
      await fs.access(path.join(dir, `${finalTitle}.excalidraw`))
      finalTitle = `${base} ${n}`
    } catch {
      break
    }
  }
  const abs = path.join(dir, `${finalTitle}.excalidraw`)
  await fs.writeFile(abs, JSON.stringify(emptyExcalidrawDocument(), null, 2), 'utf8')
  invalidateNoteMetaCache(root, toPosix(path.relative(root, abs)))
  return await readMeta(root, abs, folder)
}

/**
 * Convert an Obsidian Excalidraw markdown drawing (`*.excalidraw.md`, or a `.md`
 * carrying `excalidraw-plugin` frontmatter) into a native `.excalidraw` file so
 * it renders in ZenNotes' drawing editor. Non-destructive: the original markdown
 * is left in place. Returns the new drawing's metadata. (#266)
 */
export async function convertObsidianExcalidraw(root: string, rel: string): Promise<NoteMeta> {
  const abs = resolveSafe(root, rel)
  const folder = folderOf(root, abs)
  if (!folder) throw new Error(`Drawing is not in a known folder: ${rel}`)
  const markdown = await fs.readFile(abs, 'utf8')
  if (!isObsidianExcalidrawPath(rel) && !isObsidianExcalidrawMarkdown(markdown)) {
    throw new Error('This file is not an Obsidian Excalidraw drawing.')
  }
  const scene = extractObsidianExcalidrawScene(markdown)
  if (!scene) {
    throw new Error('Could not read an Excalidraw scene from this file.')
  }

  const fileName = path.basename(abs)
  const base =
    (fileName.toLowerCase().endsWith('.excalidraw.md')
      ? fileName.slice(0, -'.excalidraw.md'.length)
      : path.basename(fileName, path.extname(fileName))) || 'Untitled drawing'
  const dir = path.dirname(abs)
  let finalTitle = base
  for (let n = 2; ; n++) {
    try {
      await fs.access(path.join(dir, `${finalTitle}.excalidraw`))
      finalTitle = `${base} ${n}`
    } catch {
      break
    }
  }
  const destAbs = path.join(dir, `${finalTitle}.excalidraw`)
  await fs.writeFile(destAbs, JSON.stringify(scene, null, 2), 'utf8')
  invalidateNoteMetaCache(root, toPosix(path.relative(root, destAbs)))
  return await readMeta(root, destAbs, folder)
}

/**
 * Move a markdown file that lives outside the vault into the vault's
 * primary notes area, de-duplicating the title on collision. The source
 * file is removed once copied. Returns the new note's metadata.
 */
export async function importExternalNote(root: string, sourceAbsPath: string): Promise<NoteMeta> {
  const source = path.resolve(sourceAbsPath)
  const destDir = await folderRoot(root, 'inbox')
  await fs.mkdir(destDir, { recursive: true })
  const baseTitle = path.basename(source, path.extname(source)) || 'Untitled'
  const finalTitle = await uniqueTitle(destDir, baseTitle)
  const destAbs = path.join(destDir, `${finalTitle}.md`)
  const body = await fs.readFile(source, 'utf8')
  await fs.writeFile(destAbs, body, 'utf8')
  await fs.rm(source, { force: true })
  const rel = toPosix(path.relative(root, destAbs))
  invalidateNoteMetaCache(root, rel)
  invalidateVaultTextSearchCache(root)
  return await readMeta(root, destAbs, folderForRelativePath(rel) ?? 'inbox')
}

export async function renameNote(
  root: string,
  rel: string,
  nextTitle: string
): Promise<NoteMeta> {
  const abs = resolveSafe(root, rel)
  const folder = folderOf(root, abs)
  if (!folder) throw new Error(`Note not in a known folder: ${rel}`)
  const dir = path.dirname(abs)
  const trimmed = sanitizeNoteTitle(nextTitle)
  // Preserve the file's type on rename — a `.excalidraw` drawing must stay a
  // drawing, not get turned into a `.md` note (which would render its JSON).
  const ext = isExcalidrawPath(abs) ? '.excalidraw' : '.md'
  const target = path.join(dir, `${trimmed}${ext}`)
  const willRename = target !== abs
  // Snapshot the vault before the rename so inbound [[wikilinks]] still
  // resolve to this note under its current name; we rewrite them afterwards.
  const notesBefore = willRename ? await listNotes(root) : []
  if (willRename) {
    // Check for conflicts, but allow case-only renames on case-insensitive FS
    try {
      await fs.access(target)
      const [srcStat, dstStat] = await Promise.all([fs.stat(abs), fs.stat(target)])
      if (srcStat.ino !== dstStat.ino) {
        throw new Error(`A note named "${trimmed}" already exists in ${folder}`)
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    // Two-step rename for case-only changes on case-insensitive filesystems
    if (abs.toLowerCase() === target.toLowerCase() && abs !== target) {
      const tmp = abs + '_rename_tmp_' + Date.now()
      await fs.rename(abs, tmp)
      await fs.rename(tmp, target)
    } else {
      await fs.rename(abs, target)
    }
  }
  const meta = await readMeta(root, target, folder)
  await moveNoteComments(root, rel, meta.path)
  invalidateNoteMetaCache(root, rel)
  invalidateNoteMetaCache(root, meta.path)
  invalidateVaultTextSearchCache(root)
  if (willRename) {
    await updateInboundWikilinks(root, notesBefore, rel, meta.title)
  }
  return meta
}

/**
 * Rewrite every `[[wikilink]]` across the vault that pointed to a note's old
 * name so it points to the new one. `notesBefore` is the pre-rename snapshot
 * (the renamed note still under `oldPath`), used so links resolve to what they
 * currently target. Only notes that actually link to it are read and rewritten.
 */
async function updateInboundWikilinks(
  root: string,
  notesBefore: NoteMeta[],
  oldPath: string,
  newTitle: string
): Promise<void> {
  const refs: RenameNoteRef[] = notesBefore.map((n) => ({
    path: n.path,
    title: n.title,
    folder: n.folder
  }))
  const candidates = notesBefore.filter(
    (n) =>
      n.path !== oldPath &&
      n.folder !== 'trash' &&
      (n.wikilinks ?? []).some((t) => resolveWikilinkTarget(refs, t)?.path === oldPath)
  )
  for (const candidate of candidates) {
    try {
      const content = await readNote(root, candidate.path)
      const { body, changed } = rewriteWikilinksForRename(content.body, refs, oldPath, newTitle)
      if (changed > 0) await writeNote(root, candidate.path, body)
    } catch (err) {
      console.error('updateInboundWikilinks: failed for', candidate.path, err)
    }
  }
}

/**
 * The note's directory relative to its top-level folder root ('' when
 * it sits at the folder root). Carried along on archive/trash moves so
 * the reverse move puts the note back in the subfolder it came from.
 */
async function folderSubpathOf(root: string, abs: string): Promise<string> {
  const folder = folderOf(root, abs)
  if (!folder) return ''
  const sourceRoot = await folderRoot(root, folder)
  const relDir = path.relative(sourceRoot, path.dirname(abs))
  if (!relDir || relDir.startsWith('..') || path.isAbsolute(relDir)) return ''
  return toPosix(relDir)
}

async function moveBetweenFolders(
  root: string,
  rel: string,
  target: NoteFolder
): Promise<NoteMeta> {
  const abs = resolveSafe(root, rel)
  const filename = path.basename(abs)
  // Mirror the source subfolder in the destination: archiving
  // inbox/demo/X.md lands at archive/demo/X.md, so unarchiving (or
  // restoring from trash) returns it to demo/ instead of the top level.
  const subpath = await folderSubpathOf(root, abs)
  const targetRoot = await folderRoot(root, target)
  const destDir = subpath ? resolveSafe(targetRoot, subpath) : targetRoot
  await fs.mkdir(destDir, { recursive: true })
  const baseTitle = path.basename(filename, path.extname(filename))
  const finalTitle = await uniqueTitle(destDir, baseTitle)
  // Preserve the file type when moving (a `.excalidraw` drawing stays a drawing).
  const ext = isExcalidrawPath(filename) ? '.excalidraw' : '.md'
  const destAbs = path.join(destDir, `${finalTitle}${ext}`)
  await fs.rename(abs, destAbs)
  const meta = await readMeta(root, destAbs, target)
  await moveNoteComments(root, rel, meta.path)
  invalidateNoteMetaCache(root, rel)
  invalidateNoteMetaCache(root, meta.path)
  invalidateVaultTextSearchCache(root)
  return meta
}

export function moveToTrash(root: string, rel: string): Promise<NoteMeta> {
  return moveBetweenFolders(root, rel, 'trash')
}

export function restoreFromTrash(root: string, rel: string): Promise<NoteMeta> {
  return moveBetweenFolders(root, rel, 'inbox')
}

export function archiveNote(root: string, rel: string): Promise<NoteMeta> {
  return moveBetweenFolders(root, rel, 'archive')
}

export function unarchiveNote(root: string, rel: string): Promise<NoteMeta> {
  return moveBetweenFolders(root, rel, 'inbox')
}

export async function emptyTrash(root: string): Promise<void> {
  const trashDir = path.join(root, 'trash')
  try {
    const entries = await fs.readdir(trashDir)
    await Promise.all(entries.map((e) => removeNoteComments(root, `trash/${e}`)))
    await Promise.all(
      entries.map((e) => fs.rm(path.join(trashDir, e), { recursive: true, force: true }))
    )
    invalidateNoteMetaCache(root)
    invalidateVaultTextSearchCache(root)
  } catch {
    /* no trash dir yet */
  }
}

export async function deleteNote(root: string, rel: string): Promise<void> {
  const abs = resolveSafe(root, rel)
  await fs.rm(abs, { force: true })
  await removeNoteComments(root, rel)
  invalidateNoteMetaCache(root, rel)
  invalidateVaultTextSearchCache(root)
}

export async function renameAsset(
  root: string,
  rel: string,
  nextName: string
): Promise<AssetMeta> {
  const source = await assertAssetFile(root, rel)
  const cleanName = cleanAssetFilename(nextName)
  const destAbs = path.join(path.dirname(source.abs), cleanName)
  if (destAbs !== source.abs) {
    try {
      await fs.access(destAbs)
      const [srcStat, dstStat] = await Promise.all([fs.stat(source.abs), fs.stat(destAbs)])
      if (srcStat.ino !== dstStat.ino) {
        throw new Error(`An asset named "${cleanName}" already exists in this folder.`)
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    if (source.abs.toLowerCase() === destAbs.toLowerCase() && source.abs !== destAbs) {
      const tmp = `${source.abs}_rename_tmp_${Date.now()}`
      await fs.rename(source.abs, tmp)
      await fs.rename(tmp, destAbs)
    } else {
      await fs.rename(source.abs, destAbs)
    }
  }
  return await assetMetaForPath(root, destAbs)
}

export async function moveAsset(
  root: string,
  rel: string,
  targetDir: string
): Promise<AssetMeta> {
  const source = await assertAssetFile(root, rel)
  const destDir = cleanAssetTargetDir(root, targetDir)
  await fs.mkdir(destDir, { recursive: true })
  if (path.resolve(destDir) === path.dirname(source.abs)) return await assetMetaForPath(root, source.abs)
  const finalName = await uniqueFilename(destDir, path.basename(source.abs))
  const destAbs = path.join(destDir, finalName)
  if (destAbs !== source.abs) await fs.rename(source.abs, destAbs)
  return await assetMetaForPath(root, destAbs)
}

export async function duplicateAsset(root: string, rel: string): Promise<AssetMeta> {
  const source = await assertAssetFile(root, rel)
  const ext = path.extname(source.abs)
  const base = path.basename(source.abs, ext)
  const finalName = await uniqueFilename(path.dirname(source.abs), `${base} copy${ext}`)
  const destAbs = path.join(path.dirname(source.abs), finalName)
  await fs.copyFile(source.abs, destAbs)
  return await assetMetaForPath(root, destAbs)
}

export async function deleteAsset(root: string, rel: string): Promise<DeletedAsset> {
  const source = await assertAssetFile(root, rel)
  const undoToken = randomUUID()
  const trashDir = resolveSafe(root, `${INTERNAL_VAULT_DIR}/${DELETED_ASSETS_DIR}/${undoToken}`)
  await fs.mkdir(trashDir, { recursive: true })
  const name = path.basename(source.abs)
  const deletedAt = new Date().toISOString()
  await fs.rename(source.abs, path.join(trashDir, name))
  // Persist the original location so the asset can be listed + restored from the
  // Trash view even after a restart (not just via the in-session undo stack).
  await fs.writeFile(
    path.join(trashDir, DELETED_ASSET_META),
    JSON.stringify({ path: source.rel, name, deletedAt }, null, 2),
    'utf8'
  )
  return { path: source.rel, name, undoToken, deletedAt }
}

/** Enumerate assets in the deleted-assets store that carry restore metadata,
 *  newest first. Entries without metadata (pre-2.11 deletes) are skipped. */
export async function listDeletedAssets(root: string): Promise<DeletedAsset[]> {
  const baseDir = resolveSafe(root, `${INTERNAL_VAULT_DIR}/${DELETED_ASSETS_DIR}`)
  let tokens: string[]
  try {
    tokens = await fs.readdir(baseDir)
  } catch {
    return []
  }
  const out: DeletedAsset[] = []
  for (const undoToken of tokens) {
    try {
      const raw = await fs.readFile(path.join(baseDir, undoToken, DELETED_ASSET_META), 'utf8')
      const meta = JSON.parse(raw) as { path?: unknown; name?: unknown; deletedAt?: unknown }
      if (typeof meta.path !== 'string' || typeof meta.name !== 'string') continue
      // The asset file itself must still be present to be restorable.
      await fs.access(path.join(baseDir, undoToken, meta.name))
      out.push({
        path: meta.path,
        name: meta.name,
        undoToken,
        deletedAt: typeof meta.deletedAt === 'string' ? meta.deletedAt : undefined
      })
    } catch {
      // Missing/invalid metadata or file — not listable from the Trash view.
    }
  }
  out.sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''))
  return out
}

/** Permanently delete one asset from the deleted-assets store. */
export async function purgeDeletedAsset(root: string, undoToken: string): Promise<void> {
  const token = cleanDeletedAssetToken(undoToken)
  const trashDir = resolveSafe(root, `${INTERNAL_VAULT_DIR}/${DELETED_ASSETS_DIR}/${token}`)
  await fs.rm(trashDir, { recursive: true, force: true })
}

/** Permanently delete every asset in the deleted-assets store. */
export async function emptyDeletedAssets(root: string): Promise<void> {
  const baseDir = resolveSafe(root, `${INTERNAL_VAULT_DIR}/${DELETED_ASSETS_DIR}`)
  await fs.rm(baseDir, { recursive: true, force: true }).catch(() => {})
}

export async function restoreDeletedAsset(root: string, deleted: DeletedAsset): Promise<AssetMeta> {
  const targetRel = cleanDeletedAssetPath(deleted.path)
  const name = cleanAssetFilename(deleted.name)
  const undoToken = cleanDeletedAssetToken(deleted.undoToken)
  const trashDir = resolveSafe(root, `${INTERNAL_VAULT_DIR}/${DELETED_ASSETS_DIR}/${undoToken}`)
  const sourceAbs = path.join(trashDir, name)
  const targetAbs = resolveSafe(root, targetRel)
  const targetDir = path.dirname(targetAbs)
  await fs.mkdir(targetDir, { recursive: true })
  const finalName = await uniqueFilename(targetDir, path.basename(targetAbs))
  const finalAbs = path.join(targetDir, finalName)
  await fs.rename(sourceAbs, finalAbs)
  await fs.rm(trashDir, { recursive: true, force: true })
  return await assetMetaForPath(root, finalAbs)
}

/* ---------- Folder operations ---------------------------------------- */

/**
 * Create a subfolder at `{topFolder}/{subpath}`. Missing parents are
 * created recursively (so the caller can pass `Work/Research/2026`
 * and it just works).
 */
export async function createFolder(
  root: string,
  topFolder: NoteFolder,
  subpath: string
): Promise<void> {
  const trimmed = subpath.replace(/^\/+|\/+$/g, '')
  if (!trimmed) throw new Error('Folder name is required')
  const abs = resolveSafe(await folderRoot(root, topFolder), trimmed)
  await fs.mkdir(abs, { recursive: true })
}

/**
 * Rename or move a subfolder. `newSubpath` is the full target path
 * relative to `{topFolder}` — e.g. rename `Work/Research` → `Projects/Research`
 * also moves it into `Projects`. Refuses to move into itself or a
 * descendant, and refuses to touch the top-level folder.
 */
export async function renameFolder(
  root: string,
  topFolder: NoteFolder,
  oldSubpath: string,
  newSubpath: string
): Promise<string> {
  const oldClean = oldSubpath.replace(/^\/+|\/+$/g, '')
  const newClean = newSubpath.replace(/^\/+|\/+$/g, '')
  if (!oldClean) throw new Error('Cannot rename the top-level folder')
  if (!newClean) throw new Error('Target folder name is required')

  const topRoot = await folderRoot(root, topFolder)
  const oldAbs = resolveSafe(topRoot, oldClean)
  const newAbs = resolveSafe(topRoot, newClean)
  if (newAbs === oldAbs) return newClean

  const sep = path.sep
  if ((newAbs + sep).startsWith(oldAbs + sep)) {
    throw new Error('Cannot move a folder into itself')
  }

  // Refuse to overwrite a different existing folder.
  // On case-insensitive filesystems (macOS), a case-only rename
  // (e.g. "Work" → "work") is fine — same underlying directory.
  try {
    await fs.access(newAbs)
    // Check if old and new are the same file (case-only rename)
    const [oldStat, newStat] = await Promise.all([fs.stat(oldAbs), fs.stat(newAbs)])
    if (oldStat.ino !== newStat.ino) {
      throw new Error(`A folder already exists at "${newClean}"`)
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }

  await fs.mkdir(path.dirname(newAbs), { recursive: true })
  // On case-insensitive filesystems, a direct rename('AI','ai') may
  // not change the case. Use a two-step rename via a temp name.
  if (oldAbs.toLowerCase() === newAbs.toLowerCase() && oldAbs !== newAbs) {
    const tmpAbs = oldAbs + '_rename_tmp_' + Date.now()
    await fs.rename(oldAbs, tmpAbs)
    await fs.rename(tmpAbs, newAbs)
  } else {
    await fs.rename(oldAbs, newAbs)
  }
  const settings = await getVaultSettings(root)
  const nextSettings: VaultSettings = {
    ...settings,
    folderIcons: rewriteFolderIconsForRename(
      settings.folderIcons,
      topFolder,
      oldClean,
      newClean
    ),
    folderColors: rewriteFolderColorsForRename(
      settings.folderColors,
      topFolder,
      oldClean,
      newClean
    )
  }
  await setVaultSettings(root, nextSettings)
  invalidateNoteMetaCache(root)
  invalidateVaultTextSearchCache(root)
  return newClean
}

/**
 * Delete a subfolder and everything inside. Refuses to touch the
 * top-level `inbox`/`archive`/`trash` folders themselves.
 */
export async function deleteFolder(
  root: string,
  topFolder: NoteFolder,
  subpath: string
): Promise<void> {
  const clean = subpath.replace(/^\/+|\/+$/g, '')
  if (!clean) throw new Error('Cannot delete the top-level folder')
  const abs = resolveSafe(await folderRoot(root, topFolder), clean)
  await fs.rm(abs, { recursive: true, force: true })
  const settings = await getVaultSettings(root)
  const nextSettings: VaultSettings = {
    ...settings,
    folderIcons: removeFolderIcons(settings.folderIcons, topFolder, clean),
    folderColors: removeFolderColors(settings.folderColors, topFolder, clean)
  }
  await setVaultSettings(root, nextSettings)
  invalidateNoteMetaCache(root)
  invalidateVaultTextSearchCache(root)
}

/**
 * Duplicate a subfolder (recursively, with all its contents) next to
 * itself, appending " copy" (and " copy 2", " copy 3" on conflict) to
 * the leaf name.
 */
export async function duplicateFolder(
  root: string,
  topFolder: NoteFolder,
  subpath: string
): Promise<string> {
  const clean = subpath.replace(/^\/+|\/+$/g, '')
  if (!clean) throw new Error('Cannot duplicate the top-level folder')
  const topRoot = await folderRoot(root, topFolder)
  const oldAbs = resolveSafe(topRoot, clean)
  const parentAbs = path.dirname(oldAbs)
  const baseName = path.basename(oldAbs)
  let copyName = `${baseName} copy`
  let n = 1
  while (true) {
    try {
      await fs.access(path.join(parentAbs, copyName))
      n += 1
      copyName = `${baseName} copy ${n}`
    } catch {
      break
    }
  }
  const newAbs = path.join(parentAbs, copyName)
  await fs.cp(oldAbs, newAbs, { recursive: true })
  const newSubpath = path.relative(topRoot, newAbs).split(path.sep).join('/')
  const settings = await getVaultSettings(root)
  const nextSettings: VaultSettings = {
    ...settings,
    folderIcons: duplicateFolderIcons(settings.folderIcons, topFolder, clean, newSubpath)
  }
  await setVaultSettings(root, nextSettings)
  invalidateNoteMetaCache(root)
  invalidateVaultTextSearchCache(root)
  return newSubpath
}

/** Build the absolute on-disk path for a vault folder / subfolder. */
export function folderAbsolutePath(
  root: string,
  topFolder: NoteFolder,
  subpath: string
): Promise<string> {
  const clean = subpath.replace(/^\/+|\/+$/g, '')
  return (async () => {
    const topRoot = await folderRoot(root, topFolder)
    return clean ? resolveSafe(topRoot, clean) : topRoot
  })()
}

export function assetsAbsolutePath(root: string): string {
  return path.join(root, ASSETS_DIR)
}

async function removeFileIfExists(abs: string): Promise<void> {
  try {
    await fs.rm(abs, { force: true })
  } catch {
    /* ignore */
  }
}

async function removeDirIfEmpty(abs: string): Promise<void> {
  try {
    const entries = await fs.readdir(abs)
    if (entries.length === 0) await fs.rmdir(abs)
  } catch {
    /* ignore */
  }
}

export async function generateDemoTour(root: string): Promise<VaultDemoTourResult> {
  await ensureVaultLayout(root)

  for (const note of DEMO_TOUR_NOTES) {
    const abs = resolveSafe(root, note.path)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, note.body, 'utf8')
  }

  for (const asset of DEMO_TOUR_ASSETS) {
    const abs = resolveSafe(root, asset.path)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, asset.body, 'utf8')
  }

  invalidateNoteMetaCache(root)
  invalidateVaultTextSearchCache(root)
  return {
    notePaths: DEMO_TOUR_NOTES.map((note) => note.path),
    assetPaths: DEMO_TOUR_ASSETS.map((asset) => asset.path)
  }
}

export async function removeDemoTour(root: string): Promise<VaultDemoTourResult> {
  for (const note of DEMO_TOUR_NOTES) {
    await removeFileIfExists(resolveSafe(root, note.path))
  }

  for (const asset of DEMO_TOUR_ASSETS) {
    await removeFileIfExists(resolveSafe(root, asset.path))
  }

  await removeDirIfEmpty(resolveSafe(root, DEMO_TOUR_DIR))

  invalidateNoteMetaCache(root)
  invalidateVaultTextSearchCache(root)
  return {
    notePaths: DEMO_TOUR_NOTES.map((note) => note.path),
    assetPaths: DEMO_TOUR_ASSETS.map((asset) => asset.path)
  }
}

export async function hasAssetsDir(root: string): Promise<boolean> {
  for (const dirName of ATTACHMENTS_DIRS) {
    try {
      const stat = await fs.stat(path.join(root, dirName))
      if (stat.isDirectory()) return true
    } catch {
      /* ignore */
    }
  }
  return false
}

export async function listAssets(root: string): Promise<AssetMeta[]> {
  const out: AssetMeta[] = []
  const walk = async (dirAbs: string, dirReal: string, ancestors: Set<string>): Promise<void> => {
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true })
    } catch {
      return
    }
    for (const [index, entry] of entries.entries()) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dirAbs, entry.name)
      const childReal = await resolveDirDescent(full, entry, dirReal, ancestors)
      if (childReal !== null) {
        if (dirAbs === root && entry.name === INTERNAL_VAULT_DIR) continue
        // A `<Name>.base` database folder isn't an asset container — its
        // data.csv/schema.json/record notes never appear in the assets list.
        if (isFormDirName(entry.name)) continue
        ancestors.add(childReal)
        await walk(full, childReal, ancestors)
        ancestors.delete(childReal)
        continue
      }
      if (!entry.isFile()) continue
      if (entry.name.toLowerCase().endsWith('.md')) continue
      // Excalidraw drawings are a first-class file type (listed with notes), not
      // a generic attachment.
      if (isExcalidrawPath(entry.name)) continue
      // Legacy co-located sidecar/.bak (pre-migration) — not a user asset.
      if (isDatabaseInternalPath(entry.name)) continue
      let stat
      try {
        stat = await fs.stat(full)
      } catch {
        continue
      }
      const rel = toPosix(path.relative(root, full))
      out.push({
        path: rel,
        name: path.basename(full),
        kind: classifyImportedAsset(entry.name),
        siblingOrder: index,
        size: stat.size,
        updatedAt: stat.mtimeMs
      })
    }
  }

  const rootReal = await realpathOrResolve(root)
  await walk(root, rootReal, new Set([rootReal]))
  out.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  return out
}

/* ---------- Notes ---------------------------------------------------- */

/**
 * Move a note to a different folder / subfolder. Renames on disk
 * (preserving the filename, appending a numeric suffix if there's a
 * collision), then re-reads meta for the new location.
 */
export async function moveNote(
  root: string,
  oldRel: string,
  targetFolder: NoteFolder,
  targetSubpath: string
): Promise<NoteMeta> {
  const oldAbs = resolveSafe(root, oldRel)
  const filename = path.basename(oldAbs)
  const cleanSub = targetSubpath.replace(/^\/+|\/+$/g, '')
  const targetRoot = await folderRoot(root, targetFolder)
  const destDir = cleanSub ? resolveSafe(targetRoot, cleanSub) : targetRoot

  // No-op if the source already lives at the destination.
  if (path.dirname(oldAbs) === destDir) {
    const folder = folderOf(root, oldAbs)
    if (!folder) throw new Error(`Note not in a known folder: ${oldRel}`)
    return await readMeta(root, oldAbs, folder)
  }

  await fs.mkdir(destDir, { recursive: true })
  const ext = path.extname(filename)
  const baseTitle = path.basename(filename, ext)
  const finalTitle = await uniqueTitle(destDir, baseTitle)
  const destAbs = path.join(destDir, `${finalTitle}${ext}`)
  await fs.rename(oldAbs, destAbs)
  const meta = await readMeta(root, destAbs, targetFolder)
  await moveNoteComments(root, oldRel, meta.path)
  invalidateNoteMetaCache(root, oldRel)
  invalidateNoteMetaCache(root, meta.path)
  invalidateVaultTextSearchCache(root)
  return meta
}

export async function duplicateNote(root: string, rel: string): Promise<NoteMeta> {
  const abs = resolveSafe(root, rel)
  const folder = folderOf(root, abs)
  if (!folder) throw new Error(`Note not in a known folder: ${rel}`)
  const dir = path.dirname(abs)
  const ext = path.extname(abs)
  const baseTitle = path.basename(abs, ext)
  const copyTitle = await uniqueTitle(dir, `${baseTitle} copy`)
  const destAbs = path.join(dir, `${copyTitle}${ext}`)
  const body = await fs.readFile(abs, 'utf8')
  await fs.writeFile(destAbs, body, 'utf8')
  const meta = await readMeta(root, destAbs, folder)
  await copyNoteComments(root, rel, meta.path)
  invalidateNoteMetaCache(root, meta.path)
  invalidateVaultTextSearchCache(root)
  return meta
}

export async function importFiles(
  root: string,
  noteRelPath: string,
  sourcePaths: string[]
): Promise<ImportedAsset[]> {
  await fs.mkdir(root, { recursive: true })

  const noteDir = path.posix.dirname(toPosix(noteRelPath))
  const imported: ImportedAsset[] = []
  // Dropped files land in the unified `assets/` folder, matching pasted images
  // (`importPastedImage`). They used to be copied to the vault root, which in
  // Vault Root mode dumped them right next to your notes and was inconsistent
  // with paste. (#377)
  const assetsDir = path.join(root, ASSETS_DIR)

  for (const sourcePath of sourcePaths) {
    const sourceAbs = path.resolve(sourcePath)
    const stat = await fs.stat(sourceAbs)
    if (!stat.isFile()) continue

    await fs.mkdir(assetsDir, { recursive: true })
    const finalName = await uniqueFilename(assetsDir, path.basename(sourceAbs))
    const destAbs = path.join(assetsDir, finalName)
    await fs.copyFile(sourceAbs, destAbs)

    const vaultRelPath = toPosix(path.relative(root, destAbs))
    const relativeFromNote = path.posix.relative(
      noteDir === '.' ? '' : noteDir,
      vaultRelPath
    )
    const kind = classifyImportedAsset(finalName)
    imported.push({
      name: finalName,
      path: vaultRelPath,
      markdown: markdownForImportedAsset(relativeFromNote, finalName, kind),
      kind
    })
  }

  return imported
}

export async function importPastedImage(
  root: string,
  input: PastedImageInput,
  now = new Date()
): Promise<ImportedAsset> {
  const bytes = pastedImageBuffer(input.data)
  if (bytes.byteLength === 0) throw new Error('Clipboard image is empty.')

  // Pasted images land in the unified `assets/` folder.
  const assetsDir = path.join(root, ASSETS_DIR)
  await fs.mkdir(assetsDir, { recursive: true })
  const finalName = await uniqueFilename(assetsDir, pastedImageFilename(input, now))
  const destAbs = path.join(assetsDir, finalName)
  await fs.writeFile(destAbs, bytes)

  const vaultRelPath = toPosix(path.relative(root, destAbs))
  return {
    name: finalName,
    path: vaultRelPath,
    markdown: `![[${vaultRelPath}]]`,
    kind: 'image'
  }
}

/**
 * Returns the absolute path for a note, for use with `shell.showItemInFolder`
 * (Finder reveal). Path resolution is validated the same way as other
 * vault operations.
 */
export function absolutePath(root: string, rel: string): string {
  return resolveSafe(root, rel)
}

const WELCOME_NOTE = `# Welcome to ZenNotes

ZenNotes is a **file-based** markdown notes app made for focus and deep work. Every note is a plain \`.md\` file in your vault — yours to keep, sync, and version however you like.

## What you get

- **GitHub-flavored markdown** — tables, task lists, footnotes, strikethrough
- **Wiki links** — jump between notes with [[double brackets]]
- **Tags** — write a hashtag like \`#project\` in any note and it appears in the sidebar
- **Math** — inline like $e^{i\\pi}+1=0$ or as blocks
- **Callouts** — Obsidian-style \`> [!note]\` blocks
- **Mermaid diagrams** — code-fenced \`\`\`mermaid blocks render inline
- **Full-text search** — press \`Space s t\` in Vim mode, or run **Search Text in Vault** from the command palette

## Try it

- [ ] Write your first note
- [ ] Link to [[another note]]

> [!tip]
> Press the + button in the sidebar to create a new note. Your changes save automatically.

\`\`\`js
// Syntax-highlighted code blocks just work
function hello(name) {
  return \`Hello, \${name}!\`
}
\`\`\`

Enjoy the quiet.
`
