/**
 * Vault operations used by the MCP server. Mirrors the filesystem
 * behavior of src/main/vault.ts, but without Electron dependencies —
 * this runs as a plain Node process spawned by an MCP client.
 *
 * Operations are intentionally narrow: read the vault, modify notes,
 * move things between the four top-level folders. Nothing that
 * requires the renderer's Zustand store or a live app session.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { parse as parseToml } from 'smol-toml'
import { retitleLeadingHeading } from '@shared/note-heading-sync'
import { noteTasksMode, type NoteTasksMode } from '@shared/tasks'
import {
  isPathExcludedFromTasks,
  normalizeTasksExcludedFolders
} from '@shared/tasks-excluded-folders'
import {
  DEFAULT_TYPST_PREAMBLE_FOLDER,
  isTypstPreamblePath,
  resolveTypstPreambleFolder
} from '@shared/typst-preamble-folder'
import {
  isObsidianExcalidrawMarkdown,
  isObsidianExcalidrawPath
} from '@shared/excalidraw'
import { normalizeBaseUrl } from '../main/remote/connection'
import { buildOpenNoteDeepLink } from '../main/deep-links'

export type NoteFolder = 'inbox' | 'quick' | 'archive' | 'trash'
const FOLDERS: NoteFolder[] = ['inbox', 'quick', 'archive', 'trash']
const LIVE_FOLDERS: NoteFolder[] = ['inbox', 'quick', 'archive']
/** A database is a self-contained folder whose name ends with `.base`; its
 *  internals (data.csv, schema.json, record-page notes) aren't part of the MCP
 *  note/folder surface, so the walks skip these folders. */
const isFormDirName = (name: string): boolean => name.toLowerCase().endsWith('.base')
const ASSETS_DIR = 'assets'
const PRIMARY_ATTACHMENTS_DIR = 'attachements'
const LEGACY_ATTACHMENTS_DIRS = [PRIMARY_ATTACHMENTS_DIR, '_assets']
const ATTACHMENTS_DIRS = [ASSETS_DIR, ...LEGACY_ATTACHMENTS_DIRS]
const INTERNAL_VAULT_DIR = '.zennotes'
const VAULT_SETTINGS_FILE = 'vault.json'

export type PrimaryNotesLocation = 'inbox' | 'root'

/** Custom on-disk names for the four system folders (vault.json
 *  `systemFolderPaths`, #398): `{ trash: '99 - Deleted' }` makes that
 *  directory THE trash. Validation mirrors `normalizeSystemFolderPaths`
 *  in `@shared/system-folder-paths` — a synced copy, like the parsers in
 *  this file, because the MCP process cannot import the shared packages. */
type SystemFolderPathsMap = Partial<Record<NoteFolder, string>>

const RESERVED_FOLDER_PATH_NAMES = new Set([
  ASSETS_DIR,
  INTERNAL_VAULT_DIR,
  ...LEGACY_ATTACHMENTS_DIRS,
  'deleted-assets',
  'comments'
])

function validFolderPathName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 128) return null
  if (trimmed.includes('/') || trimmed.includes('\\')) return null
  if (trimmed === '.' || trimmed === '..' || trimmed.startsWith('.')) return null
  if (/[:*?"<>|#^[\]]/.test(trimmed)) return null
  if (RESERVED_FOLDER_PATH_NAMES.has(trimmed.toLowerCase())) return null
  return trimmed
}

async function readSystemFolderPaths(root: string): Promise<SystemFolderPathsMap> {
  const settingsPath = path.join(root, INTERNAL_VAULT_DIR, VAULT_SETTINGS_FILE)
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(await fs.readFile(settingsPath, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
  const value = raw['systemFolderPaths']
  if (!value || typeof value !== 'object') return {}
  const candidate = value as Partial<Record<NoteFolder, unknown>>
  const next: SystemFolderPathsMap = {}
  for (const folder of FOLDERS) {
    const p = validFolderPathName(candidate[folder])
    if (!p || p === folder) continue
    // Never let a folder claim ANOTHER folder's default name: a swap resolves
    // without collision but reads backwards everywhere.
    if (FOLDERS.some((other) => other !== folder && p.toLowerCase() === other)) continue
    next[folder] = p
  }
  // Drop entries whose resolved name collides with another folder's resolved
  // name (defaults included), matching the shared normalizer.
  let changed = true
  while (changed) {
    changed = false
    for (const folder of FOLDERS) {
      if (!next[folder]) continue
      const own = (next[folder] ?? folder).toLowerCase()
      for (const other of FOLDERS) {
        if (other === folder) continue
        if ((next[other] ?? other).toLowerCase() === own) {
          delete next[folder]
          changed = true
          break
        }
      }
    }
  }
  return next
}

function resolvedFolderDirName(folder: NoteFolder, paths: SystemFolderPathsMap): string {
  return paths[folder] ?? folder
}

/** The system folder that owns a top-level directory name, or null. Matches on
 *  RESOLVED names only, so with `inbox` remapped to `01 - Entry` a directory
 *  literally named `inbox/` is an ordinary user folder. Synced copy of
 *  `systemFolderForDirName` in `@shared/system-folder-paths`. */
function systemFolderForDirName(name: string, paths: SystemFolderPathsMap): NoteFolder | null {
  const lower = name.toLowerCase()
  for (const folder of FOLDERS) {
    if (resolvedFolderDirName(folder, paths).toLowerCase() === lower) return folder
  }
  return null
}

/** When the user has chosen `primaryNotesLocation: 'root'`, notes for the inbox
 *  folder live at the vault root. Skip these directory names while walking the
 *  root so we don't double-count quick/archive notes as inbox notes. Mirrors
 *  HIDDEN_PRIMARY_ROOT_NAMES in the desktop main process's vault.ts. */
function hiddenRootNamesWith(paths: SystemFolderPathsMap): Set<string> {
  const names = new Set<string>([...ATTACHMENTS_DIRS, INTERNAL_VAULT_DIR])
  // The RESOLVED directory of each non-primary system folder, not its default
  // name: once `quick` lives in `Fast/`, a leftover `quick/` is an ordinary
  // user folder and hiding it would swallow whatever the user put there.
  for (const folder of ['quick', 'archive', 'trash'] as NoteFolder[]) {
    names.add(resolvedFolderDirName(folder, paths))
  }
  return names
}

/** Read `.zennotes/vault.json` if present and pull out an explicit
 *  primaryNotesLocation setting. Returns null when the file is
 *  missing, unreadable (TCC), malformed, or doesn't include the
 *  field — callers fall back to layout inspection. */
async function readExplicitPrimaryNotesLocation(
  root: string
): Promise<PrimaryNotesLocation | null> {
  const settingsPath = path.join(root, INTERNAL_VAULT_DIR, VAULT_SETTINGS_FILE)
  try {
    const raw = await fs.readFile(settingsPath, 'utf8')
    const parsed = JSON.parse(raw) as { primaryNotesLocation?: unknown }
    if (parsed.primaryNotesLocation === 'root') return 'root'
    if (parsed.primaryNotesLocation === 'inbox') return 'inbox'
    return null
  } catch {
    return null
  }
}

/** How many "non-system" things sit directly at the vault root.
 *  Loose .md files and ordinary subfolders both count — both are
 *  strong signals the user organizes their vault flat-style. The
 *  four system folders (inbox/quick/archive/trash), attachments,
 *  and dotfiles are excluded. */
async function countLooseRootContent(root: string, paths: SystemFolderPathsMap): Promise<number> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return 0
  }
  const hidden = hiddenRootNamesWith(paths)
  const inboxDir = resolvedFolderDirName('inbox', paths)
  let count = 0
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (hidden.has(entry.name)) continue
    if (entry.name === 'inbox' || entry.name === inboxDir) continue
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) count += 1
    else if (entry.isDirectory()) count += 1
  }
  return count
}

/** Recursively count .md files under a given directory. Used to see
 *  whether `<root>/inbox/` actually has content. */
async function countMdFilesRecursively(dir: string): Promise<number> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let count = 0
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) count += await countMdFilesRecursively(full)
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) count += 1
  }
  return count
}

/** Decide whether this vault uses inbox-mode or root-mode for its
 *  primary notes area. The vault's on-disk layout is the strongest
 *  signal — the explicit `vault.json` setting is consulted only when
 *  the layout is genuinely ambiguous (a fresh, empty vault).
 *
 *  This deliberately ignores `vault.json` when it disagrees with the
 *  layout so that:
 *
 *  - A user who switched modes in Settings but whose vault hasn't
 *    been migrated yet still gets notes filed where their existing
 *    notes live.
 *  - A user whose `vault.json` was never created (or was deleted /
 *    restored from a sync) still gets correct behavior.
 *  - Sandboxed / TCC-restricted child processes that can't read
 *    `vault.json` still pick the right answer from `readdir` calls
 *    that succeeded.
 */
export async function readPrimaryNotesLocation(root: string): Promise<PrimaryNotesLocation> {
  const paths = await readSystemFolderPaths(root)
  const [rootContent, inboxNotes, explicit] = await Promise.all([
    countLooseRootContent(root, paths),
    countMdFilesRecursively(path.join(root, resolvedFolderDirName('inbox', paths))),
    readExplicitPrimaryNotesLocation(root)
  ])

  // Strong layout signal — root has user-organized content (loose
  // .md files, custom subfolders). The vault is laid out flat.
  if (rootContent >= 1) return 'root'

  // Strong layout signal — only inbox/ has notes, root is empty or
  // just system folders. Classic ZenNotes lifecycle layout.
  if (inboxNotes >= 1) return 'inbox'

  // Ambiguous (empty vault). Trust the explicit setting if present,
  // otherwise default to inbox (matches a fresh ZenNotes install).
  return explicit ?? 'inbox'
}

/** The absolute directory that holds notes for a given top-level
 *  folder, taking the vault's primaryNotesLocation into account. */
async function folderRoot(root: string, folder: NoteFolder): Promise<string> {
  const paths = await readSystemFolderPaths(root)
  if (folder !== 'inbox') return path.join(root, resolvedFolderDirName(folder, paths))
  const primary = await readPrimaryNotesLocation(root)
  return primary === 'root' ? root : path.join(root, resolvedFolderDirName('inbox', paths))
}

const FENCE_LINE_RE = /^(\s{0,3})(`{3,}|~{3,})/
// `>` = forwarded (#316), `-` = cancelled (#450), `/` = in progress (#512) —
// all recognized so those tasks aren't invisible to the MCP scanner. Kept in
// sync with @shared/tasklists.
const TASK_LINE_RE = /^\s*[-*+]\s+\[([ xX>/-])\](.*)$/

export interface NoteMeta {
  path: string
  /** `zennotes://open?path=…` URL that focuses the app and opens this note.
   *  Meant for rendering `[title](link)` markdown when presenting notes to
   *  the user (#509). Clients pass `path` back to tools, never this. */
  link: string
  title: string
  folder: NoteFolder
  createdAt: number
  updatedAt: number
  size: number
  tags: string[]
  wikilinks: string[]
  excerpt: string
}

export interface NoteContent extends NoteMeta {
  body: string
}

export interface VaultTask {
  id: string
  sourcePath: string
  /** Deep link to the source note; same contract as NoteMeta.link. */
  link: string
  noteTitle: string
  noteFolder: NoteFolder
  lineNumber: number
  taskIndex: number
  rawText: string
  content: string
  checked: boolean
  /** True for a `[-]` cancelled task — intentionally abandoned (#450). */
  cancelled?: boolean
  /** True for a `[>]` forwarded record: the task moved to another note and a
   *  live copy exists there, so this line is history, not open work (#316).
   *  Without this flag the subtree forward (#611) doubled every carried task
   *  in MCP/CLI listings: the records read as open beside the live copies. */
  forwarded?: boolean
  /** True for a `[/]` task in progress: started, not finished (#512). Still
   *  open work, unlike checked/cancelled. */
  inProgress?: boolean
  due?: string
  priority?: 'high' | 'med' | 'low'
  waiting: boolean
  tags: string[]
  /** How this task is stored. `'file'` is a whole-note task (TaskNotes-style: a
   *  `.md` file tagged `task`, metadata in frontmatter); `'inline'` (the default
   *  when absent) is a classic `- [ ]` checkbox line. */
  kind?: 'inline' | 'file'
  /** ISO YYYY-MM-DD start/scheduled date (frontmatter `scheduled`). File-tasks. */
  scheduled?: string
  /** ISO YYYY-MM-DD completion date (frontmatter `completedDate`). File-tasks. */
  completedDate?: string
}

/* ---------- Path + config helpers ------------------------------------ */

function userDataDir(): string {
  // Test/automation hook: point the CLI and MCP server at an explicit
  // config directory instead of the per-OS Electron location.
  const override = process.env.ZENNOTES_CONFIG_DIR?.trim()
  if (override) return path.resolve(override)

  // Mirror Electron's `app.getPath('userData')` for product name "ZenNotes".
  const home = os.homedir()
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'ZenNotes')
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'ZenNotes')
    default:
      return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'ZenNotes')
  }
}

async function readConfigFile(): Promise<Record<string, unknown> | null> {
  const configPath = path.join(userDataDir(), 'zennotes.config.json')
  try {
    const raw = await fs.readFile(configPath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export async function readVaultRootFromConfig(): Promise<string | null> {
  const parsed = await readConfigFile()
  const vaultRoot = parsed?.vaultRoot
  return typeof vaultRoot === 'string' && vaultRoot.trim() ? vaultRoot : null
}

/** Directory of the portable TOML preferences (#203). Mirrors `getConfigDir`
 *  in main/app-config.ts, which reaches it through Electron's `app`; this
 *  process has none. Note this is NOT `userDataDir()` above; the portable
 *  prefs live beside it, in an XDG-style location the user can sync. */
function portableConfigDir(): string {
  const explicit = process.env.ZENNOTES_CONFIG_DIR?.trim()
  if (explicit) return explicit
  const xdg = process.env.XDG_CONFIG_HOME?.trim()
  if (xdg) return path.join(xdg, 'zennotes')
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim()
    return path.join(appData || path.join(os.homedir(), 'AppData', 'Roaming'), 'zennotes')
  }
  return path.join(os.homedir(), '.config', 'zennotes')
}

/**
 * The user's "Sync title heading on rename" preference (#455).
 *
 * The portable config file is the source of truth for this pref, and a vault
 * renamed through MCP is the same vault the app renames, so both must obey it.
 * Defaults to on, matching PORTABLE_DEFAULTS, when the file is missing (a
 * fresh install, or a user who never changed the setting).
 */
async function readSyncTitleHeadingOnRename(): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.join(portableConfigDir(), 'config.toml'), 'utf8')
    const parsed = parseToml(raw) as { editor?: { sync_title_heading_on_rename?: unknown } }
    const value = parsed.editor?.sync_title_heading_on_rename
    return typeof value === 'boolean' ? value : true
  } catch {
    return true
  }
}

export interface KnownVault {
  root: string
  name: string
  lastOpenedAt: number | null
}

/**
 * Every vault the app knows about: the `localVaults` list it maintains,
 * plus the active `vaultRoot` if it isn't listed (legacy configs).
 * Sorted most recently opened first.
 */
export async function readKnownVaultsFromConfig(): Promise<KnownVault[]> {
  const parsed = await readConfigFile()
  const seen = new Set<string>()
  const out: KnownVault[] = []

  const rawList = Array.isArray(parsed?.localVaults) ? parsed.localVaults : []
  for (const entry of rawList) {
    if (!entry || typeof entry !== 'object') continue
    const { root, name, lastOpenedAt } = entry as Record<string, unknown>
    if (typeof root !== 'string' || !root.trim()) continue
    const resolved = path.resolve(root)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    out.push({
      root: resolved,
      name: typeof name === 'string' && name.trim() ? name : path.basename(resolved),
      lastOpenedAt: typeof lastOpenedAt === 'number' ? lastOpenedAt : null
    })
  }

  const active = typeof parsed?.vaultRoot === 'string' ? parsed.vaultRoot.trim() : ''
  if (active && !seen.has(path.resolve(active))) {
    const resolved = path.resolve(active)
    out.push({ root: resolved, name: path.basename(resolved), lastOpenedAt: null })
  }

  out.sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))
  return out
}

export interface KnownRemoteProfile {
  id: string
  name: string
  baseUrl: string
  authToken: string | null
  lastConnectedAt: number | null
}

/**
 * Every ZenNotes server the app has been connected to, newest first. The
 * desktop app writes these under `remoteWorkspaceProfiles` when you use
 * Settings → Vault → "Connect to Server..."; the CLI reads the same list so
 * `--server <name>` names a server you already set up in the GUI (#493).
 *
 * The legacy single-server `remoteWorkspace` key is folded in too, matching
 * how the main process migrates it, so a config written before profiles
 * existed still gives the CLI something to name.
 */
export async function readRemoteProfilesFromConfig(): Promise<KnownRemoteProfile[]> {
  const parsed = await readConfigFile()
  const out: KnownRemoteProfile[] = []
  const seenBaseUrls = new Set<string>()

  const rawList = Array.isArray(parsed?.remoteWorkspaceProfiles)
    ? parsed.remoteWorkspaceProfiles
    : []
  for (const entry of rawList) {
    if (!entry || typeof entry !== 'object') continue
    const { id, name, baseUrl, authToken, lastConnectedAt } = entry as Record<string, unknown>
    if (typeof baseUrl !== 'string' || !baseUrl.trim()) continue
    if (typeof name !== 'string' || !name.trim()) continue
    const normalizedUrl = normalizeBaseUrl(baseUrl)
    seenBaseUrls.add(normalizedUrl)
    out.push({
      id: typeof id === 'string' && id.trim() ? id : normalizedUrl,
      name: name.trim(),
      baseUrl: normalizedUrl,
      authToken: typeof authToken === 'string' && authToken.trim() ? authToken : null,
      lastConnectedAt: typeof lastConnectedAt === 'number' ? lastConnectedAt : null
    })
  }

  const legacy = parsed?.remoteWorkspace
  if (legacy && typeof legacy === 'object') {
    const { baseUrl, authToken } = legacy as Record<string, unknown>
    if (typeof baseUrl === 'string' && baseUrl.trim()) {
      const normalizedUrl = normalizeBaseUrl(baseUrl)
      if (!seenBaseUrls.has(normalizedUrl)) {
        out.push({
          id: normalizedUrl,
          name: 'ZenNotes Server',
          baseUrl: normalizedUrl,
          authToken: typeof authToken === 'string' && authToken.trim() ? authToken : null,
          lastConnectedAt: null
        })
      }
    }
  }

  out.sort((a, b) => (b.lastConnectedAt ?? 0) - (a.lastConnectedAt ?? 0))
  return out
}

/**
 * The workspace the desktop app currently has open: a vault on disk, or a
 * self-hosted server. A flag-less `zn` and `zn mcp` follow this, so an agent
 * talks to the vault the user is looking at rather than the last local one
 * (#688). The app keeps server tokens in the OS secret store, which a plain
 * Node process cannot read, so the token here is only ever the legacy
 * plaintext one a pre-profile config may still carry; callers layer
 * `ZENNOTES_REMOTE_TOKEN` / `--token` on top.
 */
export type ActiveWorkspace =
  | { kind: 'local'; root: string | null }
  | {
      kind: 'remote'
      baseUrl: string
      name: string
      profileId: string | null
      authToken: string | null
    }

export async function readActiveWorkspaceFromConfig(): Promise<ActiveWorkspace> {
  const parsed = await readConfigFile()
  const vaultRoot = parsed?.vaultRoot
  const root = typeof vaultRoot === 'string' && vaultRoot.trim() ? vaultRoot : null
  if (parsed?.workspaceMode !== 'remote') return { kind: 'local', root }
  const remote = parsed.remoteWorkspace
  const rawBaseUrl =
    remote && typeof remote === 'object' ? (remote as Record<string, unknown>).baseUrl : null
  if (typeof rawBaseUrl !== 'string' || !rawBaseUrl.trim()) return { kind: 'local', root }
  const baseUrl = normalizeBaseUrl(rawBaseUrl)
  const configuredProfileId =
    typeof parsed.remoteWorkspaceProfileId === 'string' && parsed.remoteWorkspaceProfileId.trim()
      ? parsed.remoteWorkspaceProfileId
      : null
  const profiles = await readRemoteProfilesFromConfig()
  const profile =
    (configuredProfileId && profiles.find((p) => p.id === configuredProfileId)) ||
    profiles.find((p) => p.baseUrl === baseUrl) ||
    null
  const legacyToken = (remote as Record<string, unknown>).authToken
  return {
    kind: 'remote',
    baseUrl,
    name: profile?.name ?? '',
    profileId: profile?.id ?? configuredProfileId,
    authToken:
      profile?.authToken ??
      (typeof legacyToken === 'string' && legacyToken.trim() ? legacyToken : null)
  }
}

function expandHome(target: string): string {
  if (target === '~') return os.homedir()
  if (target.startsWith('~/') || target.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), target.slice(2))
  }
  return target
}

/**
 * Resolve a `--vault` selector to a vault root. Names from the app's
 * known-vault list match first (case-insensitive); anything else is
 * treated as a directory path. Errors name the available vaults so a
 * typo is self-correcting.
 */
export async function resolveVaultSelector(selector: string): Promise<string> {
  const trimmed = selector.trim()
  const known = await readKnownVaultsFromConfig()

  const byName = known.filter((vault) => vault.name.toLowerCase() === trimmed.toLowerCase())
  if (byName.length === 1) {
    const root = byName[0].root
    try {
      const stat = await fs.stat(root)
      if (stat.isDirectory()) return root
    } catch {
      // fall through to the descriptive error below
    }
    throw new Error(
      `Vault "${byName[0].name}" points to ${root}, which is missing. Open it in ZenNotes again or pass a path.`
    )
  }
  if (byName.length > 1) {
    const roots = byName.map((vault) => vault.root).join(', ')
    throw new Error(`Multiple vaults are named "${trimmed}" (${roots}). Pass the path instead.`)
  }

  const abs = path.resolve(expandHome(trimmed))
  try {
    const stat = await fs.stat(abs)
    if (stat.isDirectory()) return abs
  } catch {
    // not a directory either — build the descriptive error below
  }

  const names = known.map((vault) => vault.name).join(', ')
  throw new Error(
    names
      ? `No vault named "${trimmed}". Known vaults: ${names}. You can also pass a directory path.`
      : `No vault named "${trimmed}" and no such directory. Pass a vault directory path.`
  )
}

export async function resolveVaultRoot(selector?: string): Promise<string> {
  if (selector?.trim()) return resolveVaultSelector(selector)
  const fromEnv = process.env.ZENNOTES_VAULT?.trim()
  if (fromEnv) return path.resolve(fromEnv)
  const fromConfig = await readVaultRootFromConfig()
  if (fromConfig) return path.resolve(fromConfig)
  throw new Error(
    'No ZenNotes vault is configured. Open ZenNotes once and pick a vault, or set the ZENNOTES_VAULT environment variable.'
  )
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/')
}

function resolveSafe(root: string, rel: string): string {
  const abs = path.resolve(root, rel)
  const rootAbs = path.resolve(root)
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new Error(`Path escapes vault: ${rel}`)
  }
  return abs
}

async function folderOf(root: string, abs: string): Promise<NoteFolder | null> {
  const rel = toPosix(path.relative(root, abs))
  if (!rel || rel.startsWith('..')) return null
  const top = rel.split('/')[0]
  const paths = await readSystemFolderPaths(root)
  const system = systemFolderForDirName(top, paths)
  if (system) return system
  // Root-level files belong to inbox in `primaryNotesLocation: 'root'`
  // mode. Hidden names (.zennotes, attachments, system folders) are
  // not notes — return null so they're rejected.
  if (!top || top.startsWith('.') || hiddenRootNamesWith(paths).has(top)) return null
  return 'inbox'
}

/* ---------- Markdown parsing ----------------------------------------- */

/**
 * Blank out fenced and inline code so the #tag / [[link]] / excerpt scanners
 * never read code as content. Line-based and indentation-tolerant: a fence
 * nested under a list item is still a code block (#293). Mirrors
 * `stripCodeContent` in apps/desktop/src/main/vault.ts,
 * packages/app-core/src/lib/{tags,wikilinks}.ts, and
 * apps/server/internal/vault/parse.go — keep all five in sync.
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
        // A backtick fence's info string may not contain a backtick (CommonMark).
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

/** Frontmatter `tags` plus inline `#tags`. A bare scalar splits on commas and
 *  whitespace, since `tags: daily, work` is two tags and a tag can contain
 *  neither. Kept in sync with `frontmatterTags` in
 *  packages/shared-domain/src/frontmatter.ts (#444). */
function extractTags(body: string): string[] {
  const seen = new Set<string>()
  const fm = body.match(FRONTMATTER_RE)
  for (const raw of asArray(fm ? parseTaskFrontmatter(fm[1] ?? '').tags : undefined)) {
    for (const part of raw.trim().split(/[,\s]+/)) {
      const normalized = part.replace(/^#/, '').trim()
      if (normalized) seen.add(normalized)
    }
  }

  const markdownBody = body.replace(FRONTMATTER_RE, '')
  const stripped = stripCodeContent(markdownBody)
  const matches = stripped.match(/(?:^|\s)#(\p{L}[\p{L}\d_/-]*)/gu) || []
  for (const m of matches) seen.add(m.trim().slice(1))
  return [...seen]
}

function extractWikilinks(body: string): string[] {
  const stripped = stripCodeContent(body)
  const re = /\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/g
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(stripped)) !== null) seen.add(m[1].trim())
  return [...seen]
}

function buildExcerpt(body: string): string {
  const withoutFront = body.replace(/^---\n[\s\S]*?\n---\n/, '')
  const text = stripCodeContent(withoutFront)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) => b || a)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.slice(0, 220)
}

async function readMeta(root: string, abs: string, folder: NoteFolder): Promise<NoteMeta> {
  const stat = await fs.stat(abs)
  let body = ''
  try {
    body = await fs.readFile(abs, 'utf8')
  } catch {
    /* treat as empty */
  }
  const rel = toPosix(path.relative(root, abs))
  // Typst preambles hold Typst source, whose `#let` / `#var` tokens are
  // variables rather than tags (#562). Skipped here so agents see the same tag
  // list the app does; everything else about the note is reported as usual.
  const isPreamble = isTypstPreamblePath(rel, await readTypstPreambleFolder(root))
  return {
    path: rel,
    link: buildOpenNoteDeepLink(rel),
    title: path.basename(abs, path.extname(abs)),
    folder,
    createdAt: stat.birthtimeMs || stat.ctimeMs,
    updatedAt: stat.mtimeMs,
    size: stat.size,
    tags: isPreamble ? [] : extractTags(body),
    wikilinks: extractWikilinks(body),
    excerpt: buildExcerpt(body)
  }
}

/* ---------- Listing --------------------------------------------------- */

export async function listNotes(root: string): Promise<NoteMeta[]> {
  const hiddenRootNames = hiddenRootNamesWith(await readSystemFolderPaths(root))
  const out: NoteMeta[] = []
  const walk = async (
    folder: NoteFolder,
    dirAbs: string,
    topAbs: string,
    isPrimaryRoot: boolean
  ): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dirAbs, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue
        if (isFormDirName(entry.name)) continue // database folder — not loose notes
        // When walking the vault root in primary='root' mode, system
        // subdirectories (quick/, archive/, trash/, attachments) are
        // not part of inbox — they're walked separately as their own
        // top-level folder.
        if (isPrimaryRoot && dirAbs === topAbs && hiddenRootNames.has(entry.name)) {
          continue
        }
        await walk(folder, full, topAbs, isPrimaryRoot)
        continue
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        out.push(await readMeta(root, full, folder))
      }
    }
  }
  for (const folder of FOLDERS) {
    const topAbs = await folderRoot(root, folder)
    const isPrimaryRoot = folder === 'inbox' && path.resolve(topAbs) === path.resolve(root)
    await walk(folder, topAbs, topAbs, isPrimaryRoot)
  }
  return out
}

export async function listFolders(root: string): Promise<{ folder: NoteFolder; subpath: string }[]> {
  const hiddenRootNames = hiddenRootNamesWith(await readSystemFolderPaths(root))
  const out: { folder: NoteFolder; subpath: string }[] = []
  for (const folder of FOLDERS) {
    const topAbs = await folderRoot(root, folder)
    const isPrimaryRoot = folder === 'inbox' && path.resolve(topAbs) === path.resolve(root)
    const walk = async (dirAbs: string, subpath: string): Promise<void> => {
      let entries
      try {
        entries = await fs.readdir(dirAbs, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue
        if (isFormDirName(e.name)) continue // database folder — not a user folder
        if (isPrimaryRoot && dirAbs === topAbs && hiddenRootNames.has(e.name)) {
          continue
        }
        const nextSub = subpath ? `${subpath}/${e.name}` : e.name
        out.push({ folder, subpath: nextSub })
        await walk(path.join(dirAbs, e.name), nextSub)
      }
    }
    await walk(topAbs, '')
  }
  return out
}

/** Every `.base` database folder as a (folder, subpath) entry — the companion
 *  to listFolders, which deliberately hides them from user-folder listings.
 *  Same walk, opposite filter; a `.base` folder is never descended into. (#556) */
export async function listDatabaseDirs(
  root: string
): Promise<{ folder: NoteFolder; subpath: string }[]> {
  const hiddenRootNames = hiddenRootNamesWith(await readSystemFolderPaths(root))
  const out: { folder: NoteFolder; subpath: string }[] = []
  for (const folder of FOLDERS) {
    const topAbs = await folderRoot(root, folder)
    const isPrimaryRoot = folder === 'inbox' && path.resolve(topAbs) === path.resolve(root)
    const walk = async (dirAbs: string, subpath: string): Promise<void> => {
      let entries
      try {
        entries = await fs.readdir(dirAbs, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue
        if (isPrimaryRoot && dirAbs === topAbs && hiddenRootNames.has(e.name)) {
          continue
        }
        const nextSub = subpath ? `${subpath}/${e.name}` : e.name
        if (isFormDirName(e.name)) {
          out.push({ folder, subpath: nextSub })
          continue
        }
        await walk(path.join(dirAbs, e.name), nextSub)
      }
    }
    await walk(topAbs, '')
  }
  return out
}

export async function listAssets(root: string): Promise<
  { path: string; name: string; size: number; updatedAt: number }[]
> {
  const out: { path: string; name: string; size: number; updatedAt: number }[] = []
  const walk = async (dirAbs: string): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dirAbs, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      const stat = await fs.stat(full)
      out.push({
        path: toPosix(path.relative(root, full)),
        name: path.basename(full),
        size: stat.size,
        updatedAt: stat.mtimeMs
      })
    }
  }
  for (const dir of ATTACHMENTS_DIRS) {
    try {
      const st = await fs.stat(path.join(root, dir))
      if (!st.isDirectory()) continue
    } catch {
      continue
    }
    await walk(path.join(root, dir))
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt)
  return out
}

/* ---------- Read / write / create ------------------------------------ */

export async function readNote(root: string, rel: string): Promise<NoteContent> {
  const abs = resolveSafe(root, rel)
  const folder = await folderOf(root, abs)
  if (!folder) throw new Error(`Note not in a known folder: ${rel}`)
  const body = await fs.readFile(abs, 'utf8')
  const meta = await readMeta(root, abs, folder)
  return { ...meta, body }
}

export async function writeNote(root: string, rel: string, body: string): Promise<NoteMeta> {
  const abs = resolveSafe(root, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, body, 'utf8')
  const folder = await folderOf(root, abs)
  if (!folder) throw new Error(`Note not in a known folder: ${rel}`)
  return await readMeta(root, abs, folder)
}

/** Raw text of any vault file (`.base/` internals included), or null when
 *  absent. The generic-file sibling of readNote, for surfaces composing
 *  @shared/database-ops over a local root — the zn `base` commands (#556).
 *  Absence must be null and every other failure must throw: the database
 *  composition reads null as "no schema yet" and infers one over it. */
export async function readVaultFileTextOrNull(root: string, rel: string): Promise<string | null> {
  const abs = resolveSafe(root, rel)
  try {
    return await fs.readFile(abs, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return null
    throw err
  }
}

/** Write any vault file's text, creating parent directories. */
export async function writeVaultFileText(root: string, rel: string, text: string): Promise<void> {
  const abs = resolveSafe(root, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, text, 'utf8')
}

/** The vault layout facts database path composition depends on (#556). */
export async function readDatabaseVaultLayout(root: string): Promise<{
  primaryNotesAtRoot: boolean
  systemFolderPaths: Partial<Record<NoteFolder, string>> | null
}> {
  const [location, folderPaths] = await Promise.all([
    readPrimaryNotesLocation(root),
    readSystemFolderPaths(root)
  ])
  return {
    primaryNotesAtRoot: location === 'root',
    systemFolderPaths: Object.keys(folderPaths).length > 0 ? folderPaths : null
  }
}

async function uniqueTitle(dir: string, base: string): Promise<string> {
  let candidate = base
  let n = 1
  while (true) {
    try {
      await fs.access(path.join(dir, `${candidate}.md`))
      n += 1
      candidate = `${base} ${n}`
    } catch {
      return candidate
    }
  }
}

function sanitizeTitle(raw: string): string {
  // Filenames must be safe on all 3 OSes. Strip path separators, null,
  // and common reserved characters.
  return raw
    .replace(/[\\/:\u0000-\u001f*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200) || 'Untitled'
}

export async function createNote(
  root: string,
  folder: NoteFolder,
  title?: string,
  subpath = '',
  body?: string
): Promise<NoteMeta> {
  if (folder === 'trash') throw new Error('Refusing to create a note directly in trash/')
  const base = sanitizeTitle(title ?? 'Untitled')
  const clean = subpath.replace(/^\/+|\/+$/g, '')
  const folderAbs = await folderRoot(root, folder)
  const dir = clean
    ? resolveSafe(folderAbs, clean)
    : folderAbs
  await fs.mkdir(dir, { recursive: true })
  const finalTitle = await uniqueTitle(dir, base)
  const abs = path.join(dir, `${finalTitle}.md`)
  const content = body ?? `# ${finalTitle}\n\n`
  await fs.writeFile(abs, content, 'utf8')
  return await readMeta(root, abs, folder)
}

export async function renameNote(root: string, rel: string, nextTitle: string): Promise<NoteMeta> {
  const abs = resolveSafe(root, rel)
  const folder = await folderOf(root, abs)
  if (!folder) throw new Error(`Note not in a known folder: ${rel}`)
  const dir = path.dirname(abs)
  const trimmed = sanitizeTitle(nextTitle)
  const target = path.join(dir, `${trimmed}.md`)
  if (target !== abs) {
    try {
      await fs.access(target)
      const [srcStat, dstStat] = await Promise.all([fs.stat(abs), fs.stat(target)])
      if (srcStat.ino !== dstStat.ino) {
        throw new Error(`A note named "${trimmed}" already exists in ${folder}`)
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    if (abs.toLowerCase() === target.toLowerCase() && abs !== target) {
      const tmp = abs + '_rename_tmp_' + Date.now()
      await fs.rename(abs, tmp)
      await fs.rename(tmp, target)
    } else {
      await fs.rename(abs, target)
    }
  }
  await syncTitleHeading(abs, target, trimmed)
  return await readMeta(root, target, folder)
}

/**
 * Rewrite the note's leading `# Heading` to match its new filename, when the
 * user has that setting on. The app does this on its own rename paths (#455);
 * a rename through MCP touches the same file and must not leave the heading
 * saying something the filename no longer does.
 *
 * Mirrors the renderer's guards: never an Obsidian drawing (those `.md` files
 * open with `# Excalidraw Data`, which is structure and not a title), and a
 * failure here never undoes the rename that already succeeded.
 */
async function syncTitleHeading(
  sourceAbs: string,
  targetAbs: string,
  title: string
): Promise<void> {
  if (isObsidianExcalidrawPath(sourceAbs) || isObsidianExcalidrawPath(targetAbs)) return
  if (!(await readSyncTitleHeadingOnRename())) return
  try {
    const body = await fs.readFile(targetAbs, 'utf8')
    if (isObsidianExcalidrawMarkdown(body)) return
    const next = retitleLeadingHeading(body, title)
    if (next !== body) await fs.writeFile(targetAbs, next, 'utf8')
  } catch {
    /* the rename stands; the heading just stays as it was */
  }
}

/**
 * The note's directory relative to its top-level folder root ('' when
 * it sits at the folder root). Mirrors main/vault.ts: archive/trash
 * moves carry the subfolder along so the reverse move restores it.
 */
async function folderSubpathOf(root: string, abs: string): Promise<string> {
  const folder = await folderOf(root, abs)
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
  const subpath = await folderSubpathOf(root, abs)
  const targetRoot = await folderRoot(root, target)
  const destDir = subpath ? resolveSafe(targetRoot, subpath) : targetRoot
  await fs.mkdir(destDir, { recursive: true })
  const baseTitle = path.basename(filename, path.extname(filename))
  const finalTitle = await uniqueTitle(destDir, baseTitle)
  const destAbs = path.join(destDir, `${finalTitle}.md`)
  await fs.rename(abs, destAbs)
  return await readMeta(root, destAbs, target)
}

export const moveToTrash = (root: string, rel: string) => moveBetweenFolders(root, rel, 'trash')
export const restoreFromTrash = (root: string, rel: string) =>
  moveBetweenFolders(root, rel, 'inbox')
export const archiveNote = (root: string, rel: string) => moveBetweenFolders(root, rel, 'archive')
export const unarchiveNote = (root: string, rel: string) =>
  moveBetweenFolders(root, rel, 'inbox')

export async function moveNote(
  root: string,
  oldRel: string,
  targetFolder: NoteFolder,
  targetSubpath: string
): Promise<NoteMeta> {
  const oldAbs = resolveSafe(root, oldRel)
  const filename = path.basename(oldAbs)
  const cleanSub = targetSubpath.replace(/^\/+|\/+$/g, '')
  const folderAbs = await folderRoot(root, targetFolder)
  const destDir = cleanSub ? resolveSafe(folderAbs, cleanSub) : folderAbs
  if (path.dirname(oldAbs) === destDir) {
    const folder = await folderOf(root, oldAbs)
    if (!folder) throw new Error(`Note not in a known folder: ${oldRel}`)
    return await readMeta(root, oldAbs, folder)
  }
  await fs.mkdir(destDir, { recursive: true })
  const ext = path.extname(filename)
  const baseTitle = path.basename(filename, ext)
  const finalTitle = await uniqueTitle(destDir, baseTitle)
  const destAbs = path.join(destDir, `${finalTitle}${ext}`)
  await fs.rename(oldAbs, destAbs)
  return await readMeta(root, destAbs, targetFolder)
}

export async function duplicateNote(root: string, rel: string): Promise<NoteMeta> {
  const abs = resolveSafe(root, rel)
  const folder = await folderOf(root, abs)
  if (!folder) throw new Error(`Note not in a known folder: ${rel}`)
  const dir = path.dirname(abs)
  const ext = path.extname(abs)
  const baseTitle = path.basename(abs, ext)
  const copyTitle = await uniqueTitle(dir, `${baseTitle} copy`)
  const destAbs = path.join(dir, `${copyTitle}${ext}`)
  const body = await fs.readFile(abs, 'utf8')
  await fs.writeFile(destAbs, body, 'utf8')
  return await readMeta(root, destAbs, folder)
}

export async function deleteNote(root: string, rel: string): Promise<void> {
  const abs = resolveSafe(root, rel)
  await fs.rm(abs, { force: true })
}

export async function emptyTrash(root: string): Promise<void> {
  const trashDir = await folderRoot(root, 'trash')
  try {
    const entries = await fs.readdir(trashDir)
    await Promise.all(entries.map((e) => fs.rm(path.join(trashDir, e), { recursive: true, force: true })))
  } catch {
    /* no trash dir */
  }
}

export async function createFolder(
  root: string,
  topFolder: NoteFolder,
  subpath: string
): Promise<void> {
  const clean = subpath.replace(/^\/+|\/+$/g, '')
  if (!clean) throw new Error('Folder name is required')
  const folderAbs = await folderRoot(root, topFolder)
  const abs = resolveSafe(folderAbs, clean)
  await fs.mkdir(abs, { recursive: true })
}

export async function renameFolder(
  root: string,
  topFolder: NoteFolder,
  oldSubpath: string,
  newSubpath: string
): Promise<string> {
  const oldClean = oldSubpath.replace(/^\/+|\/+$/g, '')
  const newClean = newSubpath.replace(/^\/+|\/+$/g, '')
  if (!oldClean || !newClean) throw new Error('Both old and new folder paths are required')
  const folderAbs = await folderRoot(root, topFolder)
  const oldAbs = resolveSafe(folderAbs, oldClean)
  const newAbs = resolveSafe(folderAbs, newClean)
  if (newAbs === oldAbs) return newClean
  if ((newAbs + path.sep).startsWith(oldAbs + path.sep)) {
    throw new Error('Cannot move a folder into itself')
  }
  await fs.mkdir(path.dirname(newAbs), { recursive: true })
  await fs.rename(oldAbs, newAbs)
  return newClean
}

export async function deleteFolder(
  root: string,
  topFolder: NoteFolder,
  subpath: string
): Promise<void> {
  const clean = subpath.replace(/^\/+|\/+$/g, '')
  if (!clean) throw new Error('Cannot delete the top-level folder')
  const folderAbs = await folderRoot(root, topFolder)
  const abs = resolveSafe(folderAbs, clean)
  await fs.rm(abs, { recursive: true, force: true })
}

/* ---------- Text search ---------------------------------------------- */

export interface VaultTextSearchMatch {
  path: string
  /** Deep link to the matched note; same contract as NoteMeta.link. */
  link: string
  title: string
  folder: NoteFolder
  lineNumber: number
  lineText: string
}

export async function searchText(
  root: string,
  query: string,
  limit = 80
): Promise<VaultTextSearchMatch[]> {
  const trimmed = query.trim()
  if (!trimmed) return []
  const needle = trimmed.toLowerCase()
  const hiddenRootNames = hiddenRootNamesWith(await readSystemFolderPaths(root))
  const out: VaultTextSearchMatch[] = []
  const walk = async (
    folder: NoteFolder,
    dirAbs: string,
    topAbs: string,
    isPrimaryRoot: boolean
  ): Promise<void> => {
    if (out.length >= limit) return
    let entries
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= limit) return
      const full = path.join(dirAbs, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue
        if (isPrimaryRoot && dirAbs === topAbs && hiddenRootNames.has(entry.name)) {
          continue
        }
        await walk(folder, full, topAbs, isPrimaryRoot)
        continue
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
      let body = ''
      try {
        body = await fs.readFile(full, 'utf8')
      } catch {
        continue
      }
      const rel = toPosix(path.relative(root, full))
      const title = path.basename(full, path.extname(full))
      const lines = body.split('\n')
      for (let i = 0; i < lines.length && out.length < limit; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          out.push({
            path: rel,
            link: buildOpenNoteDeepLink(rel),
            title,
            folder,
            lineNumber: i + 1,
            lineText: lines[i].replace(/\s+/g, ' ').trim().slice(0, 220)
          })
        }
      }
    }
  }
  for (const folder of LIVE_FOLDERS) {
    if (out.length >= limit) break
    const topAbs = await folderRoot(root, folder)
    const isPrimaryRoot = folder === 'inbox' && path.resolve(topAbs) === path.resolve(root)
    await walk(folder, topAbs, topAbs, isPrimaryRoot)
  }
  return out
}

/* ---------- Tasks ---------------------------------------------------- */

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/
// Optional whitespace after the colon so a spaced `due: 2026-01-01` parses like
// `due:2026-01-01` (kept in sync with packages/shared-domain/src/tasks.ts). (#343)
const INLINE_DUE_RE = /(?:^|\s)due:\s*(\S+)/i
const INLINE_PRIORITY_RE = /(?:^|\s)!(high|med|medium|low|h|m|l)\b/i
const INLINE_WAITING_RE = /(?:^|\s)@waiting\b/i
const INLINE_TAG_RE = /(?:^|\s)#([\p{L}\d][\p{L}\d/_-]*)/gu

function unquote(v: string): string {
  const trimmed = v.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' || first === "'") && first === last) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

function normalizePriority(raw: string | undefined): 'high' | 'med' | 'low' | undefined {
  if (!raw) return undefined
  const v = raw.toLowerCase().trim()
  if (v === 'high' || v === 'h') return 'high'
  // `normal` is the TaskNotes default priority; map it onto ZenNotes' `med`.
  if (v === 'med' || v === 'medium' || v === 'normal' || v === 'm') return 'med'
  if (v === 'low' || v === 'l') return 'low'
  return undefined
}

function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  return Number.isFinite(Date.parse(`${s}T00:00:00Z`))
}

function normalizeDueDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const cleaned = unquote(raw.trim())
  return isValidIsoDate(cleaned) ? cleaned : undefined
}

function parseNoteDefaults(body: string): {
  due?: string
  priority?: 'high' | 'med' | 'low'
  tasksMode: NoteTasksMode
} {
  const m = body.match(FRONTMATTER_RE)
  if (!m) return { tasksMode: 'all' }
  const out: { due?: string; priority?: 'high' | 'med' | 'low'; tasksMode: NoteTasksMode } = {
    tasksMode: 'all'
  }
  for (const rawLine of m[1].split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const colon = line.indexOf(':')
    if (colon < 1) continue
    const key = line.slice(0, colon).trim().toLowerCase()
    const value = line
      .slice(colon + 1)
      .trim()
      .replace(/^["']|["']$/g, '')
    if (key === 'due' && isValidIsoDate(value)) out.due = value
    else if (key === 'priority') {
      const p = normalizePriority(value)
      if (p) out.priority = p
    } else if (key === 'tasks') out.tasksMode = noteTasksMode(value)
  }
  return out
}

interface ParseTasksOptions {
  /** Scan past the note-level `tasks:` opt-out (#458): the `list_tasks`
   *  includeExcluded / `zn task list --include-excluded` escape hatch. */
  includeExcluded?: boolean
}

function parseTasksFromBody(
  body: string,
  ctx: { path: string; title: string; folder: NoteFolder },
  opts?: ParseTasksOptions
): VaultTask[] {
  const normalized = body.replace(/\r\n/g, '\n')
  const defaults = parseNoteDefaults(normalized)

  // Frontmatter `tasks:` opt-out (#458): 'none' and 'note-only' both silence
  // inline checkboxes. Kept in sync with packages/shared-domain/src/tasks.ts;
  // the value set itself comes from the shared noteTasksMode.
  if (defaults.tasksMode !== 'all' && !opts?.includeExcluded) return []
  const lines = normalized.split('\n')
  const tasks: VaultTask[] = []

  let taskIndex = 0
  let inFence = false
  let fenceMarker: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fenceMatch = line.match(FENCE_LINE_RE)
    if (fenceMatch) {
      const marker = fenceMatch[2]
      if (!inFence) {
        inFence = true
        fenceMarker = marker
      } else if (marker === fenceMarker) {
        inFence = false
        fenceMarker = null
      }
      continue
    }
    if (inFence) continue

    const m = line.match(TASK_LINE_RE)
    if (!m) continue

    const checkedChar = m[1]
    const tail = m[2]
    const checked = checkedChar === 'x' || checkedChar === 'X'
    const cancelled = checkedChar === '-'
    const inProgress = checkedChar === '/'
    const forwarded = checkedChar === '>'

    let due: string | undefined
    let priority: 'high' | 'med' | 'low' | undefined
    let waiting = false
    const tags: string[] = []
    let stripped = tail

    const dueMatch = stripped.match(INLINE_DUE_RE)
    if (dueMatch) {
      if (isValidIsoDate(dueMatch[1])) due = dueMatch[1]
      stripped = stripped.replace(INLINE_DUE_RE, ' ')
    }
    const priMatch = stripped.match(INLINE_PRIORITY_RE)
    if (priMatch) {
      priority = normalizePriority(priMatch[1])
      stripped = stripped.replace(INLINE_PRIORITY_RE, ' ')
    }
    if (INLINE_WAITING_RE.test(stripped)) {
      waiting = true
      stripped = stripped.replace(INLINE_WAITING_RE, ' ')
    }
    INLINE_TAG_RE.lastIndex = 0
    let tm: RegExpExecArray | null
    while ((tm = INLINE_TAG_RE.exec(tail))) {
      const tag = tm[1].toLowerCase()
      if (!tags.includes(tag)) tags.push(tag)
    }
    const content = stripped.replace(/\s+/g, ' ').trim() || tail.trim()

    tasks.push({
      id: `${ctx.path}#${taskIndex}`,
      sourcePath: ctx.path,
      link: buildOpenNoteDeepLink(ctx.path),
      noteTitle: ctx.title,
      noteFolder: ctx.folder,
      lineNumber: i,
      taskIndex,
      rawText: line,
      content,
      checked,
      cancelled,
      inProgress,
      forwarded,
      due: due ?? defaults.due,
      priority: priority ?? defaults.priority,
      waiting,
      tags
    })
    taskIndex += 1
  }
  return tasks
}

/* ---------- File tasks (TaskNotes-style: one task per note) ----------- */

/** The frontmatter tag that marks a whole note as a task (TaskNotes
 *  convention). Kept in sync with packages/shared-domain/src/tasks.ts. */
const TASK_FILE_TAG = 'task'

/** Frontmatter `status:` values treated as complete (checked). */
const DONE_STATUSES = new Set(['done', 'complete', 'completed', 'x'])

/** Frontmatter `status:` values treated as cancelled — abandoned (#450). */
const CANCELLED_STATUSES = new Set(['cancelled', 'canceled'])

/** Frontmatter `status:` values treated as in progress (#512). Still open work. */
const IN_PROGRESS_STATUSES = new Set([
  'in-progress',
  'in progress',
  'inprogress',
  'doing',
  'started',
  'wip'
])

/** Parse a leading frontmatter block into flat fields, handling scalars, inline
 *  arrays (`tags: [a, b]`) and block lists (`tags:` then `  - a`). Keys are
 *  lower-cased; values are a string, or string[] for a list. Best-effort and
 *  never throws — just enough YAML for task files, not a full parser. Kept in
 *  sync with parseFrontmatterFields in packages/shared-domain/src/frontmatter.ts. */
function parseTaskFrontmatter(block: string): Record<string, string | string[]> {
  const data: Record<string, string | string[]> = {}
  let listKey: string | null = null
  for (const rawLine of block.split('\n')) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue
    const item = rawLine.match(/^\s*-\s+(.*)$/)
    if (listKey && /^\s/.test(rawLine) && item) {
      const arr = data[listKey]
      if (Array.isArray(arr)) arr.push(unquote(item[1]))
      continue
    }
    const kv = rawLine.match(/^([A-Za-z0-9_][\w-]*)\s*:\s*(.*)$/)
    if (!kv) {
      listKey = null
      continue
    }
    const key = kv[1].toLowerCase()
    const rest = kv[2].trim()
    if (rest === '') {
      // Bare key: a block list may follow on indented `- item` lines.
      listKey = key
      data[key] = []
      continue
    }
    listKey = null
    if (rest.startsWith('[') && rest.endsWith(']')) {
      data[key] = rest
        .slice(1, -1)
        .split(',')
        .map((s) => unquote(s))
        .filter((s) => s.length > 0)
    } else {
      data[key] = unquote(rest)
    }
  }
  return data
}

function asArray(v: string | string[] | undefined): string[] {
  if (v == null) return []
  return Array.isArray(v) ? v : [v]
}

function firstScalar(v: string | string[] | undefined): string | undefined {
  if (v == null) return undefined
  return Array.isArray(v) ? v[0] : v
}

/**
 * Parse a whole-note "file task" from `body`, or return null when the note is
 * not a task file (its frontmatter `tags` don't include `task`). All metadata
 * comes from frontmatter; the note body is free-form. This is emitted *in
 * addition* to any inline `- [ ]` checkboxes in the same body.
 */
function parseTaskFile(
  body: string,
  ctx: { path: string; title: string; folder: NoteFolder },
  opts?: ParseTasksOptions
): VaultTask | null {
  const normalized = body.replace(/\r\n/g, '\n')
  const m = normalized.match(FRONTMATTER_RE)
  if (!m) return null
  const fm = parseTaskFrontmatter(m[1])

  // `tasks: false` wins over `tags: [task]`; `tasks: note` deliberately falls
  // through, keeping the file task while parseTasksFromBody drops the
  // checkboxes. (#458)
  if (noteTasksMode(fm.tasks) === 'none' && !opts?.includeExcluded) return null

  const tags = asArray(fm.tags).map((t) => t.replace(/^#/, '').toLowerCase())
  if (!tags.includes(TASK_FILE_TAG)) return null

  const status = (firstScalar(fm.status) ?? 'open').toLowerCase()
  const title = firstScalar(fm.title)?.trim() || ctx.title

  return {
    id: `${ctx.path}#task`,
    sourcePath: ctx.path,
    link: buildOpenNoteDeepLink(ctx.path),
    noteTitle: ctx.title,
    noteFolder: ctx.folder,
    lineNumber: 0,
    taskIndex: -1,
    rawText: '',
    content: title,
    checked: DONE_STATUSES.has(status),
    cancelled: CANCELLED_STATUSES.has(status),
    inProgress: IN_PROGRESS_STATUSES.has(status),
    due: normalizeDueDate(firstScalar(fm.due)),
    priority: normalizePriority(firstScalar(fm.priority)),
    waiting: status === 'waiting',
    tags: tags.filter((t) => t !== TASK_FILE_TAG),
    kind: 'file',
    scheduled: normalizeDueDate(firstScalar(fm.scheduled)),
    completedDate: normalizeDueDate(firstScalar(fm.completeddate))
  }
}

/** Add, update, or remove a top-level scalar `key: value` line inside the note's
 *  leading `---` frontmatter block, preserving every other line (including block
 *  lists). `value === null` removes the line. Creates the block when absent.
 *  Operates on \n-normalized text. */
function setFrontmatterScalar(body: string, key: string, value: string | null): string {
  const normalized = body.replace(/\r\n/g, '\n')
  const lowerKey = key.toLowerCase()
  const m = normalized.match(FRONTMATTER_RE)
  if (!m) {
    if (value === null) return normalized
    return `---\n${key}: ${value}\n---\n${normalized}`
  }
  const rest = normalized.slice(m[0].length)
  const lines = m[1].split('\n')
  const idx = lines.findIndex((line) => {
    const kv = line.match(/^([A-Za-z0-9_][\w-]*)\s*:/)
    return kv ? kv[1].toLowerCase() === lowerKey : false
  })
  if (value === null) {
    if (idx >= 0) lines.splice(idx, 1)
  } else if (idx >= 0) {
    lines[idx] = `${key}: ${value}`
  } else {
    lines.push(`${key}: ${value}`)
  }
  return `---\n${lines.join('\n')}\n---\n${rest}`
}

/** Today as a local `YYYY-MM-DD` string, matching the encoding used for `due`. */
function todayIsoLocal(): string {
  const d = new Date()
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${mo}-${day}`
}

/** The vault's `tasks.excludedFolders` list (#458), read straight off
 *  vault.json like readSystemFolderPaths above; validation comes from the
 *  shared normalizer, so the rules cannot drift from the other runtimes. */
/** The vault's Typst preamble folder (#562), read the same way. Preamble notes
 *  are Typst source, so an agent asking for a note's tags must not be handed
 *  `let` and a pile of variable names. */
async function readTypstPreambleFolder(root: string): Promise<string> {
  const settingsPath = path.join(root, INTERNAL_VAULT_DIR, VAULT_SETTINGS_FILE)
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(await fs.readFile(settingsPath, 'utf8')) as Record<string, unknown>
  } catch {
    return DEFAULT_TYPST_PREAMBLE_FOLDER
  }
  const preambles = raw['typstPreambles']
  if (!preambles || typeof preambles !== 'object') return DEFAULT_TYPST_PREAMBLE_FOLDER
  return resolveTypstPreambleFolder((preambles as { folder?: unknown }).folder)
}

async function readTasksExcludedFolders(root: string): Promise<string[]> {
  const settingsPath = path.join(root, INTERNAL_VAULT_DIR, VAULT_SETTINGS_FILE)
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(await fs.readFile(settingsPath, 'utf8')) as Record<string, unknown>
  } catch {
    return []
  }
  const tasks = raw['tasks']
  if (!tasks || typeof tasks !== 'object') return []
  return normalizeTasksExcludedFolders(
    (tasks as { excludedFolders?: unknown }).excludedFolders
  )
}

export async function scanAllTasks(
  root: string,
  opts?: ParseTasksOptions
): Promise<VaultTask[]> {
  const excluded = opts?.includeExcluded ? [] : await readTasksExcludedFolders(root)
  const metas = (await listNotes(root)).filter(
    (m) => m.folder !== 'trash' && !isPathExcludedFromTasks(m.path, excluded)
  )
  const out: VaultTask[] = []
  await Promise.all(
    metas.map(async (meta) => {
      const abs = path.join(root, meta.path.split('/').join(path.sep))
      let body: string
      try {
        body = await fs.readFile(abs, 'utf8')
      } catch {
        return
      }
      const ctx = {
        path: meta.path,
        title: meta.title,
        folder: meta.folder
      }
      const fileTask = parseTaskFile(body, ctx, opts)
      const inline = parseTasksFromBody(body, ctx, opts)
      // File task first, then any inline `- [ ]` checkboxes acting as subtasks.
      if (fileTask) out.push(fileTask, ...inline)
      else out.push(...inline)
    })
  )
  return out
}

/** Toggle a specific task identified by "<path>#<taskIndex>". When the index
 *  segment is the literal `task`, the id names a whole-note file task and the
 *  toggle flips its frontmatter `status` (and `completedDate`) instead of an
 *  inline checkbox. */
export async function toggleTask(root: string, taskId: string): Promise<VaultTask | null> {
  const { rel, indexStr } = splitTaskId(taskId)

  // File task: metadata lives in frontmatter, not a `- [ ]` checkbox line.
  if (indexStr === 'task') {
    const abs = resolveSafe(root, rel)
    const body = await fs.readFile(abs, 'utf8')
    const folder = await folderOf(root, abs)
    if (!folder) throw new Error(`Note not in a known folder: ${rel}`)
    const ctx = {
      path: toPosix(path.relative(root, abs)),
      title: path.basename(abs, path.extname(abs)),
      folder
    }
    // Exclusion-blind on purpose: an explicit task id is an explicit ask, and
    // ids for excluded tasks only circulate via the includeExcluded listing.
    const current = parseTaskFile(body, ctx, { includeExcluded: true })
    if (!current) return null
    const next = toggleFileTaskInBody(body, current.checked)
    await fs.writeFile(abs, next, 'utf8')
    return parseTaskFile(next, ctx, { includeExcluded: true })
  }

  const targetIndex = parseTaskIndex(taskId, indexStr)
  const abs = resolveSafe(root, rel)
  const body = await fs.readFile(abs, 'utf8')
  const newBody = toggleTaskInBody(body, targetIndex)
  if (newBody == null) return null
  await fs.writeFile(abs, newBody, 'utf8')
  const folder = await folderOf(root, abs)
  if (!folder) throw new Error(`Note not in a known folder: ${rel}`)
  const parsed = parseTasksFromBody(
    newBody,
    {
      path: toPosix(path.relative(root, abs)),
      title: path.basename(abs, path.extname(abs)),
      folder
    },
    // The toggle already landed on disk; this re-parse only returns the
    // toggled task, so it must see past a note-level `tasks:` opt-out.
    { includeExcluded: true }
  )
  return parsed[targetIndex] ?? null
}

/** Split "<path>#<taskIndex>" into its halves. `indexStr` is the literal
 *  `task` for a whole-note file task. */
export function splitTaskId(taskId: string): { rel: string; indexStr: string } {
  const hashIdx = taskId.lastIndexOf('#')
  if (hashIdx < 0) throw new Error(`Malformed task id: ${taskId}`)
  return { rel: taskId.slice(0, hashIdx), indexStr: taskId.slice(hashIdx + 1) }
}

/** Flip a file task's frontmatter `status` (and its `completedDate`). */
export function toggleFileTaskInBody(body: string, currentlyChecked: boolean): string {
  // If it is currently done, reopen it; otherwise mark it done.
  if (currentlyChecked) {
    const reopened = setFrontmatterScalar(body, 'status', 'open')
    return setFrontmatterScalar(reopened, 'completedDate', null)
  }
  const done = setFrontmatterScalar(body, 'status', 'done')
  return setFrontmatterScalar(done, 'completedDate', todayIsoLocal())
}

/** The `#<n>` half of a task id, validated. Throws the same way for a local
 *  and a remote vault, so a typo reads identically either side. */
export function parseTaskIndex(taskId: string, indexStr: string): number {
  const targetIndex = Number.parseInt(indexStr, 10)
  if (!Number.isInteger(targetIndex) || targetIndex < 0) {
    throw new Error(`Malformed task index in id: ${taskId}`)
  }
  return targetIndex
}

/** Flip the nth `- [ ]` checkbox in a body, skipping fenced code. Null when
 *  the body holds no task at that index — the caller reports it as gone. */
export function toggleTaskInBody(body: string, targetIndex: number): string | null {
  const normalized = body.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  let taskIndex = 0
  let inFence = false
  let fenceMarker: string | null = null
  let lineNumber = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fenceMatch = line.match(FENCE_LINE_RE)
    if (fenceMatch) {
      const marker = fenceMatch[2]
      if (!inFence) {
        inFence = true
        fenceMarker = marker
      } else if (marker === fenceMarker) {
        inFence = false
        fenceMarker = null
      }
      continue
    }
    if (inFence) continue
    if (!TASK_LINE_RE.test(line)) continue
    if (taskIndex === targetIndex) {
      lineNumber = i
      break
    }
    taskIndex += 1
  }
  if (lineNumber < 0) return null
  const original = lines[lineNumber]
  const toggled = original.replace(
    TASK_LINE_RE,
    (_m, ch: string, tail: string) => {
      const fullMatch = original.match(TASK_LINE_RE)!
      const bracketIdx = original.indexOf('[' + ch + ']')
      // Same rules as the app's toggle (cm-toggle-checkbox / toggleTaskAtIndex):
      // open and done flip, in-progress `[/]` checks off to done, and the
      // forwarded / cancelled record markers are left alone. `[/]` used to fall
      // into the "anything else opens" branch, silently erasing it. (#599)
      if (ch === '>' || ch === '-') return fullMatch[0]
      const next = /[xX]/.test(ch) ? ' ' : 'x'
      // Preserve the full prefix (list marker, whitespace) by splicing only
      // the single character inside the brackets.
      if (bracketIdx >= 0) {
        return (
          original.slice(0, bracketIdx + 1) + next + original.slice(bracketIdx + 2)
        )
      }
      return fullMatch[0]
    }
  )
  lines[lineNumber] = toggled
  return lines.join('\n') + (body.endsWith('\n') && !normalized.endsWith('\n') ? '\n' : '')
}

/* ---------- Convenience edits ---------------------------------------- */

function trimTrailingNewlines(s: string): string {
  return s.replace(/\n+$/g, '')
}

/* The body transforms below are exported as pure functions so the `zn` CLI's
 * remote backend can apply the identical edit to a body it fetched over HTTP
 * (#493). A remote note is read and written through the server's API, but the
 * edit in between has to be the same one a local note gets, or `zn append`
 * would mean two different things depending on where the vault lives. */

/** The note body with `text` added after a blank line. */
export function appendToBody(body: string, text: string): string {
  const normalized = body.replace(/\r\n/g, '\n')
  const sep = normalized.endsWith('\n') || normalized.length === 0 ? '' : '\n'
  return (
    normalized + sep + (normalized.length > 0 ? '\n' : '') + trimTrailingNewlines(text) + '\n'
  )
}

export async function appendToNote(root: string, rel: string, text: string): Promise<NoteMeta> {
  const abs = resolveSafe(root, rel)
  const body = await fs.readFile(abs, 'utf8')
  await fs.writeFile(abs, appendToBody(body, text), 'utf8')
  const folder = await folderOf(root, abs)
  if (!folder) throw new Error(`Note not in a known folder: ${rel}`)
  return await readMeta(root, abs, folder)
}

/** The note body with `text` inserted at the top, below any frontmatter. */
export function prependToBody(body: string, text: string): string {
  const normalized = body.replace(/\r\n/g, '\n')
  const fm = normalized.match(FRONTMATTER_RE)
  const snippet = trimTrailingNewlines(text) + '\n\n'
  if (fm) return fm[0] + snippet + normalized.slice(fm[0].length)
  return snippet + normalized
}

export async function prependToNote(root: string, rel: string, text: string): Promise<NoteMeta> {
  const abs = resolveSafe(root, rel)
  const body = await fs.readFile(abs, 'utf8')
  await fs.writeFile(abs, prependToBody(body, text), 'utf8')
  const folder = await folderOf(root, abs)
  if (!folder) throw new Error(`Note not in a known folder: ${rel}`)
  return await readMeta(root, abs, folder)
}

/** Literal find-and-replace on a body. Pure, so the CLI's remote backend and
 *  the MCP compose the same bytes whichever side of the wire the note is on. */
export function replaceInBody(
  body: string,
  find: string,
  replace: string,
  occurrence: 'first' | 'all' = 'first'
): { body: string; replacements: number } {
  if (!find) throw new Error('find is required')
  if (occurrence === 'all') {
    const parts = body.split(find)
    return { body: parts.join(replace), replacements: parts.length - 1 }
  }
  const idx = body.indexOf(find)
  if (idx < 0) return { body, replacements: 0 }
  return { body: body.slice(0, idx) + replace + body.slice(idx + find.length), replacements: 1 }
}

/** Insert `text` before zero-based `lineNumber` (clamped to the body). Pure,
 *  for the same reason as `replaceInBody`. */
export function insertAtLineInBody(body: string, lineNumber: number, text: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const clamped = Math.max(0, Math.min(lines.length, Math.floor(lineNumber)))
  lines.splice(clamped, 0, ...text.split('\n'))
  return lines.join('\n')
}

export async function replaceInNote(
  root: string,
  rel: string,
  find: string,
  replace: string,
  occurrence: 'first' | 'all' = 'first'
): Promise<{ meta: NoteMeta; replacements: number }> {
  const abs = resolveSafe(root, rel)
  const body = await fs.readFile(abs, 'utf8')
  const { body: next, replacements } = replaceInBody(body, find, replace, occurrence)
  if (replacements === 0) {
    const folder = await folderOf(root, abs)
    if (!folder) throw new Error(`Note not in a known folder: ${rel}`)
    return { meta: await readMeta(root, abs, folder), replacements: 0 }
  }
  await fs.writeFile(abs, next, 'utf8')
  const folder = await folderOf(root, abs)
  if (!folder) throw new Error(`Note not in a known folder: ${rel}`)
  return { meta: await readMeta(root, abs, folder), replacements }
}

export async function insertAtLine(
  root: string,
  rel: string,
  lineNumber: number,
  text: string
): Promise<NoteMeta> {
  const abs = resolveSafe(root, rel)
  const body = await fs.readFile(abs, 'utf8')
  await fs.writeFile(abs, insertAtLineInBody(body, lineNumber, text), 'utf8')
  const folder = await folderOf(root, abs)
  if (!folder) throw new Error(`Note not in a known folder: ${rel}`)
  return await readMeta(root, abs, folder)
}

/* ---------- Backlinks ------------------------------------------------- */

export async function backlinks(root: string, rel: string): Promise<NoteMeta[]> {
  const abs = resolveSafe(root, rel)
  const all = await listNotes(root)
  return backlinksIn(all, toPosix(path.relative(root, abs)))
}

/** Which of `notes` wikilink to the note at `relPath` (a vault-relative posix
 *  path), matching on title and never counting the note itself. Pure so the
 *  CLI's remote backend gets the same answer from a listing it fetched. */
export function backlinksIn(notes: NoteMeta[], relPath: string): NoteMeta[] {
  const fileName = relPath.split('/').pop() ?? relPath
  const dot = fileName.lastIndexOf('.')
  const targetTitle = (dot > 0 ? fileName.slice(0, dot) : fileName).toLowerCase()
  return notes.filter(
    (meta) =>
      meta.path !== relPath && meta.wikilinks.some((w) => w.toLowerCase() === targetTitle)
  )
}
