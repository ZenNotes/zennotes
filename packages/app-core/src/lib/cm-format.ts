/**
 * Inline Markdown formatting commands for the selection bubble toolbar: toggle a
 * symmetric marker (`**` bold, `*` italic, `~~` strike, `` ` `` code, `==`
 * highlight, `$` math) around the selection, or wrap it as a link. (#201-style
 * quick-format affordance.)
 */
import { EditorSelection } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

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
// bullet (optionally a task checkbox), or an ordered-list number.
const LINE_MARKER_RE = /^(\s*)(?:#{1,6}\s+|>\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)?/

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
