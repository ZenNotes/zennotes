import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import type { EditorState, TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { useStore } from '../store'
import { resolveWikilinkTarget } from './wikilinks'
import { parseBlockAnchors } from './block-anchors'
import { parseOutline } from './outline'
import { linkCandidates, type LinkCandidate } from './link-candidates'

// Matching, scoring, and target derivation live in `link-candidates.ts` (pure,
// store-free) so non-CodeMirror surfaces rank identically; this file owns only
// the CompletionSource plumbing and the insert transactions.

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * The rest of the wikilink the caret sits in, when that link is already closed
 * on this line: the text between the caret and its `]]`. Null while the link is
 * still being typed (no `]]` ahead, or another `[[` opens before it), which is
 * the case the completion has to close itself.
 */
function closedLinkTail(state: EditorState, pos: number): string | null {
  const line = state.doc.lineAt(pos)
  const after = state.doc.sliceString(pos, line.to)
  const close = after.indexOf(']]')
  if (close < 0) return null
  const tail = after.slice(0, close)
  return tail.includes('[[') ? null : tail
}

/**
 * The edit a picker makes: replace the segment under the caret with `text`,
 * keeping whatever the link already carries after it. Picking a note inside
 * `[[old note#section|alias]]` used to replace only the text up to the caret
 * and append its own `]]`, leaving `[[new note]]#section|alias]]` (#686). The
 * segment ends at the first of `stops` in the closed link's tail (the note
 * segment stops at `#`, `^` or `|`; a heading at `|` or a nested `#`), so the
 * old name is replaced whole even when the caret sat in the middle of it, and
 * the section and alias survive untouched. A link still being typed gets the
 * closing brackets, as before, and never eats text after the caret.
 */
function linkSegmentEdit(
  state: EditorState,
  from: number,
  to: number,
  text: string,
  stops: string
): TransactionSpec {
  const tail = closedLinkTail(state, to)
  if (tail === null) {
    const insert = `${text}]]`
    return { changes: { from, to, insert }, selection: { anchor: from + insert.length } }
  }
  let end = tail.length
  for (const stop of stops) {
    const at = tail.indexOf(stop)
    if (at >= 0 && at < end) end = at
  }
  return { changes: { from, to: to + end, insert: text }, selection: { anchor: from + text.length } }
}

const NOTE_SEGMENT_STOPS = '#^|'

function wikilinkMatch(context: CompletionContext): {
  openFrom: number
  from: number
  hasBangPrefix: boolean
  query: string
} | null {
  const { state, pos } = context
  const line = state.doc.lineAt(pos)
  const before = state.doc.sliceString(line.from, pos)
  const openIndex = before.lastIndexOf('[[')
  if (openIndex < 0) return null

  const inside = before.slice(openIndex + 2)
  if (inside.includes(']]')) return null
  if (inside.includes('|')) return null
  if (inside.includes('#') || inside.includes('^')) return null

  return {
    openFrom: line.from + openIndex,
    from: line.from + openIndex + 2,
    hasBangPrefix: openIndex > 0 && before[openIndex - 1] === '!',
    query: inside
  }
}

type WikilinkCompletion = Completion & {
  _kind: 'wikilink'
  _target: string
  _subtitle: string
}

export function wikilinkSource(context: CompletionContext): CompletionResult | null {
  const match = wikilinkMatch(context)
  if (!match) return null

  const state = useStore.getState()
  const activePath = state.activeNote?.path ?? null
  const ranked = linkCandidates(match.query, {
    notes: state.notes,
    assetFiles: state.assetFiles,
    folders: state.folders,
    vaultSettings: state.vaultSettings,
    activePath
  })

  const options: Completion[] = ranked.map((candidate: LinkCandidate) => {
    const target = candidate.target
    const subtitle = candidate.subtitle

    if (candidate.kind === 'asset') {
      return {
        label: candidate.label,
        detail: subtitle,
        type: candidate.asset.kind === 'image' ? 'image' : 'file',
        _kind: 'wikilink',
        _target: target,
        _subtitle: subtitle,
        apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
          const edit = linkSegmentEdit(view.state, from, to, target, NOTE_SEGMENT_STOPS)
          const addBangPrefix = !match.hasBangPrefix
          const anchor = (edit.selection as { anchor: number }).anchor + (addBangPrefix ? 1 : 0)
          view.dispatch({
            changes: addBangPrefix
              ? [{ from: match.openFrom, to: match.openFrom, insert: '!' }, edit.changes!]
              : edit.changes,
            selection: { anchor }
          })
        }
      } as WikilinkCompletion
    }

    return {
      label: candidate.label,
      detail: subtitle,
      type: candidate.kind === 'database' ? 'class' : 'text',
      _kind: 'wikilink',
      _target: target,
      _subtitle: subtitle,
      apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
        view.dispatch(linkSegmentEdit(view.state, from, to, target, NOTE_SEGMENT_STOPS))
      }
    } as WikilinkCompletion
  })

  return {
    from: match.from,
    options,
    filter: false
  }
}

/**
 * `@`-triggered note linking (#332). `@` already inserts a date shortcut
 * (Today/Yesterday/Tomorrow); this adds note suggestions to the same trigger so
 * `@` is a quick alternative to `[[`. At least one character after `@` is
 * required, so a bare `@` still leads with the date shortcuts. Picking a note
 * replaces the whole `@query` with a `[[Note]]` wikilink, so backlinks work
 * exactly as with `[[`.
 */
function atNoteMatch(context: CompletionContext): { from: number; query: string } | null {
  const { state, pos } = context
  const line = state.doc.lineAt(pos)
  const before = state.doc.sliceString(line.from, pos)
  // Same `@` boundary rule as the date shortcuts: start of line, or after
  // whitespace / an opening bracket.
  const m = before.match(/(?:^|[\s([{}])(@[^\s@]*)$/)
  if (!m) return null
  const token = m[1]
  return { from: pos - token.length, query: token.slice(1).toLowerCase() }
}

export function atNoteSource(context: CompletionContext): CompletionResult | null {
  const match = atNoteMatch(context)
  if (!match || match.query.length < 1) return null

  const state = useStore.getState()
  const activePath = state.activeNote?.path ?? null
  const ranked = linkCandidates(match.query, {
    notes: state.notes,
    vaultSettings: state.vaultSettings,
    activePath
  })
  if (ranked.length === 0) return null

  const options: Completion[] = ranked.map((candidate) => {
    const target = candidate.target
    const subtitle = candidate.subtitle
    return {
      label: candidate.label,
      detail: subtitle,
      type: 'text',
      _kind: 'wikilink',
      _target: target,
      _subtitle: subtitle,
      apply: (view: EditorView, _completion: Completion, _from: number, to: number) => {
        // Replace the whole `@query` with a full `[[Note]]` wikilink.
        const insert = `[[${target}]]`
        view.dispatch({
          changes: { from: match.from, to, insert },
          selection: { anchor: match.from + insert.length }
        })
      }
    } as WikilinkCompletion
  })

  // Anchor `from` just after the `@` (like the date source) so both `@` sources
  // share a menu; the apply above still replaces the `@` itself.
  return { from: match.from + 1, options, filter: false }
}

/**
 * Match `[[Note#<headingQuery>` so we can suggest the target note's headings.
 * The note is everything before the first `#`; the heading query is whatever
 * follows the last `#` (so nested `#a#b` still completes the deepest part).
 */
function wikilinkAnchorMatch(
  context: CompletionContext,
  marker: '#' | '^'
): {
  from: number
  notePart: string
  query: string
} | null {
  const { state, pos } = context
  const line = state.doc.lineAt(pos)
  const before = state.doc.sliceString(line.from, pos)
  const openIndex = before.lastIndexOf('[[')
  if (openIndex < 0) return null

  const inside = before.slice(openIndex + 2)
  if (inside.includes(']]') || inside.includes('|')) return null
  const first = inside.indexOf(marker)
  if (first < 0) return null // no anchor of this kind; `wikilinkSource` owns this
  // Whichever marker opens the anchor owns everything after it, the same rule
  // wikilinkHeadingAnchor / wikilinkBlockAnchor follow, with the same Obsidian
  // exception: in `[[Note#^` the hash immediately followed by the caret is the
  // canonical block form, so the caret owns the anchor and the heading source
  // stands down. (#601)
  const other = inside.indexOf(marker === '#' ? '^' : '#')
  let noteEnd = first
  if (marker === '#') {
    if (other >= 0 && other < first) return null
    if (inside.slice(first + 1).startsWith('^')) return null
  } else if (other >= 0 && other < first) {
    if (inside.slice(other + 1, first).trim() !== '') return null
    noteEnd = other
  }
  const last = inside.lastIndexOf(marker)

  return {
    from: line.from + openIndex + 2 + last + 1,
    notePart: inside.slice(0, noteEnd).trim(),
    query: inside.slice(last + 1)
  }
}

// Bodies fetched for anchor completion are cached so typing the query doesn't
// re-read the file on every keystroke. An entry is only trusted while the
// note's `updatedAt` still matches: block ids are typically created seconds
// before being linked, so a session-long snapshot made block completion a
// first-use failure (new ids never appeared until restart), and a vault switch
// could even serve another vault's ids for a same-relative-path note.
const anchorBodyCache = new Map<string, { updatedAt: number; body: string }>()
const ANCHOR_BODY_CACHE_LIMIT = 32

/**
 * The body used for `[[Note#…]]` / `[[Note^…]]` completion. An open buffer
 * always wins (it holds unsaved ids); otherwise a read validated against the
 * note's `updatedAt`.
 */
async function anchorNoteBody(notePart: string): Promise<string | null> {
  const state = useStore.getState()
  const note = notePart ? resolveWikilinkTarget(state.notes, notePart) : state.activeNote
  if (!note) return null

  const open = state.noteContents[note.path]?.body
  if (open != null) return open
  const inline = (note as { body?: string }).body // activeNote ([[#…]]) carries its body
  if (inline != null) return inline

  const updatedAt = (note as { updatedAt?: number }).updatedAt ?? 0
  const cached = anchorBodyCache.get(note.path)
  if (cached && cached.updatedAt === updatedAt) return cached.body

  try {
    const read = (await window.zen.readNote(note.path)).body
    if (anchorBodyCache.size >= ANCHOR_BODY_CACHE_LIMIT) anchorBodyCache.clear()
    anchorBodyCache.set(note.path, { updatedAt, body: read })
    return read
  } catch {
    return null
  }
}

/**
 * Insert `text` as the anchor under the caret, closing the wikilink when the
 * link is still being typed and otherwise keeping the `|alias` (and, for a
 * heading, a nested `#part`) that already follows (#686).
 */
function applyAnchorCompletion(text: string, stops: string) {
  return (view: EditorView, _completion: Completion, from: number, to: number): void => {
    view.dispatch(linkSegmentEdit(view.state, from, to, text, stops))
  }
}

/**
 * Autocomplete block ids inside a wikilink: typing `[[Note^` (or `[[^` for the
 * current note) suggests that note's block ids, with the block's own text as
 * the hint so you can tell them apart. (#601)
 */
export async function wikilinkBlockSource(
  context: CompletionContext
): Promise<CompletionResult | null> {
  const match = wikilinkAnchorMatch(context, '^')
  if (!match) return null

  const body = await anchorNoteBody(match.notePart)
  if (body == null) return null

  const lines = body.split('\n')
  const seen = new Set<string>()
  const options: Completion[] = []
  for (const anchor of parseBlockAnchors(body)) {
    const key = normalize(anchor.id)
    if (seen.has(key)) continue
    seen.add(key)
    // Show what the id actually marks; an id on its own line describes the
    // block above it, so fall back to that.
    const markerLine = lines[anchor.markerLine - 1] ?? ''
    const own = markerLine.slice(0, anchor.markerFrom - anchor.markerLineFrom).trim()
    const detail = own || (lines[anchor.line - 1] ?? '').trim()
    options.push({
      label: anchor.id,
      detail: detail.slice(0, 60) || undefined,
      type: 'text',
      apply: applyAnchorCompletion(anchor.id, '|')
    })
    if (options.length >= 100) break
  }
  if (options.length === 0) return null

  return { from: match.from, options, validFor: /^[^\]|]*$/ }
}

export async function wikilinkHeadingSource(
  context: CompletionContext
): Promise<CompletionResult | null> {
  const match = wikilinkAnchorMatch(context, '#')
  if (!match) return null

  const body = await anchorNoteBody(match.notePart)
  if (body == null) return null

  const seen = new Set<string>()
  const options: Completion[] = []
  for (const heading of parseOutline(body)) {
    const text = heading.text.trim()
    const key = normalize(text)
    if (!text || seen.has(key)) continue
    seen.add(key)
    options.push({
      label: text,
      detail: `H${heading.level}`,
      type: 'text',
      apply: applyAnchorCompletion(text, '#|')
    })
    if (options.length >= 100) break
  }
  if (options.length === 0) return null

  // Default filter (fuzzy) on the heading query; validFor lets CodeMirror keep
  // and filter the list client-side while the query stays anchor-shaped.
  return { from: match.from, options, validFor: /^[^\]|]*$/ }
}
