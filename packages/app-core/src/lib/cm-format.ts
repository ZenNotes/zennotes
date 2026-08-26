/**
 * Inline Markdown formatting commands for the selection bubble toolbar: toggle a
 * symmetric marker (`**` bold, `*` italic, `~~` strike, `` ` `` code, `==`
 * highlight, `$` math) around the selection, or wrap it as a link. (#201-style
 * quick-format affordance.)
 */
import { EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

// Symmetric inline markers the formatting shortcuts insert empty (`toggleWrap`
// drops the cursor between them). Ordered longest-first so `**|**` matches `**`
// (bold) before `*` (italic), and `~~`/`==` before nothing shorter. (#468)
const WRAP_MARKERS = ['**', '~~', '==', '*', '`', '$'] as const

/** The cursor sits between an empty `marker` pair, e.g. `**|**` for `**`. */
function isEmptyPairAt(state: EditorState, at: number, marker: string): boolean {
  if (at - marker.length < 0 || at + marker.length > state.doc.length) return false
  return (
    state.sliceDoc(at - marker.length, at) === marker &&
    state.sliceDoc(at, at + marker.length) === marker
  )
}

/**
 * A *longer* marker also forms an empty pair here, so the one being toggled is
 * only the inner slice of it. Guards the empty-pair removal below: in a fresh
 * `**|**`, Ctrl+I finds a `*` on each side and would otherwise delete the inner
 * half of the bold pair — destroying the bold the user just started instead of
 * nesting italic inside it. Same longest-marker-wins rule the Backspace handler
 * follows (#468).
 */
function longerMarkerPairAt(state: EditorState, at: number, marker: string): boolean {
  return WRAP_MARKERS.some((w) => w.length > marker.length && isEmptyPairAt(state, at, w))
}

/**
 * `text` (the line up to the cursor) leaves `marker` open — an odd number of
 * them, so the cursor is inside a span this marker started. A single `*` skips
 * any occurrence that touches another `*`, so a `**bold**` earlier on the line
 * isn't counted as two italics. Deliberately a count rather than a parse: the
 * question is only which way the shortcut should lean, and a wrong guess just
 * inserts the pair as before.
 */
function isInsideUnclosedMarker(text: string, marker: string): boolean {
  let count = 0
  let index = 0
  while (index < text.length) {
    const found = text.indexOf(marker, index)
    if (found === -1) break
    if (
      marker !== '*' ||
      (text[found - 1] !== '*' && text[found + marker.length] !== '*')
    ) {
      count++
    }
    index = found + marker.length
  }
  return count % 2 === 1
}

/**
 * When the cursor sits between two identical *empty* formatting markers — e.g.
 * `**|**` just inserted by Ctrl+B, or `` `|` `` — Backspace should remove the
 * whole snippet in one press, not a single marker character (#468). Returns the
 * delete transaction, or null when the cursor isn't between an empty pair.
 */
export function formatMarkerBackspaceTransaction(state: EditorState): TransactionSpec | null {
  const sel = state.selection.main
  if (!sel.empty) return null
  const head = sel.head
  const link = emptyLinkBackspaceTransaction(state, head)
  if (link) return link
  for (const m of WRAP_MARKERS) {
    if (isEmptyPairAt(state, head, m)) {
      return {
        changes: { from: head - m.length, to: head + m.length, insert: '' },
        selection: EditorSelection.cursor(head - m.length)
      }
    }
  }
  return null
}

/**
 * The empty link scaffold Ctrl+K leaves behind (and the `/link` and `/image`
 * slash commands), with the caret in either hole: `[](|)`, `[|]()`, or their
 * `![…]()` image forms. Backspace inside one removes the whole scaffold. Left
 * to the auto-pair rule it deleted only the `()` and stranded a `[]` (#678).
 * Returns null unless both the text and the URL are empty.
 */
function emptyLinkBackspaceTransaction(state: EditorState, head: number): TransactionSpec | null {
  const slice = (from: number, to: number): string =>
    state.sliceDoc(Math.max(0, from), Math.min(state.doc.length, to))
  const remove = (from: number, to: number): TransactionSpec => ({
    changes: { from, to, insert: '' },
    selection: EditorSelection.cursor(from)
  })
  // Caret in the URL hole: `[](|)`.
  if (slice(head - 3, head) === '[](' && slice(head, head + 1) === ')') {
    const bang = slice(head - 4, head - 3) === '!' ? 1 : 0
    return remove(head - 3 - bang, head + 1)
  }
  // Caret in the text hole: `[|]()`.
  if (slice(head - 1, head) === '[' && slice(head, head + 3) === ']()') {
    const bang = slice(head - 2, head - 1) === '!' ? 1 : 0
    return remove(head - 1 - bang, head + 3)
  }
  return null
}

/**
 * Toggle a symmetric inline marker around each selection range: wrap when it
 * isn't wrapped, unwrap when the markers already sit just outside (or just
 * inside) the selection.
 */
export function toggleWrap(view: EditorView, marker: string): boolean {
  const m = marker
  view.dispatch(
    view.state.changeByRange((range) => {
      const { from, to } = range
      if (from === to) {
        const before = view.state.sliceDoc(Math.max(0, from - m.length), from)
        const after = view.state.sliceDoc(from, Math.min(view.state.doc.length, from + m.length))

        if (after === m) {
          if (before === m && !longerMarkerPairAt(view.state, from, m)) {
            // Empty pair: pressing the shortcut again removes the markers.
            return {
              changes: { from: from - m.length, to: from + m.length, insert: '' },
              range: EditorSelection.cursor(from - m.length)
            }
          }

          const line = view.state.doc.lineAt(from)
          const lineBefore = view.state.sliceDoc(line.from, from)
          if (isInsideUnclosedMarker(lineBefore, m)) {
            // Cursor is just before the closing marker from a previously inserted
            // pair. Treat the shortcut as leaving/toggling off formatting instead
            // of inserting another marker pair inside it.
            return {
              changes: [],
              range: EditorSelection.cursor(from + m.length)
            }
          }
        }

        // No selection: insert the pair and drop the cursor between them.
        return {
          changes: { from, insert: m + m },
          range: EditorSelection.cursor(from + m.length)
        }
      }
      const before = view.state.sliceDoc(Math.max(0, from - m.length), from)
      const after = view.state.sliceDoc(to, Math.min(view.state.doc.length, to + m.length))
      if (before === m && after === m) {
        // Unwrap: drop the markers just outside the selection.
        return {
          changes: [
            { from: from - m.length, to: from, insert: '' },
            { from: to, to: to + m.length, insert: '' }
          ],
          range: EditorSelection.range(from - m.length, to - m.length)
        }
      }
      const selected = view.state.sliceDoc(from, to)
      if (selected.length >= m.length * 2 && selected.startsWith(m) && selected.endsWith(m)) {
        // The selection itself includes the markers — strip them from inside.
        return {
          changes: { from, to, insert: selected.slice(m.length, selected.length - m.length) },
          range: EditorSelection.range(from, to - m.length * 2)
        }
      }
      // Wrap.
      return {
        changes: [
          { from, insert: m },
          { from: to, insert: m }
        ],
        range: EditorSelection.range(from + m.length, to + m.length)
      }
    })
  )
  view.focus()
  return true
}

/**
 * The block types offered by the selection toolbar's "Turn into" menu — a
 * lighter version of Notion's block menu.
 */
export type BlockType =
  | 'paragraph'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'bullet'
  | 'numbered'
  | 'todo'
  | 'quote'
  | 'code'

// Leading block marker (indent captured separately): heading, quote, list
// bullet (optionally a task checkbox in any state), or an ordered-list number.
const LINE_MARKER_RE = /^(\s*)(?:#{1,6}\s+|>\s+|[-*+]\s+\[[ xX>/-]\]\s+|[-*+]\s+|\d+[.)]\s+)?/

function blockPrefix(type: BlockType, index: number): string {
  switch (type) {
    case 'h1':
      return '# '
    case 'h2':
      return '## '
    case 'h3':
      return '### '
    case 'bullet':
      return '- '
    case 'numbered':
      return `${index + 1}. `
    case 'todo':
      return '- [ ] '
    case 'quote':
      return '> '
    default:
      return '' // paragraph
  }
}

/**
 * Turn the line(s) touched by the selection into a block of `type`: re-prefix
 * each line (stripping any existing heading/list/quote marker), or wrap them in
 * a fenced code block. "paragraph" just removes the marker.
 */
export function setBlockType(view: EditorView, type: BlockType): boolean {
  const { state } = view
  const sel = state.selection.main
  const firstLine = state.doc.lineAt(sel.from)
  const lastLine = state.doc.lineAt(sel.to)

  if (type === 'code') {
    const text = state.sliceDoc(firstLine.from, lastLine.to)
    const insert = '```\n' + text + '\n```'
    view.dispatch({
      changes: { from: firstLine.from, to: lastLine.to, insert },
      selection: EditorSelection.range(firstLine.from + 4, firstLine.from + 4 + text.length)
    })
    view.focus()
    return true
  }

  const changes: Array<{ from: number; to: number; insert: string }> = []
  let index = 0
  for (let ln = firstLine.number; ln <= lastLine.number; ln++) {
    const line = state.doc.line(ln)
    if (line.text.trim() === '') continue
    const m = line.text.match(LINE_MARKER_RE)
    const indent = m?.[1] ?? ''
    const body = line.text.slice(m?.[0].length ?? 0)
    const next = indent + blockPrefix(type, index) + body
    index++
    if (next !== line.text) changes.push({ from: line.from, to: line.to, insert: next })
  }
  if (changes.length > 0) view.dispatch({ changes })
  view.focus()
  return true
}

/**
 * Wrap each selection as a Markdown link `[text](url)`, leaving the cursor in
 * the empty `()` so the URL can be typed. An empty selection inserts `[]()`.
 */
export function wrapLink(view: EditorView): boolean {
  view.dispatch(
    view.state.changeByRange((range) => {
      const { from, to } = range
      const text = view.state.sliceDoc(from, to)
      const insert = `[${text}]()`
      // Cursor between the parentheses: after `[text](`.
      const cursor = from + 1 + text.length + 2
      return { changes: { from, to, insert }, range: EditorSelection.cursor(cursor) }
    })
  )
  view.focus()
  return true
}
