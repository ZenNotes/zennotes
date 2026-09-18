import { indentLess, indentMore, redo, undo } from '@codemirror/commands'
import { closeSearchPanel, openSearchPanel } from '@codemirror/search'
import type { EditorView } from '@codemirror/view'
import type { EditorCommand } from '../editor'
import { setBlockType, toggleWrap, wrapLink, type BlockType } from './cm-format'

const BLANK_LINE_MARKERS: Partial<Record<BlockType, string>> = {
  bullet: '- ',
  todo: '- [ ] ',
  h1: '# ',
  h2: '## ',
  h3: '### '
}

// A mobile toolbar is also how users start an empty list. The selection toolbar's
// conversion helper intentionally skips blank lines, so retain this shell behavior.
function applyBlockType(view: EditorView, type: BlockType): boolean {
  const { from, to } = view.state.selection.main
  const line = view.state.doc.lineAt(from)
  const marker = BLANK_LINE_MARKERS[type]
  if (marker !== undefined && from === to && line.text.trim() === '') {
    const insert = line.text + marker
    view.dispatch({
      changes: { from: line.from, to: line.to, insert },
      selection: { anchor: line.from + insert.length }
    })
    return true
  }
  return setBlockType(view, type)
}

function cycleHeading(view: EditorView): boolean {
  const line = view.state.doc.lineAt(view.state.selection.main.from)
  const level = line.text.match(/^(#{1,6})\s/)?.[1].length ?? 0
  const next = level >= 3 ? 'paragraph' : (['h1', 'h2', 'h3'] as const)[level]!
  return applyBlockType(view, next)
}

function insertSnippet(view: EditorView, text: string, caretOffset: number): boolean {
  const { from, to } = view.state.selection.main
  view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + caretOffset } })
  return true
}

export function runNoteEditorCommand(view: EditorView, command: EditorCommand): boolean {
  // Search owns its focus. Refocusing the editor here would dismiss the native
  // keyboard's query target immediately after the host opens Find.
  if (command === 'open-search') return openSearchPanel(view)
  if (command === 'close-search') return closeSearchPanel(view)
  if (view.state.readOnly) return false

  let handled: boolean
  switch (command) {
    case 'undo':
      handled = undo(view)
      break
    case 'redo':
      handled = redo(view)
      break
    case 'indent':
      handled = indentMore(view)
      break
    case 'outdent':
      handled = indentLess(view)
      break
    case 'toggle-bold':
      handled = toggleWrap(view, '**')
      break
    case 'toggle-italic':
      handled = toggleWrap(view, '*')
      break
    case 'toggle-strikethrough':
      handled = toggleWrap(view, '~~')
      break
    case 'toggle-highlight':
      handled = toggleWrap(view, '==')
      break
    case 'toggle-inline-code':
      handled = toggleWrap(view, '`')
      break
    case 'insert-link':
      handled = wrapLink(view)
      break
    case 'insert-wikilink':
      handled = insertSnippet(view, '[[]]', 2)
      break
    case 'insert-tag':
      handled = insertSnippet(view, '#', 1)
      break
    case 'set-bullet-list':
      handled = applyBlockType(view, 'bullet')
      break
    case 'set-task-list':
      handled = applyBlockType(view, 'todo')
      break
    case 'cycle-heading':
      handled = cycleHeading(view)
      break
    default:
      return false
  }
  view.focus()
  return handled
}
