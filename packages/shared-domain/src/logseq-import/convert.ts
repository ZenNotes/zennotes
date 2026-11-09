/**
 * Turns a Logseq graph into ZenNotes notes. Pure: it takes the graph's files as
 * text and gives back every note's path and body plus where each file goes, so
 * the desktop app, the web app and the phones can all run the same conversion.
 *
 * What comes over, and as what:
 *
 *   - `pages/*.md` become notes named after the page's title (`title::` wins
 *     over the file name). A namespace page, `a/b`, becomes `b` in a folder `a`,
 *     because ZenNotes already has folders and a page named `a/b` could not be a
 *     file name anyway.
 *   - `journals/*.md` become daily notes where the vault keeps them, under its
 *     own title pattern. A day that already has a daily note keeps its journal
 *     in the import folder instead, so nothing is ever written over.
 *   - The outline. A top-level block with nothing under it reads as a paragraph,
 *     a top-level heading block as a heading with its children under it, and
 *     everything else stays a nested list. `bullets` keeps every block a bullet.
 *   - Page properties become frontmatter (`alias::` as `aliases:`). Logseq's own
 *     block properties (`id::`, `collapsed::`, `heading::`, ...) are dropped; one
 *     a person wrote stays as the line they wrote.
 *   - `[[Page]]` stays a wikilink, pinned to its path when the name alone would
 *     not find it. `#[[two words]]` becomes `#two-words`.
 *   - `((uuid))` becomes a link to that block (`[[Note^uuid|its text]]`), and
 *     the block gets a `^uuid` anchor. Embeds become `![[...]]`.
 *   - Tasks: TODO/LATER/WAIT are open, NOW/DOING are in progress (`[/]`), DONE
 *     is done, CANCELED is cancelled (`[-]`). `[#A]` is `!high`, a deadline (or a
 *     schedule, when there is no deadline) is `due:`, and a repeater is
 *     `@repeat:`.
 *   - Files under `assets/` go to the import folder's `assets/`, with links
 *     rewritten to reach them.
 *   - Anything ZenNotes has nothing for (queries, other macros, Org mode pages,
 *     whiteboards) stays exactly as written, in a code block, and the report
 *     lists it. Nothing is dropped without a line in the report.
 */
import { yamlValue } from '../frontmatter'
import { formatLogseqDate, parseLogseqDate, type LogseqConfig } from './config'
import { parseLogseqPage, PROPERTY_RE, type LogseqBlock, type LogseqPage } from './outline'

export interface LogseqSourceFile {
  /** Path from the graph's top, POSIX: `pages/a___b.md`. */
  rel: string
  text: string
}

export interface LogseqGraph {
  config: LogseqConfig
  /** Markdown under `pages/`. */
  pages: LogseqSourceFile[]
  /** Markdown under `journals/`. */
  journals: LogseqSourceFile[]
  /** `.org` files under `pages/` or `journals/`. */
  orgFiles: LogseqSourceFile[]
  /** Every other file worth copying, from the graph's top: `assets/...`,
   *  `draws/...`, `whiteboards/...`. */
  assets: string[]
}

export interface LogseqImportOptions {
  /** The folder the import makes, from the vault's root: `Logseq`. */
  folder: string
  /** Where the journal for a date goes, from the vault's root with `.md`, or
   *  null to keep it in the import folder. Leave it out to keep them all there. */
  journalPath?: (date: string) => string | null
  /** Dates whose journal stays in the import folder because the day already has
   *  a daily note. Only for the report. */
  takenJournalDates?: string[]
  /** Notes already in the vault, from its root. */
  existingNotes: string[]
  /** Keep every block a bullet, as Logseq shows it. */
  bullets?: boolean
  /** False writes `tasks: false` into notes with checkboxes, so they stay out of Tasks. */
  includeTasks?: boolean
  today?: string
}

export type LogseqNoteKind = 'page' | 'journal' | 'org'

export interface LogseqPlannedNote {
  /** From the vault's root, with `.md`. */
  path: string
  /** From the graph's top. */
  source: string
  kind: LogseqNoteKind
  title: string
  body: string
  /** It lands outside the import folder: a journal in the daily notes folder. */
  outside: boolean
  /** For a journal, its date. */
  date?: string
}

export interface LogseqPlannedAsset {
  source: string
  /** From the vault's root. */
  path: string
}

export type LogseqVerbatimKind = 'query' | 'macro' | 'org-block' | 'org-page' | 'whiteboard'

export interface LogseqImportStats {
  pages: number
  journals: number
  /** Journals written as daily notes. */
  journalsInDailyNotes: number
  orgPages: number
  assets: number
  blockRefs: number
  /** `((uuid))` pointing at a block the graph does not have. */
  missingBlockRefs: number
  embeds: number
  /** `:LOGBOOK:` drawers left out. */
  logbooks: number
  /** Per kind, how many and in which notes (or files, for whiteboards). */
  verbatim: Record<LogseqVerbatimKind, { count: number; paths: string[] }>
}

export interface LogseqImportPlan {
  notes: LogseqPlannedNote[]
  assets: LogseqPlannedAsset[]
  stats: LogseqImportStats
  /** The report note's path and body. */
  report: { path: string; body: string }
}

export const LOGSEQ_REPORT_NAME = 'Import Report.md'
export const LOGSEQ_JOURNALS_DIR = 'Journals'

// ---------------------------------------------------------------------------
// Paths and names
// ---------------------------------------------------------------------------

const lower = (value: string): string => value.toLowerCase()
const stripMd = (path: string): string => path.replace(/\.md$/i, '')
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
const dirName = (path: string): string => {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}
const stem = (rel: string): string => baseName(rel).replace(/\.(md|markdown|org)$/i, '')

function decodePercent(value: string): string {
  return value.replace(/(%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run)
    } catch {
      return run
    }
  })
}

/** The page title a file name spells, under the graph's `:file/name-format`. */
export function logseqTitleFromFileName(name: string, format: LogseqConfig['fileNameFormat']): string {
  if (format === 'triple-lowbar') return decodePercent(name.replace(/___/g, '/'))
  // The legacy format wrote a namespace's `/` as `%2F` once it encoded names,
  // and as `.` before that. Logseq reads a dot as a namespace only in a name
  // with nothing encoded in it, and so does this.
  if (/%[0-9A-Fa-f]{2}/.test(name)) return decodePercent(name)
  return name.replace(/\./g, '/')
}

/** The date a journal's file name spells, as YYYY-MM-DD, or null for a file in
 *  journals/ that is not one. Logseq's two stock formats are tried after the
 *  graph's own, since a graph that changed format keeps its older files. */
export function logseqJournalDate(rel: string, config: LogseqConfig): string | null {
  const name = stem(rel)
  return (
    parseLogseqDate(name, config.journalFileFormat) ??
    parseLogseqDate(name, 'yyyy_MM_dd') ??
    parseLogseqDate(name, 'yyyy-MM-dd')
  )
}

/** Characters a ZenNotes note name cannot hold (see wikilinks.ts). */
const INVALID_NAME_CHARS = /[\\:*?"<>|#^[\]]/g

/** One path segment, safe as a file name on every system ZenNotes runs on. */
export function safeNoteName(segment: string): string {
  let name = segment.replace(INVALID_NAME_CHARS, '-').replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim()
  name = name.replace(/^\.+/, '').replace(/[. ]+$/, '')
  if (name.length > 150) name = name.slice(0, 150).trim()
  return name || 'Untitled'
}

/** A Logseq tag or page name as a ZenNotes tag: spaces become hyphens. */
export function logseqTag(name: string): string {
  return name
    .trim()
    .replace(/^#/, '')
    .replace(/^\[\[|\]\]$/g, '')
    .replace(/\s+/g, '-')
    .replace(/[,;"'`]/g, '')
}

function relativePath(fromDir: string, to: string): string {
  const from = fromDir ? fromDir.split('/') : []
  const target = to.split('/')
  let common = 0
  while (common < from.length && common < target.length - 1 && from[common] === target[common]) common++
  return [...from.slice(common).map(() => '..'), ...target.slice(common)].join('/')
}

function normalizeRelative(fromDir: string, target: string): string | null {
  const parts = fromDir ? fromDir.split('/') : []
  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else {
      parts.push(part)
    }
  }
  return parts.join('/')
}

function destination(path: string): string {
  return /[\s()<>]/.test(path) ? `<${path}>` : path
}

function fenceFor(lines: string[], char = '`'): string {
  let longest = 0
  for (const line of lines) {
    for (const run of line.match(char === '`' ? /`+/g : /~+/g) ?? []) longest = Math.max(longest, run.length)
  }
  return char.repeat(Math.max(3, longest + 1))
}

// ---------------------------------------------------------------------------
// Inline text
// ---------------------------------------------------------------------------

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
const BLOCK_REF_RE = new RegExp(`\\(\\((${UUID})\\)\\)`, 'g')
const MACRO_RE = /\{\{([\s\S]*?)\}\}/g
const LINK_TO_BLOCK_RE = new RegExp(`\\[([^\\]\\n]*)\\]\\(\\(\\((${UUID})\\)\\)\\)`, 'g')
const LINK_TO_PAGE_RE = /\[([^\]\n]*)\]\(\[\[([^\]\n]+)\]\]\)/g
const TAG_PAGE_RE = /#\[\[([^\]\n]+)\]\]/g
const PAGE_REF_RE = /\[\[([^[\]\n]+)\]\]/g
const MD_LINK_RE = /(!?)\[([^\]\n]*)\]\((<[^>\n]+>|[^()\s]+)((?:\s+"[^"\n]*")?)\)(\{[^}\n]*\})?/g
const HIGHLIGHT_RE = /\^\^([^^\n]+?)\^\^/g
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i
const VIDEO_MACROS = new Set(['video', 'youtube', 'vimeo', 'bilibili'])
const LINK_MACROS = new Set(['tweet', 'twitter'])

/** Split a line around inline code spans, which are left as they are. */
function splitCode(line: string): Array<{ code: boolean; text: string }> {
  const out: Array<{ code: boolean; text: string }> = []
  let plain = ''
  let i = 0
  while (i < line.length) {
    if (line[i] !== '`') {
      plain += line[i]
      i += 1
      continue
    }
    let n = 0
    while (line[i + n] === '`') n++
    let close = -1
    for (let j = i + n; j < line.length; ) {
      const k = line.indexOf('`', j)
      if (k < 0) break
      let m = 0
      while (line[k + m] === '`') m++
      if (m === n) {
        close = k
        break
      }
      j = k + m
    }
    if (close < 0) {
      plain += line.slice(i, i + n)
      i += n
      continue
    }
    if (plain) out.push({ code: false, text: plain })
    plain = ''
    out.push({ code: true, text: line.slice(i, close + n) })
    i = close + n
  }
  if (plain) out.push({ code: false, text: plain })
  return out
}

function codeSpan(text: string): string {
  let longest = 0
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  const ticks = '`'.repeat(longest + 1)
  return longest > 0 ? `${ticks} ${text} ${ticks}` : `${ticks}${text}${ticks}`
}

/** A block's first line as plain words, for a link that stands in for it. */
function plainText(line: string): string {
  const text = line
    .replace(MACRO_RE, ' ')
    .replace(BLOCK_REF_RE, ' ')
    .replace(TAG_PAGE_RE, '$1')
    .replace(PAGE_REF_RE, '$1')
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/^#{1,6}\s+/, '')
    .replace(/[[\]|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return 'block'
  return text.length > 100 ? `${text.slice(0, 99).trimEnd()}…` : text
}

/** Logseq macro name and argument: `{{embed [[Page]]}}` is `embed`, `[[Page]]`. */
function macroParts(inner: string): { name: string; arg: string } {
  const trimmed = inner.trim()
  const space = trimmed.search(/\s/)
  return space < 0
    ? { name: lower(trimmed), arg: '' }
    : { name: lower(trimmed.slice(0, space)), arg: trimmed.slice(space + 1).trim() }
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

interface NoteDraft {
  note: LogseqPlannedNote
  page: LogseqPage | null
  /** Source dir from the graph's top, for relative asset links. */
  sourceDir: string
  /** Page properties as written. */
  properties: Array<{ key: string; value: string }>
}

interface BlockTarget {
  draft: NoteDraft
  block: LogseqBlock
}

/** Logseq's bookkeeping on a block; nothing a person reads. */
function isSystemBlockProperty(key: string): boolean {
  return (
    key === 'id' ||
    key === 'collapsed' ||
    key === 'heading' ||
    key === 'background-color' ||
    key === 'background-image' ||
    key.startsWith('logseq.') ||
    key.startsWith('card-') ||
    key.startsWith('query-') ||
    key === 'hl-page' ||
    key === 'hl-stamp' ||
    key === 'ls-type'
  )
}

/** Page properties that are Logseq's own state, not the page's. */
const DROPPED_PAGE_PROPERTIES = new Set(['filters', 'collapsed', 'id', 'icon'])

function newStats(): LogseqImportStats {
  const verbatim = {} as LogseqImportStats['verbatim']
  for (const kind of ['query', 'macro', 'org-block', 'org-page', 'whiteboard'] as const) {
    verbatim[kind] = { count: 0, paths: [] }
  }
  return {
    pages: 0,
    journals: 0,
    journalsInDailyNotes: 0,
    orgPages: 0,
    assets: 0,
    blockRefs: 0,
    missingBlockRefs: 0,
    embeds: 0,
    logbooks: 0,
    verbatim
  }
}

function splitList(value: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (let i = 0; i < value.length; i++) {
    if (value.startsWith('[[', i)) depth += 1
    if (value.startsWith(']]', i)) depth = Math.max(0, depth - 1)
    if (value[i] === ',' && depth === 0) {
      out.push(current)
      current = ''
      continue
    }
    current += value[i]
  }
  out.push(current)
  return out
    .map((part) => part.trim().replace(/^#/, '').replace(/^\[\[|\]\]$/g, '').trim())
    .filter(Boolean)
}

function frontmatterKey(key: string): string {
  if (key === 'alias') return 'aliases'
  return key.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+/, '') || 'property'
}

export function planLogseqImport(graph: LogseqGraph, options: LogseqImportOptions): LogseqImportPlan {
  const { config } = graph
  const folder = options.folder.replace(/^\/+|\/+$/g, '')
  const stats = newStats()
  const taken = new Set<string>([lower(`${folder}/${LOGSEQ_REPORT_NAME}`)])
  const claim = (dir: string, name: string): string => {
    let candidate = `${dir}/${name}.md`
    for (let n = 2; taken.has(lower(candidate)); n++) candidate = `${dir}/${name} ${n}.md`
    taken.add(lower(candidate))
    return candidate
  }
  const placeInFolder = (title: string): string => {
    const segments = title.split('/').map(safeNoteName)
    const name = segments.pop() as string
    return claim([folder, ...segments].join('/'), name)
  }

  const drafts: NoteDraft[] = []
  const byName = new Map<string, NoteDraft>()
  const nameIt = (name: string, draft: NoteDraft, strong: boolean): void => {
    const key = lower(name.trim())
    if (!key) return
    if (strong || !byName.has(key)) byName.set(key, draft)
  }

  // Journals first, so a page that shares a journal's title is the one a link
  // means only when Logseq would also have read it that way (a page wins).
  const outsideTaken = new Set<string>()
  const pageFiles = [...graph.pages]
  for (const file of graph.journals) {
    const date = logseqJournalDate(file.rel, config)
    const page = parseLogseqPage(file.text)
    if (!date) {
      // Not a date Logseq would read: it is a page that sits in journals/.
      pageFiles.push(file)
      continue
    }
    const title = formatLogseqDate(date, config.journalTitleFormat)
    let path = options.journalPath?.(date) ?? null
    if (path && (outsideTaken.has(lower(path)) || taken.has(lower(path)))) path = null
    const outside = path !== null
    if (path) outsideTaken.add(lower(path))
    else path = claim(`${folder}/${LOGSEQ_JOURNALS_DIR}`, safeNoteName(date))
    taken.add(lower(path))
    const draft: NoteDraft = {
      note: { path, source: file.rel, kind: 'journal', title, body: '', outside, date },
      page,
      sourceDir: dirName(file.rel),
      properties: page.properties
    }
    drafts.push(draft)
    nameIt(title, draft, false)
    nameIt(date, draft, false)
    stats.journals += 1
    if (outside) stats.journalsInDailyNotes += 1
  }

  for (const file of pageFiles) {
    const page = parseLogseqPage(file.text)
    const titleProp = page.properties.find((prop) => prop.key === 'title')?.value
    const title = (titleProp?.trim() || logseqTitleFromFileName(stem(file.rel), config.fileNameFormat)).trim()
    const draft: NoteDraft = {
      note: { path: placeInFolder(title), source: file.rel, kind: 'page', title, body: '', outside: false },
      page,
      sourceDir: dirName(file.rel),
      properties: page.properties
    }
    drafts.push(draft)
    nameIt(title, draft, true)
    stats.pages += 1
  }
  // Aliases after every title, so an alias never takes a page's own name.
  for (const draft of drafts) {
    for (const prop of draft.properties) {
      if (prop.key === 'alias') for (const alias of splitList(prop.value)) nameIt(alias, draft, false)
    }
  }

  for (const file of graph.orgFiles) {
    const head = /^#\+title:[ \t]*(.+)$/im.exec(file.text)?.[1]?.trim()
    const title = head || logseqTitleFromFileName(stem(file.rel), config.fileNameFormat)
    const draft: NoteDraft = {
      note: { path: placeInFolder(title), source: file.rel, kind: 'org', title, body: '', outside: false },
      page: null,
      sourceDir: dirName(file.rel),
      properties: []
    }
    drafts.push(draft)
    nameIt(title, draft, false)
    stats.orgPages += 1
  }

  const assets: LogseqPlannedAsset[] = graph.assets.map((source) => ({ source, path: `${folder}/${source}` }))
  const assetByKey = new Map(assets.map((asset) => [lower(asset.source), asset]))
  stats.assets = assets.length
  for (const asset of assets) {
    if (/^whiteboards\//i.test(asset.source)) {
      stats.verbatim.whiteboard.count += 1
      stats.verbatim.whiteboard.paths.push(asset.path)
    }
  }

  // A note's name finds it in ZenNotes only when no other note has that name.
  const nameCounts = new Map<string, number>()
  for (const path of [...options.existingNotes, ...drafts.map((d) => d.note.path)]) {
    const key = lower(stripMd(baseName(path)))
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1)
  }
  const target = (note: LogseqPlannedNote): string => {
    const name = stripMd(baseName(note.path))
    return nameCounts.get(lower(name)) === 1 ? name : stripMd(note.path)
  }

  // Blocks that something refers to, and where each one lives.
  const referenced = new Set<string>()
  for (const file of [...graph.pages, ...graph.journals]) {
    for (const match of file.text.matchAll(BLOCK_REF_RE)) referenced.add(lower(match[1]))
  }
  const blocks = new Map<string, BlockTarget>()
  const indexBlocks = (draft: NoteDraft, list: LogseqBlock[]): void => {
    for (const block of list) {
      const id = block.properties.find((prop) => prop.key === 'id')?.value
      if (id && referenced.has(lower(id)) && !blocks.has(lower(id))) blocks.set(lower(id), { draft, block })
      indexBlocks(draft, block.children)
    }
  }
  for (const draft of drafts) if (draft.page) indexBlocks(draft, draft.page.blocks)

  const countVerbatim = (kind: LogseqVerbatimKind, path: string): void => {
    const entry = stats.verbatim[kind]
    entry.count += 1
    if (!entry.paths.includes(path)) entry.paths.push(path)
  }

  // --- One note at a time -------------------------------------------------

  const convertNote = (draft: NoteDraft): string => {
    const { note } = draft
    const noteDir = dirName(note.path)

    const pageLink = (written: string, label?: string): string => {
      const found = byName.get(lower(written.trim()))
      if (!found) {
        // A Logseq drawing is linked like a page.
        const asset = assetByKey.get(lower(written.trim()))
        if (asset) return `![[${asset.path}]]`
        return label ? `[[${written}|${label}]]` : `[[${written}]]`
      }
      const to = target(found.note)
      const shown = (label ?? written).replace(/[[\]|]/g, '')
      if (lower(to) === lower(shown)) return `[[${label ? to : written}]]`
      return `[[${to}|${shown}]]`
    }

    const embedPage = (written: string): string => {
      const found = byName.get(lower(written.trim()))
      return found ? `![[${target(found.note)}]]` : `![[${written}]]`
    }

    const blockLink = (id: string, label?: string): string | null => {
      const hit = blocks.get(lower(id))
      if (!hit) return null
      const shown = (label ?? plainText(hit.block.lines[0] ?? '')).replace(/[[\]|]/g, '') || 'block'
      return `[[${target(hit.draft.note)}^${lower(id)}|${shown}]]`
    }

    const assetHref = (raw: string): string | null => {
      const bare = raw.replace(/^<|>$/g, '')
      if (HAS_SCHEME.test(bare) || bare.startsWith('#')) return null
      const decoded = decodePercent(bare.split('#')[0].split('?')[0])
      const candidates = [normalizeRelative(draft.sourceDir, decoded), decoded.replace(/^\.?\/+/, '')]
      for (const candidate of candidates) {
        if (!candidate) continue
        const asset = assetByKey.get(lower(candidate))
        if (asset) return destination(relativePath(noteDir, asset.path))
      }
      return null
    }

    /** One line outside any fence, with code spans left alone. */
    const convertLine = (line: string): string => {
      return splitCode(line)
        .map((part) => {
          if (part.code) return part.text
          const kept: string[] = []
          const keep = (text: string): string => {
            kept.push(text)
            return `\u0000${kept.length - 1}\u0000`
          }
          let text = part.text.replace(MACRO_RE, (whole, inner: string) => {
            const { name, arg } = macroParts(inner)
            if (name === 'embed') {
              const ref = new RegExp(`^\\(\\((${UUID})\\)\\)$`).exec(arg)
              if (ref) {
                const link = blockLink(ref[1])
                if (link) {
                  stats.embeds += 1
                  stats.blockRefs += 1
                  return keep(`!${link.replace(/\|[^\]]*\]\]$/, ']]')}`)
                }
                stats.missingBlockRefs += 1
                return keep(whole)
              }
              const pageRef = /^\[\[([^\]]+)\]\]$/.exec(arg)
              if (pageRef) {
                stats.embeds += 1
                return keep(embedPage(pageRef[1]))
              }
            }
            if ((VIDEO_MACROS.has(name) || LINK_MACROS.has(name)) && /^https?:\/\//i.test(arg)) {
              return keep(`[${arg}](${arg})`)
            }
            countVerbatim(name === 'query' ? 'query' : 'macro', note.path)
            return keep(codeSpan(whole))
          })
          text = text.replace(LINK_TO_BLOCK_RE, (whole, label: string, id: string) => {
            const link = blockLink(id, label)
            if (link) {
              stats.blockRefs += 1
              return keep(link)
            }
            stats.missingBlockRefs += 1
            return keep(whole)
          })
          text = text.replace(LINK_TO_PAGE_RE, (_whole, label: string, name: string) => keep(pageLink(name, label)))
          text = text.replace(BLOCK_REF_RE, (whole, id: string) => {
            const link = blockLink(id)
            if (link) {
              stats.blockRefs += 1
              return keep(link)
            }
            stats.missingBlockRefs += 1
            return keep(whole)
          })
          text = text.replace(TAG_PAGE_RE, (_whole, name: string) => keep(`#${logseqTag(name)}`))
          text = text.replace(PAGE_REF_RE, (_whole, name: string) => keep(pageLink(name)))
          text = text.replace(MD_LINK_RE, (whole, bang: string, label: string, href: string, title: string, attrs?: string) => {
            const moved = assetHref(href)
            let alt = label
            if (bang && attrs) {
              const width = /:width\s+(\d+)/.exec(attrs)?.[1]
              const height = /:height\s+(\d+)/.exec(attrs)?.[1]
              if (width) alt = `${label}|${width}${height ? `x${height}` : ''}`
            }
            if (!moved && !attrs) return keep(whole)
            return keep(`${bang}[${alt}](${moved ?? href}${title})`)
          })
          text = text.replace(HIGHLIGHT_RE, '==$1==')
          // eslint-disable-next-line no-control-regex
          return text.replace(/\u0000(\d+)\u0000/g, (_m, index: string) => kept[Number(index)])
        })
        .join('')
    }

    /** A whole block line that is one macro becomes a block of its own. */
    const blockMacro = (line: string): string[] | null => {
      const match = /^\{\{([^{}]*)\}\}$/.exec(line.trim())
      if (!match) return null
      const { name, arg } = macroParts(match[1])
      if (VIDEO_MACROS.has(name) && /^https?:\/\//i.test(arg)) return ['```embed', arg, '```']
      if (name === 'embed') return null
      if (VIDEO_MACROS.has(name) || LINK_MACROS.has(name)) return null
      countVerbatim(name === 'query' ? 'query' : 'macro', note.path)
      const fence = fenceFor([line])
      return [`${fence}logseq`, line.trim(), fence]
    }

    /** A block's own lines, converted, without its bullet or its children. */
    const blockLines = (block: LogseqBlock): string[] => {
      const out: string[] = []
      let fence: string | null = null
      let org: { kind: string; arg: string; lines: string[] } | null = null
      for (const [index, line] of block.lines.entries()) {
        if (block.propertyLines.has(index)) {
          const prop = PROPERTY_RE.exec(line)
          if (prop && isSystemBlockProperty(prop[1].toLowerCase())) continue
          out.push(convertLine(line))
          continue
        }
        if (org) {
          if (new RegExp(`^\\s*#\\+END_${org.kind}\\s*$`, 'i').test(line)) {
            out.push(...orgBlock(org.kind, org.arg, org.lines))
            org = null
          } else {
            org.lines.push(line)
          }
          continue
        }
        if (fence) {
          out.push(line)
          if (line.trim().startsWith(fence) && !line.trim().slice(fence.length).trim()) fence = null
          continue
        }
        const opens = /^\s*(`{3,}|~{3,})/.exec(line)
        if (opens) {
          fence = opens[1]
          out.push(line)
          continue
        }
        const begin = /^\s*#\+BEGIN_([A-Z_]+)(?:\s+(.*))?$/i.exec(line)
        if (begin) {
          org = { kind: begin[1].toUpperCase(), arg: (begin[2] ?? '').trim(), lines: [] }
          continue
        }
        const macro = block.marker ? null : blockMacro(line)
        if (macro) {
          out.push(...macro)
          continue
        }
        out.push(convertLine(line))
      }
      if (org) {
        // Never closed: what Logseq would show is the text as written.
        out.push(`#+BEGIN_${org.kind}${org.arg ? ` ${org.arg}` : ''}`, ...org.lines.map(convertLine))
      }
      while (out.length > 1 && !out[out.length - 1].trim()) out.pop()
      return out
    }

    const orgBlock = (kind: string, arg: string, lines: string[]): string[] => {
      const callouts: Record<string, string> = {
        NOTE: 'note',
        TIP: 'tip',
        IMPORTANT: 'important',
        WARNING: 'warning',
        CAUTION: 'caution',
        PINNED: 'note'
      }
      if (kind === 'QUOTE') return lines.map((line) => (line.trim() ? `> ${convertLine(line)}` : '>'))
      if (callouts[kind]) {
        return [`> [!${callouts[kind]}]`, ...lines.map((line) => (line.trim() ? `> ${convertLine(line)}` : '>'))]
      }
      if (kind === 'SRC' || kind === 'EXAMPLE') {
        const fence = fenceFor(lines)
        return [`${fence}${kind === 'SRC' ? arg.split(/\s+/)[0] ?? '' : ''}`, ...lines, fence]
      }
      countVerbatim(kind === 'QUERY' ? 'query' : 'org-block', note.path)
      const original = [`#+BEGIN_${kind}${arg ? ` ${arg}` : ''}`, ...lines, `#+END_${kind}`]
      const fence = fenceFor(original)
      return [`${fence}logseq`, ...original, fence]
    }

    const CHECKBOX: Record<string, string> = {
      TODO: ' ',
      LATER: ' ',
      WAIT: ' ',
      WAITING: ' ',
      NOW: '/',
      DOING: '/',
      'IN-PROGRESS': '/',
      STARTED: '/',
      DONE: 'x',
      CANCELED: '-',
      CANCELLED: '-'
    }
    const PRIORITY: Record<string, string> = { A: '!high', B: '!med', C: '!low' }

    const repeatToken = (repeat: string | undefined): string | null => {
      const match = /^(\.\+|\+\+|\+)(\d+)([dwmy])$/.exec(repeat ?? '')
      if (!match) return null
      return `@repeat:${match[1] === '.+' ? 'after-' : ''}${match[2]}${match[3]}`
    }

    /** The block's first line with its task state and dates, and the anchor
     *  that block references point at. */
    const headLine = (block: LogseqBlock, first: string): string => {
      const tokens: string[] = []
      if (block.marker) {
        if (block.priority && PRIORITY[block.priority]) tokens.push(PRIORITY[block.priority])
        if (block.marker === 'WAIT' || block.marker === 'WAITING') tokens.push('@waiting')
        const due = block.deadline ?? block.scheduled
        if (due) tokens.push(`due:${due.date}`)
        if (block.deadline && block.scheduled && block.scheduled.date !== block.deadline.date) {
          tokens.push(`@scheduled:${block.scheduled.date}`)
        }
        const repeat = repeatToken(due?.repeat)
        if (repeat && block.marker !== 'DONE' && block.marker !== 'CANCELED' && block.marker !== 'CANCELLED') {
          tokens.push(repeat)
        }
      } else if (block.priority) {
        tokens.push(`[#${block.priority}]`)
      }
      const id = block.properties.find((prop) => prop.key === 'id')?.value
      const anchored = !!id && blocks.get(lower(id))?.block === block
      if (anchored) tokens.push(`^${lower(id as string)}`)
      if (tokens.length === 0) return first
      return first.trim() ? `${first.replace(/[ \t]+$/, '')} ${tokens.join(' ')}` : tokens.join(' ')
    }

    /** A block's dates when it is not a task: kept as text, since nothing else holds them. */
    const dateLines = (block: LogseqBlock): string[] => {
      if (block.marker) return []
      const out: string[] = []
      if (block.scheduled) out.push(`Scheduled: ${block.scheduled.date}${block.scheduled.repeat ? ` ${block.scheduled.repeat}` : ''}`)
      if (block.deadline) out.push(`Deadline: ${block.deadline.date}${block.deadline.repeat ? ` ${block.deadline.repeat}` : ''}`)
      return out
    }

    const isEmpty = (block: LogseqBlock): boolean =>
      !block.marker &&
      block.children.length === 0 &&
      block.lines.every((line, index) => !line.trim() || block.propertyLines.has(index)) &&
      !block.scheduled &&
      !block.deadline

    const headingLevel = (block: LogseqBlock): number => {
      if (block.marker) return 0
      const hashes = /^(#{1,6})\s/.exec(block.lines[0] ?? '')
      if (hashes) return hashes[1].length
      const prop = block.properties.find((p) => p.key === 'heading')?.value
      if (!prop) return 0
      const level = Number(prop)
      if (Number.isInteger(level) && level >= 1 && level <= 6) return level
      return prop === 'true' ? 2 : 0
    }

    const ordered = (block: LogseqBlock): boolean =>
      block.properties.some((prop) => prop.key === 'logseq.order-list-type' && prop.value === 'number')

    const renderList = (list: LogseqBlock[], indent: string): string[] => {
      const out: string[] = []
      let number = 0
      for (const block of list) {
        if (isEmpty(block)) continue
        stats.logbooks += block.logbooks
        number = ordered(block) ? number + 1 : 0
        const bullet = number > 0 ? `${number}.` : '-'
        const box = block.marker ? `[${CHECKBOX[block.marker] ?? ' '}] ` : ''
        const lines = [...blockLines(block), ...dateLines(block)]
        const level = headingLevel(block)
        let first = lines[0] ?? ''
        if (level > 0 && !/^#{1,6}\s/.test(first)) first = `${'#'.repeat(level)} ${first}`
        const opensFence = /^\s*(`{3,}|~{3,})/.test(first)
        const head = opensFence ? first : headLine(block, first)
        const childIndent = indent + ' '.repeat(bullet.length + 1)
        out.push(`${indent}${bullet}${head || box ? ' ' : ''}${box}${head}`.replace(/[ \t]+$/, ''))
        for (const line of lines.slice(1)) out.push(line.trim() ? `${childIndent}${line}` : '')
        if (opensFence) {
          const anchor = headLine(block, '')
          if (anchor) out.push(`${childIndent}${anchor}`)
        }
        out.push(...renderList(block.children, childIndent))
      }
      return out
    }

    type Chunk = { list: boolean; lines: string[] }
    const renderTop = (list: LogseqBlock[]): Chunk[] => {
      const chunks: Chunk[] = []
      // Neighbouring list blocks render as one list, so numbering runs on.
      let run: LogseqBlock[] = []
      const flush = (): void => {
        if (run.length > 0) chunks.push({ list: true, lines: renderList(run, '') })
        run = []
      }
      for (const block of list) {
        if (isEmpty(block)) continue
        const level = headingLevel(block)
        const prose = !options.bullets && !block.marker && !ordered(block)
        if (!prose || (level === 0 && block.children.length > 0)) {
          run.push(block)
          continue
        }
        flush()
        if (level > 0) {
          stats.logbooks += block.logbooks
          const lines = [...blockLines(block), ...dateLines(block)]
          const first = /^#{1,6}\s/.test(lines[0] ?? '') ? lines[0] : `${'#'.repeat(level)} ${lines[0] ?? ''}`
          chunks.push({ list: false, lines: [headLine(block, first)] })
          if (lines.length > 1) chunks.push({ list: false, lines: lines.slice(1) })
          chunks.push(...renderTop(block.children))
          continue
        }
        stats.logbooks += block.logbooks
        const lines = [...blockLines(block), ...dateLines(block)]
        if (/^\s*(`{3,}|~{3,})/.test(lines[0] ?? '')) {
          const anchor = headLine(block, '')
          chunks.push({ list: false, lines: anchor ? [...lines, anchor] : lines })
        } else {
          chunks.push({ list: false, lines: [headLine(block, lines[0] ?? ''), ...lines.slice(1)] })
        }
      }
      flush()
      return chunks
    }

    const page = draft.page as LogseqPage
    const chunks: Chunk[] = []
    if (page.preamble.length > 0) chunks.push({ list: false, lines: page.preamble.map(convertLine) })
    chunks.push(...renderTop(page.blocks))
    let body = ''
    for (const [index, chunk] of chunks.entries()) {
      if (index > 0) body += chunks[index - 1].list && chunk.list ? '\n' : '\n\n'
      body += chunk.lines.join('\n')
    }
    return body
  }

  const frontmatter = (draft: NoteDraft, body: string): string => {
    const lines: string[] = []
    const seen = new Set<string>()
    const sanitized = draft.note.kind === 'page' && stripMd(baseName(draft.note.path)) !== baseName(draft.note.title)
    for (const prop of draft.properties) {
      if (DROPPED_PAGE_PROPERTIES.has(prop.key)) continue
      const key = frontmatterKey(prop.key)
      if (seen.has(key)) continue
      seen.add(key)
      if (prop.key === 'tags' || prop.key === 'alias') {
        const values = splitList(prop.value).map((value) => (prop.key === 'tags' ? logseqTag(value) : value))
        if (values.length > 0) lines.push(`${key}: [${values.map(yamlValue).join(', ')}]`)
        continue
      }
      lines.push(`${key}: ${yamlValue(prop.value)}`)
    }
    // A title the file name could not hold is kept where it can be read.
    if (sanitized && !seen.has('title')) lines.unshift(`title: ${yamlValue(draft.note.title)}`)
    if (options.includeTasks === false && /^[ \t>]*(?:[-*+]|\d+[.)])[ \t]+\[[ xX/-]\]/m.test(body)) {
      lines.push('tasks: false')
    }
    if (lines.length === 0) return body.startsWith('---') ? `\n${body}` : body
    return `---\n${lines.join('\n')}\n---\n\n${body}`
  }

  for (const draft of drafts) {
    if (draft.note.kind === 'org') {
      const source = graph.orgFiles.find((file) => file.rel === draft.note.source)?.text ?? ''
      const lines = source.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n')
      const fence = fenceFor(lines)
      draft.note.body = [
        '> [!note] Kept as Org mode',
        "> Logseq wrote this page in Org mode, which ZenNotes doesn't read, so it is here as it was.",
        '',
        `${fence}org`,
        ...lines,
        fence,
        ''
      ].join('\n')
      countVerbatim('org-page', draft.note.path)
      continue
    }
    const body = convertNote(draft)
    draft.note.body = `${frontmatter(draft, body).replace(/\s+$/, '')}\n`
  }

  const notes = drafts.map((draft) => draft.note)
  const reportPath = `${folder}/${LOGSEQ_REPORT_NAME}`
  return {
    notes,
    assets,
    stats,
    report: { path: reportPath, body: buildReport(notes, stats, options, folder, target) }
  }
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`

function buildReport(
  notes: LogseqPlannedNote[],
  stats: LogseqImportStats,
  options: LogseqImportOptions,
  folder: string,
  target: (note: LogseqPlannedNote) => string
): string {
  const byPath = new Map(notes.map((note) => [note.path, note]))
  const linkTo = (path: string): string => {
    const note = byPath.get(path)
    return note ? `[[${target(note)}|${note.title.replace(/[[\]|]/g, '')}]]` : path
  }
  const list = (paths: string[], max = 20): string[] => {
    const shown = paths.slice(0, max).map((path) => `  - ${linkTo(path)}`)
    if (paths.length > max) shown.push(`  - and ${plural(paths.length - max, 'more', 'more')}`)
    return shown
  }

  const lines: string[] = [`Imported from Logseq${options.today ? ` on ${options.today}` : ''}.`, '']
  const pages = stats.pages + stats.orgPages
  lines.push(
    `- ${plural(pages, 'page')}${stats.orgPages > 0 ? `, ${stats.orgPages.toLocaleString('en-US')} of them in Org mode and kept as written` : ''}`
  )
  if (stats.journals > 0) {
    const here = stats.journals - stats.journalsInDailyNotes
    const where =
      stats.journalsInDailyNotes === stats.journals
        ? stats.journals === 1
          ? ', now a daily note'
          : ', now daily notes'
        : stats.journalsInDailyNotes > 0
          ? `, ${stats.journalsInDailyNotes.toLocaleString('en-US')} of them now daily notes and ${here.toLocaleString('en-US')} in ${folder}/${LOGSEQ_JOURNALS_DIR}`
          : ` in ${folder}/${LOGSEQ_JOURNALS_DIR}`
    lines.push(`- ${plural(stats.journals, 'journal')}${where}`)
  }
  if (stats.assets > 0) lines.push(`- ${plural(stats.assets, 'file')}, in the same folders as in the graph (assets, draws, whiteboards)`)
  if (stats.blockRefs > 0) lines.push(`- ${plural(stats.blockRefs, 'block reference')}, now links to the block`)
  if (stats.embeds > 0) lines.push(`- ${plural(stats.embeds, 'embed')}`)
  lines.push('', 'The graph itself was not changed.', '')

  const verbatim: Array<[string, { count: number; paths: string[] }, boolean]> = [
    [plural(stats.verbatim.query.count, 'query', 'queries'), stats.verbatim.query, true],
    [plural(stats.verbatim.macro.count, 'macro'), stats.verbatim.macro, true],
    [plural(stats.verbatim['org-block'].count, 'Org block'), stats.verbatim['org-block'], true],
    [plural(stats.verbatim['org-page'].count, 'Org mode page'), stats.verbatim['org-page'], true],
    [plural(stats.verbatim.whiteboard.count, 'whiteboard'), stats.verbatim.whiteboard, false]
  ]
  if (verbatim.some(([, entry]) => entry.count > 0)) {
    lines.push(
      '## Kept as written',
      '',
      "ZenNotes has nothing these turn into, so each stays exactly as Logseq wrote it, in a code block. Whiteboards came over as files ZenNotes doesn't open.",
      ''
    )
    for (const [label, entry, notesList] of verbatim) {
      if (entry.count === 0) continue
      lines.push(`- ${label}`)
      lines.push(...(notesList ? list(entry.paths) : entry.paths.slice(0, 20).map((path) => `  - ${path}`)))
    }
    lines.push('')
  }

  const taken = options.takenJournalDates ?? []
  if (taken.length > 0) {
    lines.push(
      '## Journals kept here',
      '',
      `These days already had a daily note, so their journal is in ${folder}/${LOGSEQ_JOURNALS_DIR} instead. Nothing was written over.`,
      ''
    )
    const journals = notes.filter((note) => note.kind === 'journal' && note.date && taken.includes(note.date))
    lines.push(...list(journals.map((note) => note.path), 40).map((line) => line.replace(/^ {2}/, '')))
    lines.push('')
  }

  if (stats.missingBlockRefs > 0) {
    lines.push(
      '## Block references to nothing',
      '',
      `${plural(stats.missingBlockRefs, 'block reference')} ${stats.missingBlockRefs === 1 ? 'points' : 'point'} at a block that isn't in the graph, so ${stats.missingBlockRefs === 1 ? 'it stays' : 'they stay'} as written.`,
      ''
    )
  }

  lines.push('## Left out', '')
  if (stats.logbooks > 0) lines.push(`- ${plural(stats.logbooks, 'time log')} (\`:LOGBOOK:\` entries)`)
  lines.push("- Logseq's own settings in logseq/, such as config.edn and custom.css")
  lines.push("- Block properties Logseq keeps for itself, such as `id::` and `collapsed::`")
  lines.push('')
  return lines.join('\n')
}
