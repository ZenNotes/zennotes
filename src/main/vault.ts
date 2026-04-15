import { promises as fs, type Dirent } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type {
  AssetMeta,
  FolderEntry,
  ImportedAsset,
  ImportedAssetKind,
  NoteContent,
  NoteFolder,
  NoteMeta,
  VaultInfo
} from '@shared/ipc'

const CONFIG_FILE = 'zennotes.config.json'
const FOLDERS: NoteFolder[] = ['inbox', 'quick', 'archive', 'trash']
const PRIMARY_ATTACHMENTS_DIR = 'attachements'
const LEGACY_ATTACHMENTS_DIRS = ['_assets']
const ATTACHMENTS_DIRS = [PRIMARY_ATTACHMENTS_DIR, ...LEGACY_ATTACHMENTS_DIRS]
const FENCED_CODE_BLOCK_RE = /(^|\n)```[^\n]*\n[\s\S]*?\n```[ \t]*(?=\n|$)/g
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
const PDF_EXTENSIONS = new Set(['.pdf'])
const AUDIO_EXTENSIONS = new Set(['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.wav'])
const VIDEO_EXTENSIONS = new Set(['.m4v', '.mov', '.mp4', '.ogv', '.webm'])

export interface PersistedWindowState {
  x: number
  y: number
  width: number
  height: number
  isMaximized: boolean
}

export interface PersistedConfig {
  vaultRoot: string | null
  windowState: PersistedWindowState | null
}

const DEFAULT_CONFIG: PersistedConfig = {
  vaultRoot: null,
  windowState: null
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
  return {
    vaultRoot: typeof candidate.vaultRoot === 'string' ? candidate.vaultRoot : null,
    windowState: normalizeWindowState(candidate.windowState)
  }
}

export async function loadConfig(): Promise<PersistedConfig> {
  try {
    const raw = await fs.readFile(configPath(), 'utf8')
    return normalizePersistedConfig(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export async function saveConfig(cfg: PersistedConfig): Promise<void> {
  const normalized = normalizePersistedConfig(cfg)
  await fs.mkdir(path.dirname(configPath()), { recursive: true })
  await fs.writeFile(configPath(), JSON.stringify(normalized, null, 2), 'utf8')
}

export async function updateConfig(
  updater: (cfg: PersistedConfig) => PersistedConfig | Promise<PersistedConfig>
): Promise<PersistedConfig> {
  let nextConfig = { ...DEFAULT_CONFIG }
  configWriteQueue = configWriteQueue
    .catch(() => {})
    .then(async () => {
      const current = await loadConfig()
      nextConfig = normalizePersistedConfig(await updater(current))
      await saveConfig(nextConfig)
    })
  await configWriteQueue
  return nextConfig
}

/**
 * Ensure the expected vault folder layout exists and seed a welcome note
 * the very first time a vault is opened.
 */
export async function ensureVaultLayout(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true })
  for (const f of FOLDERS) {
    await fs.mkdir(path.join(root, f), { recursive: true })
  }
  const welcomePath = path.join(root, 'inbox', 'Welcome.md')
  try {
    await fs.access(welcomePath)
  } catch {
    await fs.writeFile(welcomePath, WELCOME_NOTE, 'utf8')
  }
}

export function vaultInfo(root: string): VaultInfo {
  return { root, name: path.basename(root) }
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/')
}

function markdownDestination(p: string): string {
  return `<${p.replace(/>/g, '%3E')}>`
}

function folderOf(root: string, absPath: string): NoteFolder | null {
  const rel = toPosix(path.relative(root, absPath))
  const top = rel.split('/')[0]
  if (FOLDERS.includes(top as NoteFolder)) return top as NoteFolder
  return null
}

function stripCodeContent(body: string): string {
  return body
    // Only treat line-start triple backticks as actual fenced blocks.
    .replace(FENCED_CODE_BLOCK_RE, '$1 ')
    .replace(/`[^`\n]*`/g, ' ')
}

/** Pull unique `#tags` out of markdown text, ignoring fenced/inline code. */
function extractTags(body: string): string[] {
  const stripped = stripCodeContent(body)
  const matches = stripped.match(/(?:^|\s)#([a-zA-Z][\w\-/]*)/g) || []
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
  const stripped = stripCodeContent(body)
  const linkRe = /(!?)\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\)/g
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(stripped)) !== null) {
    let href = (m[2] ?? '').trim()
    if (href.startsWith('<') && href.endsWith('>')) href = href.slice(1, -1)
    if (!href || href.startsWith('#') || href.startsWith('//')) continue
    // Skip URLs (anything with a scheme like http:, mailto:, file:, …).
    if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(href)) continue
    const clean = href.split('#')[0]?.split('?')[0] ?? href
    const lastDot = clean.lastIndexOf('.')
    if (lastDot === -1) continue
    const ext = clean.slice(lastDot).toLowerCase()
    if (
      IMAGE_EXTENSIONS.has(ext) ||
      PDF_EXTENSIONS.has(ext) ||
      AUDIO_EXTENSIONS.has(ext) ||
      VIDEO_EXTENSIONS.has(ext)
    ) {
      return true
    }
  }
  return false
}

/** Pull unique `[[wikilink]]` targets out of markdown text. Supports
 *  `[[target|label]]` by discarding the label. Ignores fenced/inline code. */
function extractWikilinks(body: string): string[] {
  const stripped = stripCodeContent(body)
  const re = /\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/g
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(stripped)) !== null) {
    seen.add(m[1].trim())
  }
  return [...seen]
}

/** Build a short plaintext preview from markdown. */
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

async function readMeta(
  root: string,
  abs: string,
  folder: NoteFolder,
  siblingOrder?: number
): Promise<NoteMeta> {
  const stat = await fs.stat(abs)
  let body = ''
  try {
    body = await fs.readFile(abs, 'utf8')
  } catch {
    /* ignore — treat as empty */
  }
  return {
    path: toPosix(path.relative(root, abs)),
    title: path.basename(abs, path.extname(abs)),
    folder,
    siblingOrder: siblingOrder ?? (await readSiblingOrder(abs)),
    createdAt: stat.birthtimeMs || stat.ctimeMs,
    updatedAt: stat.mtimeMs,
    size: stat.size,
    tags: extractTags(body),
    wikilinks: extractWikilinks(body),
    hasAttachments: bodyHasLocalAsset(body),
    excerpt: buildExcerpt(body)
  }
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

/**
 * Walk every directory under the three top-level folders and return a
 * flat list of folder entries. This is the source of truth for the
 * sidebar tree — empty folders that contain no notes are otherwise
 * invisible, because notes are the only things we track per-file.
 */
export async function listFolders(root: string): Promise<FolderEntry[]> {
  const out: FolderEntry[] = []
  for (const folder of FOLDERS) {
    const topAbs = path.join(root, folder)
    const walk = async (dirAbs: string, subpath: string): Promise<void> => {
      let entries: Dirent[]
      try {
        entries = await fs.readdir(dirAbs, { withFileTypes: true })
      } catch {
        return
      }
      for (const [index, e] of entries.entries()) {
        if (!e.isDirectory()) continue
        if (e.name.startsWith('.')) continue
        const nextSub = subpath ? `${subpath}/${e.name}` : e.name
        out.push({ folder, subpath: nextSub, siblingOrder: index })
        await walk(path.join(dirAbs, e.name), nextSub)
      }
    }
    await walk(topAbs, '')
  }
  return out
}

export async function listNotes(root: string): Promise<NoteMeta[]> {
  const metas: NoteMeta[] = []
  const walkFolder = async (folder: NoteFolder, dirAbs: string): Promise<void> => {
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true })
    } catch {
      return
    }
    for (const [index, entry] of entries.entries()) {
      const full = path.join(dirAbs, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue
        await walkFolder(folder, full)
        continue
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        metas.push(await readMeta(root, full, folder, index))
      }
    }
  }

  for (const folder of FOLDERS) {
    await walkFolder(folder, path.join(root, folder))
  }
  return metas
}

function resolveSafe(root: string, rel: string): string {
  const abs = path.resolve(root, rel)
  if (!abs.startsWith(path.resolve(root))) {
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
  const folder = folderOf(root, abs)
  if (!folder) throw new Error(`Note not in a known folder: ${rel}`)
  return await readMeta(root, abs, folder)
}

async function uniqueTitle(dir: string, baseTitle: string): Promise<string> {
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

export async function createNote(
  root: string,
  folder: NoteFolder,
  title?: string,
  subpath = ''
): Promise<NoteMeta> {
  const base = (title && title.trim()) || 'Untitled'
  const clean = subpath.replace(/^\/+|\/+$/g, '')
  const dir = clean
    ? resolveSafe(root, path.posix.join(folder, clean))
    : path.join(root, folder)
  await fs.mkdir(dir, { recursive: true })
  const finalTitle = await uniqueTitle(dir, base)
  const abs = path.join(dir, `${finalTitle}.md`)
  const body = `# ${finalTitle}\n\n`
  await fs.writeFile(abs, body, 'utf8')
  return await readMeta(root, abs, folder)
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
  const trimmed = nextTitle.trim() || 'Untitled'
  const target = path.join(dir, `${trimmed}.md`)
  if (target !== abs) {
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
  return await readMeta(root, target, folder)
}

async function moveBetweenFolders(
  root: string,
  rel: string,
  target: NoteFolder
): Promise<NoteMeta> {
  const abs = resolveSafe(root, rel)
  const filename = path.basename(abs)
  const destDir = path.join(root, target)
  await fs.mkdir(destDir, { recursive: true })
  const baseTitle = path.basename(filename, path.extname(filename))
  const finalTitle = await uniqueTitle(destDir, baseTitle)
  const destAbs = path.join(destDir, `${finalTitle}.md`)
  await fs.rename(abs, destAbs)
  return await readMeta(root, destAbs, target)
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
    await Promise.all(
      entries.map((e) => fs.rm(path.join(trashDir, e), { recursive: true, force: true }))
    )
  } catch {
    /* no trash dir yet */
  }
}

export async function deleteNote(root: string, rel: string): Promise<void> {
  const abs = resolveSafe(root, rel)
  await fs.rm(abs, { force: true })
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
  const abs = resolveSafe(root, path.posix.join(topFolder, trimmed))
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

  const oldAbs = resolveSafe(root, path.posix.join(topFolder, oldClean))
  const newAbs = resolveSafe(root, path.posix.join(topFolder, newClean))
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
  const abs = resolveSafe(root, path.posix.join(topFolder, clean))
  await fs.rm(abs, { recursive: true, force: true })
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
  const oldAbs = resolveSafe(root, path.posix.join(topFolder, clean))
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
  return path
    .relative(path.join(root, topFolder), newAbs)
    .split(path.sep)
    .join('/')
}

/** Build the absolute on-disk path for a vault folder / subfolder. */
export function folderAbsolutePath(
  root: string,
  topFolder: NoteFolder,
  subpath: string
): string {
  const clean = subpath.replace(/^\/+|\/+$/g, '')
  return clean
    ? resolveSafe(root, path.posix.join(topFolder, clean))
    : path.join(root, topFolder)
}

export function assetsAbsolutePath(root: string): string {
  return path.join(root, PRIMARY_ATTACHMENTS_DIR)
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
  const walk = async (dirAbs: string): Promise<void> => {
    let entries: Dirent[]
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
      const rel = toPosix(path.relative(root, full))
      out.push({
        path: rel,
        name: path.basename(full),
        kind: classifyImportedAsset(entry.name),
        size: stat.size,
        updatedAt: stat.mtimeMs
      })
    }
  }

  for (const dirName of ATTACHMENTS_DIRS) {
    const attachmentsRoot = path.join(root, dirName)
    try {
      const stat = await fs.stat(attachmentsRoot)
      if (!stat.isDirectory()) continue
    } catch {
      continue
    }
    await walk(attachmentsRoot)
  }
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
  const destDir = cleanSub
    ? resolveSafe(root, path.posix.join(targetFolder, cleanSub))
    : path.join(root, targetFolder)

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
  return await readMeta(root, destAbs, targetFolder)
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
  return await readMeta(root, destAbs, folder)
}

export async function importFiles(
  root: string,
  noteRelPath: string,
  sourcePaths: string[]
): Promise<ImportedAsset[]> {
  const assetsDir = assetsAbsolutePath(root)
  await fs.mkdir(assetsDir, { recursive: true })

  const noteDir = path.posix.dirname(toPosix(noteRelPath))
  const imported: ImportedAsset[] = []

  for (const sourcePath of sourcePaths) {
    const sourceAbs = path.resolve(sourcePath)
    const stat = await fs.stat(sourceAbs)
    if (!stat.isFile()) continue

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
- **Full-text search** — press ⌘K from anywhere

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
