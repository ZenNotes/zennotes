// @vitest-environment jsdom

import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import {
  formatMarkerBackspaceTransaction,
  setBlockType,
  toggleWrap,
  wrapLink
} from './cm-format'

const views: EditorView[] = []
function mount(doc: string, from: number, to: number): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc, selection: EditorSelection.range(from, to) })
  })
  views.push(view)
  return view
}

afterEach(() => {
  while (views.length) views.pop()!.destroy()
})

describe('toggleWrap', () => {
  it('wraps the selection and keeps it selected', () => {
    const view = mount('hello world', 6, 11) // "world"
    toggleWrap(view, '**')
    expect(view.state.doc.toString()).toBe('hello **world**')
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      'world'
    )
  })

  it('unwraps when the markers sit just outside the selection', () => {
    const view = mount('hello **world**', 8, 13) // "world" inside the **…**
    toggleWrap(view, '**')
    expect(view.state.doc.toString()).toBe('hello world')
  })

  it('unwraps when the selection itself includes the markers', () => {
    const view = mount('a *italic* b', 2, 10) // "*italic*"
    toggleWrap(view, '*')
    expect(view.state.doc.toString()).toBe('a italic b')
  })

  it('inserts an empty pair with the cursor between on an empty selection', () => {
    const view = mount('x', 1, 1)
    toggleWrap(view, '==')
    expect(view.state.doc.toString()).toBe('x====')
    expect(view.state.selection.main.empty).toBe(true)
    expect(view.state.selection.main.head).toBe(3) // between == and ==
  })

  it('moves past the closing marker when toggling off an active empty-selection wrap', () => {
    const view = mount('**bold** text', 6, 6) // cursor before closing **
    toggleWrap(view, '**')
    expect(view.state.doc.toString()).toBe('**bold** text')
    expect(view.state.selection.main.empty).toBe(true)
    expect(view.state.selection.main.head).toBe(8)
  })

  it('removes an untouched empty pair when pressing the shortcut again', () => {
    const view = mount('****', 2, 2) // between the opening and closing **
    toggleWrap(view, '**')
    expect(view.state.doc.toString()).toBe('')
    expect(view.state.selection.main.empty).toBe(true)
    expect(view.state.selection.main.head).toBe(0)
  })

  it('nests italic inside a fresh bold pair instead of eating its markers', () => {
    // `**|**` from Ctrl+B, then Ctrl+I: the `*` on each side belongs to the bold
    // pair, so removing it would destroy the bold the user just started.
    const view = mount('****', 2, 2)
    toggleWrap(view, '*')
    expect(view.state.doc.toString()).toBe('******')
    expect(view.state.selection.main.head).toBe(3)
  })

  it('toggles bold off inside a bold+italic pair, leaving the italic', () => {
    const view = mount('******', 3, 3)
    toggleWrap(view, '**')
    expect(view.state.doc.toString()).toBe('**')
    expect(view.state.selection.main.head).toBe(1)
  })

  it('does not treat a cursor before a later opening marker as active formatting', () => {
    const view = mount('**done** **next**', 9, 9) // cursor before the second opening **
    toggleWrap(view, '**')
    expect(view.state.doc.toString()).toBe('**done** ******next**')
    expect(view.state.selection.main.head).toBe(11)
  })

  it('works for the other markers', () => {
    for (const [marker, expected] of [
      ['~~', 'a ~~b~~ c'],
      ['`', 'a `b` c'],
      ['$', 'a $b$ c']
    ] as const) {
      const view = mount('a b c', 2, 3)
      toggleWrap(view, marker)
      expect(view.state.doc.toString()).toBe(expected)
    }
  })
})

// #468: Backspace inside a just-inserted empty formatting snippet (`**|**`)
// should remove the whole pair, not one marker character.
describe('formatMarkerBackspaceTransaction', () => {
  function backspace(doc: string, head: number): { doc: string; head: number } | null {
    const state = EditorState.create({ doc, selection: EditorSelection.cursor(head) })
    const tr = formatMarkerBackspaceTransaction(state)
    if (!tr) return null
    const next = state.update(tr).state
    return { doc: next.doc.toString(), head: next.selection.main.head }
  }

  it('removes the whole pair for every empty formatting snippet', () => {
    // doc, cursor-between-the-markers
    expect(backspace('****', 2)).toEqual({ doc: '', head: 0 }) // **|** bold
    expect(backspace('**', 1)).toEqual({ doc: '', head: 0 }) // *|* italic
    expect(backspace('~~~~', 2)).toEqual({ doc: '', head: 0 }) // ~~|~~ strike
    expect(backspace('====', 2)).toEqual({ doc: '', head: 0 }) // ==|== highlight
    expect(backspace('``', 1)).toEqual({ doc: '', head: 0 }) // `|` inline code
    expect(backspace('$$', 1)).toEqual({ doc: '', head: 0 }) // $|$ math
  })

  it('prefers the longest marker so `**|**` deletes all four, not `*|*`', () => {
    expect(backspace('****', 2)).toEqual({ doc: '', head: 0 })
  })

  it('deletes only the empty snippet when it is surrounded by text', () => {
    expect(backspace('x****y', 3)).toEqual({ doc: 'xy', head: 1 })
  })

  it('leaves a non-empty snippet alone (only one marker char removed by default)', () => {
    expect(backspace('**b**', 3)).toBeNull() // cursor after the `b`
    expect(backspace('**b**', 2)).toBeNull() // cursor before the `b`
  })

  it('does nothing at the start of the document or with a selection', () => {
    expect(backspace('****', 0)).toBeNull()
    const state = EditorState.create({ doc: '****', selection: EditorSelection.range(0, 2) })
    expect(formatMarkerBackspaceTransaction(state)).toBeNull()
  })

  // #678: Ctrl+K leaves `[](|)` with the caret in the URL hole; Backspace there
  // must take the whole scaffold, not just the parentheses.
  it('removes an empty link scaffold from the URL hole', () => {
    expect(backspace('[]()', 3)).toEqual({ doc: '', head: 0 })
    expect(backspace('See []() now', 7)).toEqual({ doc: 'See  now', head: 4 })
  })

  it('removes an empty link scaffold from the text hole (slash-command form)', () => {
    expect(backspace('[]()', 1)).toEqual({ doc: '', head: 0 })
  })

  it('removes an empty image scaffold in both holes', () => {
    expect(backspace('![]()', 4)).toEqual({ doc: '', head: 0 })
    expect(backspace('![]()', 2)).toEqual({ doc: '', head: 0 })
  })

  it('leaves a link alone once either hole has content', () => {
    expect(backspace('[text]()', 7)).toBeNull()
    expect(backspace('[](url)', 6)).toBeNull()
    expect(backspace('[](url)', 1)).toBeNull()
  })
})

describe('setBlockType', () => {
  it('turns a paragraph into a heading', () => {
    const view = mount('hello', 0, 5)
    setBlockType(view, 'h1')
    expect(view.state.doc.toString()).toBe('# hello')
  })

  it('re-types an existing block, replacing its marker', () => {
    const view = mount('## hello', 0, 0)
    setBlockType(view, 'h3')
    expect(view.state.doc.toString()).toBe('### hello')
  })

  it('turns a list item back into plain text', () => {
    const view = mount('- item', 0, 0)
    setBlockType(view, 'paragraph')
    expect(view.state.doc.toString()).toBe('item')
  })

  it('makes a to-do and a quote', () => {
    const todo = mount('task', 0, 4)
    setBlockType(todo, 'todo')
    expect(todo.state.doc.toString()).toBe('- [ ] task')

    const quote = mount('wisdom', 0, 6)
    setBlockType(quote, 'quote')
    expect(quote.state.doc.toString()).toBe('> wisdom')
  })

  it('numbers a multi-line selection sequentially', () => {
    const view = mount('a\nb\nc', 0, 5)
    setBlockType(view, 'numbered')
    expect(view.state.doc.toString()).toBe('1. a\n2. b\n3. c')
  })

  it('preserves indentation when re-typing', () => {
    const view = mount('  - nested', 0, 0)
    setBlockType(view, 'bullet')
    expect(view.state.doc.toString()).toBe('  - nested')
  })

  it('wraps the selection in a fenced code block', () => {
    const view = mount('print(1)', 0, 8)
    setBlockType(view, 'code')
    expect(view.state.doc.toString()).toBe('```\nprint(1)\n```')
  })
})

describe('wrapLink', () => {
  it('wraps the selection as [text]() with the cursor in the parens', () => {
    const view = mount('see docs here', 4, 8) // "docs"
    wrapLink(view)
    expect(view.state.doc.toString()).toBe('see [docs]() here')
    // Cursor sits between ( and ): after "see [docs](" = index 11.
    expect(view.state.selection.main.head).toBe(11)
  })
})
