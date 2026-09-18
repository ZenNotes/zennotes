// @vitest-environment jsdom

import { autocompletion, completionStatus } from '@codemirror/autocomplete'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { getCM, Vim, vim } from '@replit/codemirror-vim'
import { afterEach, describe, expect, it } from 'vitest'
import { completionKeymapExtension } from './cm-completion-nav'
import { registerDisplayLineMotion } from './cm-vim-display-line'
import { vimAwareDefaultKeymap, vimAwareMarkdownKeymap } from './cm-vim-default-keymap'
import { vimVisualHighlightExtension } from './cm-vim-visual-highlight'
import { vimClipboardPasteExtension } from './cm-vim-clipboard'

// jsdom has no layout. The #803 tests wait on the completion debounce, which
// lets CodeMirror's next-frame measurement run, and without these two methods
// it throws from a deferred callback that Vitest reports as an unhandled error
// (the same trap cm-vim-ime-guard.test.ts documents). Empty geometry is enough.
const rangeProto = Range.prototype as Range & {
  getClientRects?: () => DOMRectList
  getBoundingClientRect?: () => DOMRect
}
if (typeof rangeProto.getClientRects !== 'function') {
  rangeProto.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList
}
if (typeof rangeProto.getBoundingClientRect !== 'function') {
  rangeProto.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0)
}

const views: EditorView[] = []

afterEach(() => {
  views.splice(0).forEach((view) => view.destroy())
})

function mount(doc: string, anchor = 0): EditorView {
  registerDisplayLineMotion(() => 'logical')
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [
        // CM6 runs every keymap from one DOM handler, placed at the FIRST
        // keymap provider. The app mounts one (markdown snippets) ahead of
        // vim(), so all bindings see a key before Vim does. Mounting vim()
        // first here once hid #803: Vim got Escape before `simplifySelection`.
        keymap.of([]),
        vim(),
        // Typed text puts every source into "pending", as in the app.
        autocompletion({ defaultKeymap: false, override: [() => null] }),
        completionKeymapExtension,
        vimVisualHighlightExtension,
        vimClipboardPasteExtension,
        markdown({ base: markdownLanguage, addKeymap: false }),
        vimAwareMarkdownKeymap,
        keymap.of(vimAwareDefaultKeymap(true))
      ]
    })
  })
  views.push(view)
  return view
}

function press(view: EditorView, key: string, modifiers: KeyboardEventInit = {}): void {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers })
  )
}

function selectFirstColumn(view: EditorView): void {
  press(view, 'v', { ctrlKey: true })
  press(view, 'j')
  press(view, 'j')
  expect(getCM(view)?.state.vim?.visualBlock).toBe(true)
}

function insertText(view: EditorView, text: string): void {
  expect(getCM(view)?.state.vim?.insertMode).toBe(true)
  // jsdom does not type into contenteditable. Apply the ordinary CM6 text
  // input transaction so the real Vim adapter observes the insertion.
  view.dispatch({ ...view.state.replaceSelection(text), userEvent: 'input.type' })
  press(view, 'Escape')
}

describe('Vim visual-block editing (#792)', () => {
  it('prefixes every selected row with I, typed text, and Escape', () => {
    const view = mount('one\ntwo\nthree')
    selectFirstColumn(view)

    press(view, 'I')
    insertText(view, '- ')

    expect(view.state.doc.toString()).toBe('- one\n- two\n- three')
    expect(getCM(view)?.state.vim?.insertMode).toBe(false)
  })

  it('appends at the selected block edge with A instead of the logical line end', () => {
    const view = mount('one\ntwo\nthree')
    selectFirstColumn(view)

    press(view, 'A')
    insertText(view, '!')

    expect(view.state.doc.toString()).toBe('o!ne\nt!wo\nt!hree')
  })

  it('prefixes every row when the block was selected from bottom to top', () => {
    const view = mount('one\ntwo\nthree', 8)
    press(view, 'v', { ctrlKey: true })
    press(view, 'k')
    press(view, 'k')

    press(view, 'I')
    insertText(view, '- ')

    expect(view.state.doc.toString()).toBe('- one\n- two\n- three')
  })

  it('deletes the selected columns on every row without joining the lines', () => {
    const view = mount('one\ntwo\nthree')
    selectFirstColumn(view)

    press(view, 'd')

    expect(view.state.doc.toString()).toBe('ne\nwo\nhree')
  })

  it('changes the selected column on every row and returns to normal mode', () => {
    const view = mount('one\ntwo\nthree')
    selectFirstColumn(view)

    press(view, 'c')
    insertText(view, 'X')

    expect(view.state.doc.toString()).toBe('Xne\nXwo\nXhree')
    expect(getCM(view)?.state.vim?.insertMode).toBe(false)
  })

  it('yanks the whole rectangle into a blockwise register without editing the note', () => {
    const view = mount('one\ntwo\nthree')
    selectFirstColumn(view)

    press(view, '"')
    press(view, 'a')
    press(view, 'y')

    const register = Vim.getRegisterController().getRegister('a')
    expect(register.toString()).toBe('o\nt\nt')
    expect(register.blockwise).toBe(true)
    expect(view.state.doc.toString()).toBe('one\ntwo\nthree')
  })

  it('pastes a yanked rectangle as one inserted column per destination row', () => {
    const view = mount('one\ntwo\nthree\n---\n...\n...')
    selectFirstColumn(view)
    for (const key of ['"', 'a', 'y', '3', 'j', '"', 'a', 'P']) press(view, key)

    expect(view.state.doc.toString()).toBe('one\ntwo\nthree\no---\nt...\nt...')
  })

  it('leaves shorter rows and their newlines intact when deleting a later column', () => {
    const view = mount('abcd\nx\nwxyz', 2)
    press(view, 'v', { ctrlKey: true })
    press(view, '2')
    press(view, 'j')

    press(view, 'd')

    expect(view.state.doc.toString()).toBe('abd\nx\nwxz')
  })
})

describe('Escape ends a Vim block operation in normal mode (#803)', () => {
  const vimState = (view: EditorView) => getCM(view)?.state.vim

  async function completionIdle(view: EditorView): Promise<void> {
    const deadline = Date.now() + 5_000
    while (completionStatus(view.state) !== null) {
      if (Date.now() > deadline) throw new Error('completion never settled')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  it.each([
    ['I', '- ', '- one\n- two\n- three'],
    ['A', '!', 'o!ne\nt!wo\nt!hree'],
    ['c', 'X', 'Xne\nXwo\nXhree']
  ])('leaves insert mode with one cursor after block %s', async (key, text, expected) => {
    const view = mount('one\ntwo\nthree')
    selectFirstColumn(view)

    press(view, key)
    expect(view.state.selection.ranges.length).toBe(3)
    view.dispatch({ ...view.state.replaceSelection(text), userEvent: 'input.type' })
    // Settled, so only `simplifySelection` stands between Escape and Vim; the
    // pending-query case has its own test below.
    await completionIdle(view)
    press(view, 'Escape')

    expect(view.state.doc.toString()).toBe(expected)
    expect(vimState(view)?.insertMode).toBe(false)
    expect(vimState(view)?.visualMode).toBe(false)
    expect(view.state.selection.ranges.length).toBe(1)
  })

  it('is not swallowed by a completion query that is only pending', () => {
    const view = mount('one\ntwo\nthree')
    selectFirstColumn(view)
    press(view, 'I')
    view.dispatch({ ...view.state.replaceSelection('- '), userEvent: 'input.type' })
    // No popup exists yet: the sources are inside the activateOnTyping debounce.
    expect(completionStatus(view.state)).toBe('pending')

    press(view, 'Escape')

    expect(vimState(view)?.insertMode).toBe(false)
    expect(completionStatus(view.state)).toBe(null)
  })

  it('leaves visual block in a single press', () => {
    const view = mount('one\ntwo\nthree')
    selectFirstColumn(view)

    press(view, 'Escape')

    expect(vimState(view)?.visualMode).toBe(false)
    expect(view.state.selection.ranges.length).toBe(1)
    expect(view.state.selection.main.empty).toBe(true)
  })

  it('leaves a characterwise selection with the cursor on the last selected character', () => {
    const view = mount('one\ntwo\nthree')
    press(view, 'v')
    press(view, 'l')

    press(view, 'Escape')

    expect(vimState(view)?.visualMode).toBe(false)
    // Vim keeps the cursor on `n`; CodeMirror's own collapse would land past it.
    expect(view.state.selection.main.head).toBe(1)
  })
})

describe('Vim line-boundary insertion outside visual mode', () => {
  it.each([
    ['I', '  !one\ntwo'],
    ['A', '  one!\ntwo']
  ])('keeps normal-mode %s on the current logical line', (key, expected) => {
    const view = mount('  one\ntwo', 3)

    press(view, key)
    insertText(view, '!')

    expect(view.state.doc.toString()).toBe(expected)
  })
})
