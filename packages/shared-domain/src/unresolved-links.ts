/**
 * Unresolved wikilinks: `[[targets]]` no note in the vault answers, the notes
 * someone meant to write later. The Unresolved Links view lists them
 * vault-wide with the lines that mention them.
 *
 * What counts as "resolved" is the editor's decision, not this module's: the
 * renderer resolves titles, paths, headings, assets and databases with rules
 * that live in app-core, so `collectUnresolvedLinks` takes that answer as a
 * callback and owns only the grouping. The line scan masks code the way the
 * vault index does (a `[[link]]` inside a fence or an inline code span is
 * text, not a link) through `scanMarkdownLines`, the shared fence walker,
 * instead of another copy of `stripCodeContent`.
 */
import { scanMarkdownLines } from './markdown-lines'

/** Virtual tab path of the Unresolved Links view. */
export const UNRESOLVED_LINKS_TAB_PATH = 'zen://unresolved-links'

/** True when `path` is the Unresolved Links view tab. */
export function isUnresolvedLinksTabPath(path: string | null | undefined): boolean {
  return path === UNRESOLVED_LINKS_TAB_PATH
}

/** One `[[wikilink]]` as it sits in a note body. */
export interface WikilinkOccurrence {
  /** The target as written, before any `|alias`, trimmed. */
  target: string
  /** 1-based line number. */
  line: number
  /** Offset of the link within its line. */
  column: number
  /** Body offset of the opening `[[` (or the `!` of an embed). */
  from: number
  /** Body offset just past the closing `]]`. */
  to: number
  /** The line the link sits on, as written. */
  text: string
}

// Same shape as the vault index's scanner (`extractWikilinks` in the desktop
// main process): an optional embed bang, the target up to `|` or `]`, and an
// optional alias.
const WIKILINK_RE = /(!?)\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/g

// Inline code spans as the vault index masks them (`[^`\n]*` between single
// backticks), blanked to spaces of the same length so the columns of every
// link after the span stay where the editor has them.
const INLINE_CODE_RE = /`[^`\n]*`/g

function maskInlineCode(line: string): string {
  if (!line.includes('`')) return line
  return line.replace(INLINE_CODE_RE, (span) => ' '.repeat(span.length))
}

/**
 * Every wikilink in a note body, in reading order, with its line and offsets.
 * Links inside fenced code blocks and inline code spans are skipped. Lines of
 * a leading frontmatter block are scanned, as the vault index scans them.
 *
 * Offsets count a CRLF line break as one character, the way CodeMirror counts
 * them, so `from` places the editor cursor on the link in either encoding.
 */
export function findWikilinkOccurrences(body: string): WikilinkOccurrence[] {
  if (!body.includes('[[')) return []
  const normalized = body.includes('\r') ? body.replace(/\r\n?/g, '\n') : body
  const found: WikilinkOccurrence[] = []
  for (const line of scanMarkdownLines(normalized, { includeFrontmatter: true })) {
    if (!line.text.includes('[[')) continue
    const masked = maskInlineCode(line.text)
    for (const m of masked.matchAll(WIKILINK_RE)) {
      const target = (m[2] ?? '').trim()
      if (!target) continue
      const start = m.index ?? 0
      found.push({
        target,
        line: line.line,
        column: start,
        from: line.from + start,
        to: line.from + start + m[0].length,
        text: line.text
      })
    }
  }
  return found
}

/**
 * The part of a wikilink target that names a note: `Doc#Heading` and
 * `Doc^block` both point into `Doc`. Note names cannot contain `#` or `^`,
 * so the first one always starts the anchor.
 */
export function wikilinkNoteName(target: string): string {
  const anchor = target.search(/[#^]/)
  return (anchor === -1 ? target : target.slice(0, anchor)).trim()
}

/**
 * Identity of a missing note across its spellings. `[[Doc]]`, `[[doc]]`,
 * `[[Doc#Intro]]` and `[[Doc.md]]` all name one note that does not exist, so
 * the view lists it once. A path spelling keeps its folders: `[[ideas/Doc]]`
 * names a different file than `[[Doc]]`.
 */
export function unresolvedLinkKey(target: string): string {
  return wikilinkNoteName(target)
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.md$/i, '')
    .trim()
    .toLowerCase()
}

/** The note fields the scan reads: the vault index's per-note link list. */
export interface UnresolvedLinkSource {
  path: string
  folder: string
  wikilinks?: readonly string[]
}

export interface UnresolvedLinkGroup<N extends UnresolvedLinkSource = UnresolvedLinkSource> {
  /** See {@link unresolvedLinkKey}. */
  key: string
  /** The note name as first written, anchor dropped: what creating it names the file. */
  target: string
  /** The notes that link to it, in vault order, each once. */
  sources: N[]
}

/**
 * Group every unresolved wikilink in the vault by the note it names, from the
 * index's per-note link lists (no file reads). `isResolved(target, note)`
 * answers for one target as written in `note`, so relative paths and
 * same-note `[[#heading]]` links resolve against the right note.
 *
 * Trashed notes are not sources: their links are not part of the vault. Most
 * linked first, then by name, so the note the vault asks for most is on top.
 */
export function collectUnresolvedLinks<N extends UnresolvedLinkSource>(
  notes: readonly N[],
  isResolved: (target: string, note: N) => boolean
): UnresolvedLinkGroup<N>[] {
  const groups = new Map<string, UnresolvedLinkGroup<N>>()
  for (const note of notes) {
    if (note.folder === 'trash' || !note.wikilinks?.length) continue
    for (const raw of note.wikilinks) {
      const target = raw.trim()
      if (!target) continue
      const key = unresolvedLinkKey(target)
      if (!key) continue
      if (isResolved(target, note)) continue
      const group = groups.get(key)
      if (!group) {
        groups.set(key, { key, target: wikilinkNoteName(target), sources: [note] })
      } else if (group.sources[group.sources.length - 1] !== note) {
        group.sources.push(note)
      }
    }
  }
  return [...groups.values()].sort(
    (a, b) =>
      b.sources.length - a.sources.length ||
      a.target.localeCompare(b.target, undefined, { sensitivity: 'base', numeric: true })
  )
}

/**
 * The lines of `body` that link to any of the missing notes in `keys`, in
 * reading order. Used to show where each source note mentions a missing
 * target once its body has been read.
 */
export function unresolvedOccurrencesIn(
  body: string,
  keys: ReadonlySet<string>
): Array<WikilinkOccurrence & { key: string }> {
  const out: Array<WikilinkOccurrence & { key: string }> = []
  for (const occurrence of findWikilinkOccurrences(body)) {
    const key = unresolvedLinkKey(occurrence.target)
    if (keys.has(key)) out.push({ ...occurrence, key })
  }
  return out
}
