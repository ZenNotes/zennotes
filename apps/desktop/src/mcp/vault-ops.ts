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

export type NoteFolder = 'inbox' | 'quick' | 'archive' | 'trash'
const FOLDERS: NoteFolder[] = ['inbox', 'quick', 'archive', 'trash']
const LIVE_FOLDERS: NoteFolder[] = ['inbox', 'quick', 'archive']
const PRIMARY_ATTACHMENTS_DIR = 'attachements'
const LEGACY_ATTACHMENTS_DIRS = ['_assets']
const ATTACHMENTS_DIRS = [PRIMARY_ATTACHMENTS_DIR, ...LEGACY_ATTACHMENTS_DIRS]

const FENCED_CODE_BLOCK_RE = /(^|\n)```[^\n]*\n[\s\S]*?\n```[ \t]*(?=\n|$)/g
const FENCE_LINE_RE = /^(\s{0,3})(`{3,}|~{3,})/
const TASK_LINE_RE = /^\s*[-*+]\s+\[([ xX])\](.*)$/

export interface NoteMeta {
  path: string
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
  noteTitle: string
  noteFolder: NoteFolder
  lineNumber: number
  taskIndex: number
  rawText: string
  content: string
  checked: boolean
  due?: string
  priority?: 'high' | 'med' | 'low'
  waiting: boolean
  tags: string[]
}

/* ---------- Path + config helpers ------------------------------------ */

function userDataDir(): string {
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

export async function readVaultRootFromConfig(): Promise<string | null> {
  const configPath = path.join(userDataDir(), 'zennotes.config.json')
  try {
    const raw = await fs.readFile(configPath, 'utf8')
    const parsed = JSON.parse(raw) as { vaultRoot?: unknown }
    return typeof parsed.vaultRoot === 'string' && parsed.vaultRoot.trim() ? parsed.vaultRoot : null
  } catch {
    return null
  }
}

export async function resolveVaultRoot(): Promise<string> {
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

function folderOf(root: string, abs: string): NoteFolder | null {
  const rel = toPosix(path.relative(root, abs))
  const top = rel.split('/')[0]
  if (FOLDERS.includes(top as NoteFolder)) return top as NoteFolder
  return null
}

/* ---------- Markdown parsing ----------------------------------------- */

function stripCodeContent(body: string): string {
  return body.replace(FENCED_CODE_BLOCK_RE, '$1 ').replace(/`[^`\n]*`/g, ' ')
}

function extractTags(body: string): string[] {
  const stripped = stripCodeContent(body)
  const matches = stripped.match(/(?:^|\s)#([a-zA-Z][\w\-/]*)/g) || []
  const seen = new Set<string>()
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
  return {
    path: toPosix(path.relative(root, abs)),
    title: path.basename(abs, path.extname(abs)),
    folder,
    createdAt: stat.birthtimeMs || stat.ctimeMs,
    updatedAt: stat.mtimeMs,
    size: stat.size,
    tags: extractTags(body),
    wikilinks: extractWikilinks(body),
    excerpt: buildExcerpt(body)
  }
}

/* ---------- Listing --------------------------------------------------- */

export async function listNotes(root: string): Promise<NoteMeta[]> {
  const out: NoteMeta[] = []
  const walk = async (folder: NoteFolder, dirAbs: string): Promise<void> => {
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
        await walk(folder, full)
        continue
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        out.push(await readMeta(root, full, folder))
      }
    }
  }
  for (const folder of FOLDERS) await walk(folder, path.join(root, folder))
  return out
}

export async function listFolders(root: string): Promise<{ folder: NoteFolder; subpath: string }[]> {
  const out: { folder: NoteFolder; subpath: string }[] = []
  for (const folder of FOLDERS) {
    const topAbs = path.join(root, folder)
    const walk = async (dirAbs: string, subpath: string): Promise<void> => {
      let entries
      try {
        entries = await fs.readdir(dirAbs, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue
        const nextSub = subpath ? `${subpath}/${e.name}` : e.name
        out.push({ folder, subpath: nextSub })
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
  const dir = clean
    ? resolveSafe(root, path.posix.join(folder, clean))
    : path.join(root, folder)
  await fs.mkdir(dir, { recursive: true })
  const finalTitle = await uniqueTitle(dir, base)
  const abs = path.join(dir, `${finalTitle}.md`)
  const content = body ?? `# ${finalTitle}\n\n`
  await fs.writeFile(abs, content, 'utf8')
  return await readMeta(root, abs, folder)
}

export async function renameNote(root: string, rel: string, nextTitle: string): Promise<NoteMeta> {
  const abs = resolveSafe(root, rel)
  const folder = folderOf(root, abs)
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
  const destDir = cleanSub
    ? resolveSafe(root, path.posix.join(targetFolder, cleanSub))
    : path.join(root, targetFolder)
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

export async function deleteNote(root: string, rel: string): Promise<void> {
  const abs = resolveSafe(root, rel)
  await fs.rm(abs, { force: true })
}

export async function emptyTrash(root: string): Promise<void> {
  const trashDir = path.join(root, 'trash')
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
  const abs = resolveSafe(root, path.posix.join(topFolder, clean))
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
  const oldAbs = resolveSafe(root, path.posix.join(topFolder, oldClean))
  const newAbs = resolveSafe(root, path.posix.join(topFolder, newClean))
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
  const abs = resolveSafe(root, path.posix.join(topFolder, clean))
  await fs.rm(abs, { recursive: true, force: true })
}

/* ---------- Text search ---------------------------------------------- */

export interface VaultTextSearchMatch {
  path: string
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
  const out: VaultTextSearchMatch[] = []
  const walk = async (folder: NoteFolder, dirAbs: string): Promise<void> => {
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
        await walk(folder, full)
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
    await walk(folder, path.join(root, folder))
  }
  return out
}

/* ---------- Tasks ---------------------------------------------------- */

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/
const INLINE_DUE_RE = /(?:^|\s)due:(\S+)/i
const INLINE_PRIORITY_RE = /(?:^|\s)!(high|med|medium|low|h|m|l)\b/i
const INLINE_WAITING_RE = /(?:^|\s)@waiting\b/i
const INLINE_TAG_RE = /(?:^|\s)#([a-z0-9][a-z0-9/_-]*)/gi

function normalizePriority(raw: string | undefined): 'high' | 'med' | 'low' | undefined {
  if (!raw) return undefined
  const v = raw.toLowerCase().trim()
  if (v === 'high' || v === 'h') return 'high'
  if (v === 'med' || v === 'medium' || v === 'm') return 'med'
  if (v === 'low' || v === 'l') return 'low'
  return undefined
}

function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  return Number.isFinite(Date.parse(`${s}T00:00:00Z`))
}

function parseNoteDefaults(body: string): { due?: string; priority?: 'high' | 'med' | 'low' } {
  const m = body.match(FRONTMATTER_RE)
  if (!m) return {}
  const out: { due?: string; priority?: 'high' | 'med' | 'low' } = {}
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
    }
  }
  return out
}

function parseTasksFromBody(
  body: string,
  ctx: { path: string; title: string; folder: NoteFolder }
): VaultTask[] {
  const normalized = body.replace(/\r\n/g, '\n')
  const defaults = parseNoteDefaults(normalized)
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
      noteTitle: ctx.title,
      noteFolder: ctx.folder,
      lineNumber: i,
      taskIndex,
      rawText: line,
      content,
      checked,
      due: due ?? defaults.due,
      priority: priority ?? defaults.priority,
      waiting,
      tags
    })
    taskIndex += 1
  }
  return tasks
}

export async function scanAllTasks(root: string): Promise<VaultTask[]> {
  const metas = (await listNotes(root)).filter((m) => m.folder !== 'trash')
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
      const parsed = parseTasksFromBody(body, {
        path: meta.path,
        title: meta.title,
        folder: meta.folder
      })
      out.push(...parsed)
    })
  )
  return out
}

/** Toggle a specific task identified by "<path>#<taskIndex>". */
export async function toggleTask(root: string, taskId: string): Promise<VaultTask | null> {
  const hashIdx = taskId.lastIndexOf('#')
  if (hashIdx < 0) throw new Error(`Malformed task id: ${taskId}`)
  const rel = taskId.slice(0, hashIdx)
  const indexStr = taskId.slice(hashIdx + 1)
  const targetIndex = Number.parseInt(indexStr, 10)
  if (!Number.isInteger(targetIndex) || targetIndex < 0) {
    throw new Error(`Malformed task index in id: ${taskId}`)
  }
  const abs = resolveSafe(root, rel)
  const body = await fs.readFile(abs, 'utf8')
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
      const next = ch === ' ' ? 'x' : ' '
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
  const newBody = lines.join('\n') + (body.endsWith('\n') && !normalized.endsWith('\n') ? '\n' : '')
  await fs.writeFile(abs, newBody, 'utf8')
  const folder = folderOf(root, abs)
  if (!folder) throw new Error(`Note not in a known folder: ${rel}`)
  const parsed = parseTasksFromBody(newBody, {
    path: toPosix(path.relative(root, abs)),
    title: path.basename(abs, path.extname(abs)),
    folder
  })
  return parsed[targetIndex] ?? null
}

/* ---------- Convenience edits ---------------------------------------- */

function trimTrailingNewlines(s: string): string {
  return s.replace(/\n+$/g, '')
}

export async function appendToNote(root: string, rel: string, text: string): Promise<NoteMeta> {
  const abs = resolveSafe(root, rel)
  const body = await fs.readFile(abs, 'utf8')
  const normalized = body.replace(/\r\n/g, '\n')
  const sep = normalized.endsWith('\n') || normalized.length === 0 ? '' : '\n'
  const next = normalized + sep + (normalized.length > 0 ? '\n' : '') + trimTrailingNewlines(text) + '\n'
  await fs.writeFile(abs, next, 'utf8')
  const folder = folderOf(root, abs)
  if (!folder) throw new Error(`Note not in a known folder: ${rel}`)
  return await readMeta(root, abs, folder)
}

export async function prependToNote(root: string, rel: string, text: string): Promise<NoteMeta> {
  const abs = resolveSafe(root, rel)
  const body = await fs.readFile(abs, 'utf8')
  const normalized = body.replace(/\r\n/g, '\n')
  const fm = normalized.match(FRONTMATTER_RE)
  const snippet = trimTrailingNewlines(text) + '\n\n'
  let next: string
  if (fm) {
    const after = normalized.slice(fm[0].length)
    next = fm[0] + snippet + after
  } else {
    next = snippet + normalized
  }
  await fs.writeFile(abs, next, 'utf8')
  const folder = folderOf(root, abs)
  if (!folder) throw new Error(`Note not in a known folder: ${rel}`)
  return await readMeta(root, abs, folder)
}

export async function replaceInNote(
  root: string,
  rel: string,
  find: string,
  replace: string,
  occurrence: 'first' | 'all' = 'first'
): Promise<{ meta: NoteMeta; replacements: number }> {
  if (!find) throw new Error('find is required')
  const abs = resolveSafe(root, rel)
  const body = await fs.readFile(abs, 'utf8')
  let replacements = 0
  let next: string
  if (occurrence === 'all') {
    const parts = body.split(find)
    replacements = parts.length - 1
    next = parts.join(replace)
  } else {
    const idx = body.indexOf(find)
    if (idx < 0) {
      next = body
    } else {
      next = body.slice(0, idx) + replace + body.slice(idx + find.length)
      replacements = 1
    }
  }
  if (replacements === 0) {
    const folder = folderOf(root, abs)
    if (!folder) throw new Error(`Note not in a known folder: ${rel}`)
    return { meta: await readMeta(root, abs, folder), replacements: 0 }
  }
  await fs.writeFile(abs, next, 'utf8')
  const folder = folderOf(root, abs)
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
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const clamped = Math.max(0, Math.min(lines.length, Math.floor(lineNumber)))
  const insertLines = text.split('\n')
  lines.splice(clamped, 0, ...insertLines)
  await fs.writeFile(abs, lines.join('\n'), 'utf8')
  const folder = folderOf(root, abs)
  if (!folder) throw new Error(`Note not in a known folder: ${rel}`)
  return await readMeta(root, abs, folder)
}

/* ---------- Backlinks ------------------------------------------------- */

export async function backlinks(root: string, rel: string): Promise<NoteMeta[]> {
  const abs = resolveSafe(root, rel)
  const targetTitle = path.basename(abs, path.extname(abs)).toLowerCase()
  const all = await listNotes(root)
  const refs: NoteMeta[] = []
  for (const meta of all) {
    if (meta.path === toPosix(path.relative(root, abs))) continue
    if (meta.wikilinks.some((w) => w.toLowerCase() === targetTitle)) {
      refs.push(meta)
    }
  }
  return refs
}
