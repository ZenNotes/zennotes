import { promises as fs, type Dirent } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import type {
  AssetMeta,
  FolderEntry,
  ImportedAsset,
  ImportedAssetKind,
  NoteContent,
  NoteFolder,
  NoteMeta,
  VaultDemoTourResult,
  VaultTextSearchBackendPreference,
  VaultTextSearchCapabilities,
  VaultTextSearchBackendResolved,
  VaultTextSearchToolPaths,
  VaultTextSearchMatch,
  VaultInfo
} from '@shared/ipc'
import { DEMO_TOUR_DIR } from '@shared/demo-tour'
import { DEMO_TOUR_ASSETS, DEMO_TOUR_NOTES } from './demo-tour-data'

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
const execFileAsync = promisify(execFile)
const SEARCHABLE_TEXT_FOLDERS: NoteFolder[] = ['inbox', 'quick', 'archive']
const COMMAND_CHECK_TIMEOUT_MS = 1500
const SEARCH_EXEC_MAX_BUFFER = 64 * 1024 * 1024

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

function searchExecutable(
  kind: 'ripgrep' | 'fzf',
  paths: Required<VaultTextSearchToolPaths>
): string {
  if (kind === 'ripgrep') return paths.ripgrepPath || 'rg'
  return paths.fzfPath || 'fzf'
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

  const value = {
    ripgrep: await commandAvailable(searchExecutable('ripgrep', paths)),
    fzf: await commandAvailable(searchExecutable('fzf', paths))
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
  const top = relPath.split('/')[0]
  if (top === 'inbox' || top === 'quick' || top === 'archive') return top
  return null
}

async function collectBuiltinSearchCandidates(root: string): Promise<VaultTextSearchCandidate[]> {
  const candidates: VaultTextSearchCandidate[] = []
  const walkFolder = async (folder: NoteFolder, dirAbs: string): Promise<void> => {
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const full = path.join(dirAbs, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue
        await walkFolder(folder, full)
        continue
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue

      let body = ''
      try {
        body = await fs.readFile(full, 'utf8')
      } catch {
        continue
      }

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
    }
  }

  for (const folder of SEARCHABLE_TEXT_FOLDERS) {
    await walkFolder(folder, path.join(root, folder))
  }
  return candidates
}

async function collectRipgrepSearchCandidates(
  root: string,
  paths: Required<VaultTextSearchToolPaths>
): Promise<VaultTextSearchCandidate[]> {
  let stdout = ''
  try {
    const result = await execFileAsync(
      searchExecutable('ripgrep', paths),
      [
        '--json',
        '--line-number',
        '--with-filename',
        '--no-heading',
        '--color=never',
        '-g',
        '*.md',
        '^',
        ...SEARCHABLE_TEXT_FOLDERS
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
        ? toPosix((rawPath as { text: string }).text)
        : null
    const rawLineText =
      rawLines && typeof rawLines === 'object' && typeof (rawLines as { text?: unknown }).text === 'string'
        ? (rawLines as { text: string }).text.replace(/\r?\n$/, '')
        : null
    if (!relPath || rawLineText == null || typeof lineNumber !== 'number') continue
    const folder = noteFolderFromRelPath(relPath)
    if (!folder) continue
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
  return await new Promise((resolve, reject) => {
    const child = spawn(
      searchExecutable('fzf', paths),
      ['--filter', query, '--nth=2,6,1', '--tiebreak=index'],
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
      resolve(matches)
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
    const ranked = rankSearchCandidates(trimmed, await collectBuiltinSearchCandidates(root), limit)
    return await hydrateSearchOffsets(root, trimmed, ranked)
  }

  if (backend === 'ripgrep') {
    const ranked = rankSearchCandidates(
      trimmed,
      await collectRipgrepSearchCandidates(root, paths),
      limit
    )
    return await hydrateSearchOffsets(root, trimmed, ranked)
  }

  const candidates = capabilities.ripgrep
    ? await collectRipgrepSearchCandidates(root, paths)
    : await collectBuiltinSearchCandidates(root)
  const ranked = await runFzfSearch(trimmed, candidates, limit, paths)
  return await hydrateSearchOffsets(root, trimmed, ranked)
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
