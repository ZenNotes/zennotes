import type { NoteFolder, NoteMeta } from '@shared/ipc'

type NoteRef = Pick<NoteMeta, 'path' | 'title' | 'folder'>

const TOP_FOLDERS: NoteFolder[] = ['inbox', 'quick', 'archive', 'trash']
const INVALID_NOTE_PATH_CHARS = /[\\:*?"<>|#^\[\]]/
/**
 * Blank out fenced and inline code so [[wikilink]] / mention scanning never
 * reads code as a link. Line-based and indentation-tolerant: a fence nested
 * under a list item is still a code block (#293). Mirrors `stripCodeContent` in
 * tags.ts, apps/desktop/src/main/vault.ts, apps/desktop/src/mcp/vault-ops.ts,
 * and apps/server/internal/vault/parse.go — keep all five in sync.
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
  const anchor = target.slice(hash + 1).trim()
  // Obsidian writes block references as `Note#^id`: the hash is its anchor
  // separator and the caret makes it a block, never a heading named "^id".
  // Treating it as one sent every imported Obsidian block link to the top of
  // the note. (#601)
  if (anchor.startsWith('^')) return null
  return anchor || null
}

/**
 * The `^block` id from a wikilink target, or null when there's no block anchor.
 * `[[Doc^note-two]]` → `note-two`; `[[Doc#Heading]]` / `[[Doc]]` → null. The
 * mirror of {@link wikilinkHeadingAnchor}: whichever marker comes first owns
 * the anchor (`[[Doc#Heading^id]]` is a heading link), with one exception in
 * Obsidian's favor: `[[Doc#^id]]`, hash immediately followed by caret, is its
 * canonical block reference and parses as one. (#601)
 */
export function wikilinkBlockAnchor(target: string): string | null {
  const caret = target.indexOf('^')
  if (caret < 0) return null
  const hash = target.indexOf('#')
  if (hash >= 0 && hash < caret) {
    // `Note#Heading^tail` is a heading link, but Obsidian's canonical block
    // form `Note#^id` (nothing between the two markers) is a block link.
    if (target.slice(hash + 1, caret).trim() !== '') return null
  }
  return target.slice(caret + 1).trim() || null
}

/**
 * True for `[[^block]]`: a wikilink whose note part is empty, so it targets a
 * block *in the current note*, the block-level twin of
 * {@link isSameFileHeadingLink}. (#601)
 */
export function isSameFileBlockLink(target: string): boolean {
  return stripWikilinkAnchor(target).trim() === '' && wikilinkBlockAnchor(target) != null
}

/**
 * What an un-aliased `[[target]]` should read as. An anchored target is
 * addressing, so showing it raw puts `Daily Note^note-two` in the middle of a
 * sentence; separate the note from what it points at instead. A target with no
 * anchor is already its own label. (#601)
 */
export function wikilinkDisplayLabel(target: string): string {
  const anchor = wikilinkHeadingAnchor(target) ?? wikilinkBlockAnchor(target)
  if (!anchor) return target
  const note = stripWikilinkAnchor(target).trim()
  return note ? `${note} > ${anchor}` : anchor
}

/**
 * True for `[[#heading]]` (optionally `[[#heading|label]]`) — a wikilink whose
 * note part is empty, so it targets a heading *in the current note*. Callers
 * resolve it against the note being viewed/edited instead of searching for a
 * note by name (which would fail for an empty name). (#291)
 */
export function isSameFileHeadingLink(target: string): boolean {
  return stripWikilinkAnchor(target).trim() === '' && wikilinkHeadingAnchor(target) != null
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

/**
 * The note path a wikilink should open, including same-note `[[#heading]]` and
 * `[[^block]]` targets whose note part is intentionally empty. Keeping this
 * decision beside resolution prevents keyboard and raw-link entry points from
 * rejecting the target before anchor navigation gets a chance to dispatch it.
 */
export function resolveWikilinkPath<T extends NoteRef>(
  notes: T[],
  target: string,
  currentPath: string | null | undefined
): string | null {
  const resolved = resolveWikilinkTarget(notes, target)
  if (resolved) return resolved.path
  if (currentPath && (isSameFileHeadingLink(target) || isSameFileBlockLink(target))) {
    return currentPath
  }
  return null
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

/**
 * The `^block` ids among `targets` that point into the note at `currentPath`,
 * de-duplicated and in first-seen order.
 *
 * Backlinks are resolved with the anchor stripped, so a note that reached for
 * one specific block looks identical to one that linked at the whole page.
 * This recovers that detail for the Connections panel. (#601)
 */
export function blockAnchorsTargeting<T extends NoteRef>(
  notes: T[],
  targets: string[],
  currentPath: string
): string[] {
  const seen = new Set<string>()
  for (const target of targets) {
    const block = wikilinkBlockAnchor(target)
    if (!block) continue
    if (resolveWikilinkTarget(notes, target)?.path !== currentPath) continue
    seen.add(block)
  }
  return [...seen]
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

/**
 * Href targets of standard Markdown links `[text](href)` (and the angle-bracket
 * form `[text](<href>)`) in a note body, outside code. Deduped raw hrefs — resolve
 * each with `resolveInternalNoteHref` to a note. Powers markdown-link connections
 * in the sidebar for people who don't use wikilinks. (#70dark)
 */
export function extractMarkdownLinkHrefs(body: string): string[] {
  const stripped = stripCodeContent(body)
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  // Angle-bracket hrefs (may contain spaces): [x](<a b.md>)
  const angleRe = /\[[^\]]*\]\(<([^>]+)>\)/g
  while ((m = angleRe.exec(stripped)) !== null) {
    const href = m[1].trim()
    if (href) seen.add(href)
  }
  // Plain hrefs: [x](href) or [x](href "title")
  const re = /\[[^\]]*\]\(([^)]+)\)/g
  while ((m = re.exec(stripped)) !== null) {
    let href = m[1].trim()
    if (href.startsWith('<')) continue // angle form, already captured above
    const sp = href.search(/\s/)
    if (sp >= 0) href = href.slice(0, sp) // drop an optional "title"
    if (href) seen.add(href)
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
  return stripCodeContent(body.replace(/^---\n[\s\S]*?\n---\n/, ' '))
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
