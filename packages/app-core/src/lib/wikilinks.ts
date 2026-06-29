import type { NoteFolder, NoteMeta } from '@shared/ipc'

type NoteRef = Pick<NoteMeta, 'path' | 'title' | 'folder'>

const TOP_FOLDERS: NoteFolder[] = ['inbox', 'quick', 'archive', 'trash']
const INVALID_NOTE_PATH_CHARS = /[\\:*?"<>|#^\[\]]/
const FENCED_CODE_BLOCK_RE = /(^|\n)```[^\n]*\n[\s\S]*?\n```[ \t]*(?=\n|$)/g

function stripCodeContent(body: string): string {
  return body
    // Only treat line-start triple backticks as real fenced code blocks.
    .replace(FENCED_CODE_BLOCK_RE, '$1 ')
    .replace(/`[^`\n]*`/g, ' ')
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+/g, '/')
}

function stripMdExtension(value: string): string {
  return value.replace(/\.md$/i, '')
}

function normalizeForCompare(value: string): string {
  return value.trim().toLowerCase()
}

export function isPathLikeWikilinkTarget(target: string): boolean {
  const trimmed = target.trim()
  return trimmed.startsWith('/') || trimmed.includes('/') || /\.md$/i.test(trimmed)
}

/**
 * Strip a `#heading` / `^block` anchor off a wikilink target — it points within
 * the note, not at the note name. `[[Doc#Heading]]` resolves to `Doc`. Note
 * names can't contain `#` or `^` (see INVALID_NOTE_PATH_CHARS), so the first one
 * always starts the anchor. (#196)
 */
export function stripWikilinkAnchor(target: string): string {
  const anchor = target.search(/[#^]/)
  return anchor === -1 ? target : target.slice(0, anchor)
}

/**
 * The `#heading` text from a wikilink target, or null when there's no heading
 * anchor. `[[Doc#My Heading]]` → `My Heading`; `[[Doc^block]]` / `[[Doc]]` →
 * null (block refs aren't headings). Used to scroll to the heading on click. (#196)
 */
export function wikilinkHeadingAnchor(target: string): string | null {
  const hash = target.indexOf('#')
  if (hash < 0) return null
  const caret = target.indexOf('^')
  if (caret >= 0 && caret < hash) return null // a ^block anchor comes first
  return target.slice(hash + 1).trim() || null
}

function resolveExplicitPath(notes: NoteRef[], target: string): NoteRef | null {
  const normalized = normalizeSlashes(target.trim())
  if (!normalized) return null

  const trimmed = stripMdExtension(normalized).replace(/^\/+/, '').replace(/\/+$/, '')
  if (!trimmed) return null

  let relPath: string | null = null
  if (normalized.startsWith('/')) {
    relPath = `inbox/${trimmed}.md`
  } else if (TOP_FOLDERS.some((folder) => trimmed.toLowerCase().startsWith(`${folder}/`))) {
    relPath = `${trimmed}.md`
  }

  if (!relPath) return null
  const needle = normalizeForCompare(relPath)
  return notes.find((note) => normalizeForCompare(note.path) === needle) ?? null
}

function resolvePathSuffix(notes: NoteRef[], target: string): NoteRef | null {
  const trimmed = stripMdExtension(normalizeSlashes(target.trim()))
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
  if (!trimmed) return null

  const suffix = normalizeForCompare(`/${trimmed}.md`)
  const exact = normalizeForCompare(`${trimmed}.md`)
  const matches = notes.filter((note) => {
    const path = normalizeForCompare(note.path)
    return path === exact || path.endsWith(suffix)
  })
  return matches.length === 1 ? matches[0] : null
}

export function resolveWikilinkTarget<T extends NoteRef>(notes: T[], target: string): T | null {
  // `[[Doc#Heading]]` / `[[Doc^block]]` point at a spot inside Doc — resolve the
  // document, ignoring the anchor. (#196)
  const doc = stripWikilinkAnchor(target)
  const visible = notes.filter((note) => note.folder !== 'trash')
  if (isPathLikeWikilinkTarget(doc)) {
    return (resolveExplicitPath(visible, doc) ??
      resolvePathSuffix(visible, doc)) as T | null
  }

  const needle = normalizeForCompare(stripMdExtension(doc))
  if (!needle) return null
  return visible.find((note) => normalizeForCompare(note.title) === needle) ?? null
}

export function backlinksForNote<T extends NoteRef & Pick<NoteMeta, 'wikilinks'>>(
  notes: T[],
  current: Pick<NoteMeta, 'path'>
): T[] {
  const out: T[] = []
  for (const note of notes) {
    if (note.folder === 'trash' || note.path === current.path) continue
    if (!note.wikilinks?.length) continue
    if (note.wikilinks.some((target) => resolveWikilinkTarget(notes, target)?.path === current.path)) {
      out.push(note)
    }
  }
  return out
}

export function extractWikilinkTargets(body: string): string[] {
  const stripped = stripCodeContent(body)
  const re = /\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/g
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(stripped)) !== null) {
    seen.add(m[1].trim())
  }
  return [...seen]
}

export function suggestCreateNotePath(target: string): string {
  // Creating from `[[Doc#Heading]]` makes `Doc`, not the invalid `Doc#Heading`. (#196)
  const trimmed = normalizeSlashes(stripWikilinkAnchor(target).trim()).replace(/\/+$/, '')
  if (!trimmed) return '/Untitled.md'

  if (trimmed.startsWith('/')) {
    return /\.md$/i.test(trimmed) ? trimmed : `${stripMdExtension(trimmed)}.md`
  }
  if (TOP_FOLDERS.some((folder) => trimmed.toLowerCase().startsWith(`${folder}/`))) {
    return /\.md$/i.test(trimmed) ? trimmed : `${stripMdExtension(trimmed)}.md`
  }
  if (trimmed.includes('/')) {
    return `/${stripMdExtension(trimmed)}.md`
  }
  return `/${stripMdExtension(trimmed)}.md`
}

export function parseCreateNotePath(input: string): {
  folder: NoteFolder
  subpath: string
  title: string
  relPath: string
} {
  const normalized = normalizeSlashes(input.trim())
  if (!normalized) throw new Error('Enter a note path.')
  if (normalized === '/' || normalized === '.') throw new Error('Enter a note path.')

  let folder: NoteFolder = 'inbox'
  let rest = normalized

  if (rest.startsWith('/')) {
    rest = rest.replace(/^\/+/, '')
  } else {
    const top = rest.split('/')[0]?.toLowerCase()
    if (top && TOP_FOLDERS.includes(top as NoteFolder)) {
      folder = top as NoteFolder
      rest = rest.split('/').slice(1).join('/')
    }
  }

  rest = stripMdExtension(rest).replace(/\/+$/, '')
  const parts = rest.split('/').filter(Boolean)
  if (parts.length === 0) throw new Error('Enter a note path.')
  if (parts.some((part) => part === '.' || part === '..')) {
    throw new Error('Path cannot contain "." or "..".')
  }
  if (parts.some((part) => INVALID_NOTE_PATH_CHARS.test(part))) {
    throw new Error('File names cannot contain # ^ [ ] \\ : * ? " < > |')
  }

  const title = parts[parts.length - 1].trim()
  if (!title) throw new Error('Enter a note name.')
  const subpath = parts.slice(0, -1).join('/')
  const relPath = `${folder}/${subpath ? `${subpath}/` : ''}${title}.md`
  return { folder, subpath, title, relPath }
}

export function stripMarkdownForMentions(body: string): string {
  return body
    .replace(/^---\n[\s\S]*?\n---\n/, ' ')
    .replace(FENCED_CODE_BLOCK_RE, '$1 ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // Wikilinks are already actual links, so they should not count as
    // "unlinked mentions" even when their label matches the note title.
    .replace(/\[\[[^\]]+\]\]/g, ' ')
    .replace(/[#>*_~`-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function extractMentionSnippet(body: string, phrase: string): string | null {
  const text = stripMarkdownForMentions(body)
  if (!text) return null

  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(^|[^\\p{L}\\p{N}_])(${escaped})(?=$|[^\\p{L}\\p{N}_])`, 'iu').exec(text)
  if (!match || match.index == null) return null

  const start = Math.max(0, match.index - 78)
  const end = Math.min(text.length, match.index + match[0].length + 96)
  const snippet = text.slice(start, end).trim()
  return `${start > 0 ? '…' : ''}${snippet}${end < text.length ? '…' : ''}`
}
