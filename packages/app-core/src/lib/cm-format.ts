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

function isEmptyPairAtText(text: string, at: number, marker: string): boolean {
  if (at - marker.length < 0 || at + marker.length > text.length) return false
  return (
    text.slice(at - marker.length, at) === marker &&
    text.slice(at, at + marker.length) === marker
  )
}

function longerMarkerPairAtText(text: string, at: number, marker: string): boolean {
  return WRAP_MARKERS.some((w) => w.length > marker.length && isEmptyPairAtText(text, at, w))
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
 * Pure-text version of the symmetric-marker toggle. Returns a single change
 * range and the selection that should be active after applying it.
 */
export function toggleWrapEdit(
  text: string,
  marker: string,
  from: number,
  to: number,
  lineStart = 0
): { from: number; to: number; insert: string; selection: { from: number; to: number } } {
  const m = marker
  if (from === to) {
    const before = text.slice(Math.max(0, from - m.length), from)
    const after = text.slice(from, Math.min(text.length, from + m.length))

    if (after === m && before === m && !longerMarkerPairAtText(text, from, m)) {
      // Empty pair: pressing the shortcut again removes the markers.
      return {
        from: from - m.length,
        to: from + m.length,
        insert: '',
        selection: { from: from - m.length, to: from - m.length }
      }
    }

    if (after === m) {
      const lineBefore = text.slice(lineStart, from)
      if (isInsideUnclosedMarker(lineBefore, m)) {
        // Cursor is just before the closing marker from a previously inserted
        // pair. Leave the span instead of inserting another marker pair.
        return {
          from,
          to,
          insert: '',
          selection: { from: from + m.length, to: from + m.length }
        }
      }
    }

    // No selection: insert the pair and drop the cursor between them.
    return {
      from,
      to,
      insert: m + m,
      selection: { from: from + m.length, to: from + m.length }
    }
  }

  const before = text.slice(Math.max(0, from - m.length), from)
  const after = text.slice(to, Math.min(text.length, to + m.length))
  if (before === m && after === m) {
    // Unwrap: drop the markers just outside the selection.
    return {
      from: from - m.length,
      to: to + m.length,
      insert: text.slice(from, to),
      selection: { from: from - m.length, to: to - m.length }
    }
  }
  const selected = text.slice(from, to)
  if (selected.length >= m.length * 2 && selected.startsWith(m) && selected.endsWith(m)) {
    // The selection itself includes the markers — strip them from inside.
    return {
      from,
      to,
      insert: selected.slice(m.length, selected.length - m.length),
      selection: { from, to: to - m.length * 2 }
    }
  }
  // Wrap.
  return {
    from,
    to,
    insert: m + selected + m,
    selection: { from: from + m.length, to: to + m.length }
  }
}

/**
 * Toggle a symmetric inline marker around each selection range: wrap when it
 * isn't wrapped, unwrap when the markers already sit just outside (or just
 * inside) the selection.
 */
export function toggleWrap(view: EditorView, marker: string): boolean {
  const text = view.state.doc.toString()
  view.dispatch(
    view.state.changeByRange((range) => {
      const lineStart = view.state.doc.lineAt(range.from).from
      const edit = toggleWrapEdit(text, marker, range.from, range.to, lineStart)
      return {
        changes: { from: edit.from, to: edit.to, insert: edit.insert },
        range: EditorSelection.range(edit.selection.from, edit.selection.to)
      }
    })
  )
  view.focus()
  return true
}

/**
 * Pure-text version of link wrapping. Returns a single change range and the
 * cursor position after the opening parenthesis.
 */
export function wrapLinkEdit(
  selected: string,
  from: number,
  to: number
): { from: number; to: number; insert: string; cursor: number } {
  const insert = `[${selected}]()`
  return {
    from,
    to,
    insert,
    cursor: from + insert.length - 1
  }
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
      const edit = wrapLinkEdit(view.state.sliceDoc(from, to), from, to)
      // Cursor between the parentheses: after `[text](`.
      return { changes: { from: edit.from, to: edit.to, insert: edit.insert }, range: EditorSelection.cursor(edit.cursor) }
    })
  )
  view.focus()
  return true
}
