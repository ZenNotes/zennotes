// @vitest-environment jsdom
//
// Enter pressed for real in an editor mounted like EditorPane's (note grammar,
// the Vim-aware markdown keymap, ordered-list renumbering): a list never grows
// blank lines of its own, even once one sits between its first two items.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { forceParsing, syntaxTreeAvailable } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { noteMarkdown } from './cm-markdown-language'
import { orderedListRenumber } from './cm-ordered-list-renumber'
import { vimAwareDefaultKeymap, vimAwareMarkdownKeymap } from './cm-vim-default-keymap'

const views: EditorView[] = []
afterEach(() => views.splice(0).forEach((v) => v.destroy()))

/** `doc` with the caret where `|` is. */
function mount(marked: string): EditorView {
  const anchor = marked.indexOf('|')
  if (anchor < 0) throw new Error('no caret in doc')
  const view = new EditorView({
    state: EditorState.create({
      doc: marked.slice(0, anchor) + marked.slice(anchor + 1),
      selection: { anchor },
      extensions: [
        noteMarkdown(),
        vimAwareMarkdownKeymap,
        orderedListRenumber,
        keymap.of([...vimAwareDefaultKeymap(false)])
      ]
    }),
    parent: document.body
  })
  views.push(view)
  view.focus()
  return view
}

/** Enter reads the list from the syntax tree, and a state only gets 20 ms of
 *  parsing: on a slow runner the list is not in the tree yet and Enter is a plain
 *  newline. These tests are about what Enter does to a parsed list. */
function pressEnter(view: EditorView, shiftKey = false): void {
  forceParsing(view, view.state.doc.length, 5000)
  view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, shiftKey, bubbles: true, cancelable: true })
  )
}

/** The doc with `|` at the caret. */
function marked(view: EditorView): string {
  const head = view.state.selection.main.head
  const doc = view.state.doc.toString()
  return doc.slice(0, head) + '|' + doc.slice(head)
}

function type(view: EditorView, text: string): void {
  const head = view.state.selection.main.head
  view.dispatch({ changes: { from: head, insert: text }, selection: { anchor: head + text.length } })
}

describe('Enter in a list keeps it tight', () => {
  it('finishes a parse cut by a slow runner before it presses Enter', () => {
    let now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => (now += 25))
    let view: EditorView
    try {
      view = mount('# Title\n\nProse.\n\n- one\n- two|')
    } finally {
      clock.mockRestore()
    }
    expect(syntaxTreeAvailable(view.state)).toBe(false)
    pressEnter(view)
    expect(marked(view)).toBe('# Title\n\nProse.\n\n- one\n- two\n- |')
  })

  it('opens the next bullet right below once a blank line sits between the first two', () => {
    const view = mount('- one\n\n- two|')
    pressEnter(view)
    expect(marked(view)).toBe('- one\n\n- two\n- |')
    type(view, 'three')
    pressEnter(view)
    expect(marked(view)).toBe('- one\n\n- two\n- three\n- |')
  })

  it('replays the Discord report: Shift+Enter after the first bullet spaces only that gap', () => {
    const view = mount('- one|\n- two')
    pressEnter(view, true)
    expect(marked(view)).toBe('- one\n|\n- two')
    view.dispatch({ selection: { anchor: view.state.doc.length } })
    pressEnter(view)
    type(view, 'three')
    pressEnter(view)
    type(view, 'four')
    expect(view.state.doc.toString()).toBe('- one\n\n- two\n- three\n- four')
  })

  it('leaves a tight list as it was', () => {
    const view = mount('- one\n- two|')
    pressEnter(view)
    expect(marked(view)).toBe('- one\n- two\n- |')
  })

  it('splits an item mid-text without a gap', () => {
    const view = mount('- one\n\n- two|three')
    pressEnter(view)
    expect(marked(view)).toBe('- one\n\n- two\n- |three')
  })

  it('still renumbers the ordered items after the new one', () => {
    const view = mount('1. a\n\n2. b|\n3. c')
    pressEnter(view)
    expect(marked(view)).toBe('1. a\n\n2. b\n3. |\n4. c')
  })

  it('keeps the quote marks of a quoted list', () => {
    const view = mount('> - a\n>\n> - b|')
    pressEnter(view)
    expect(marked(view)).toBe('> - a\n>\n> - b\n> - |')
  })

  it('continues a task as a fresh box without a gap', () => {
    const view = mount('- [x] one\n\n- [ ] two|')
    pressEnter(view)
    expect(marked(view)).toBe('- [x] one\n\n- [ ] two\n- [ ] |')
  })

  it('ends the list on an empty second item instead of pushing it down', () => {
    const view = mount('- one\n- |')
    pressEnter(view)
    expect(marked(view)).toBe('- one\n\n|')
  })

  it('ends the list on an empty later item', () => {
    const view = mount('- one\n- two\n- |')
    pressEnter(view)
    expect(marked(view)).toBe('- one\n- two\n\n|')
  })

  it('leaves a blank line after the list, so what is typed next is not part of the last item', () => {
    // Without it, Markdown reads the typed line as a lazy continuation of
    // "Bread" and Read mode shows "Bread Done by Saturday." (2.81.0 Android walk).
    const view = mount('- Milk\n- Bread\n- |')
    pressEnter(view)
    type(view, 'Done by Saturday.')
    expect(view.state.doc.toString()).toBe('- Milk\n- Bread\n\nDone by Saturday.')
  })

  it('ends a task list the same way', () => {
    const view = mount('- [ ] one\n- [ ] |')
    pressEnter(view)
    expect(marked(view)).toBe('- [ ] one\n\n|')
  })

  it('outdents a nested empty item without adding a line', () => {
    const view = mount('- one\n  - two\n  - |')
    pressEnter(view)
    expect(view.state.doc.toString()).not.toContain('\n\n')
  })
})
