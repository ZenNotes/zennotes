// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { historyKeymap } from '@codemirror/commands'
import { searchKeymap } from '@codemirror/search'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { vim } from '@replit/codemirror-vim'
import { mapDefaultHalfPageKeys, registerHalfPageMotion } from './cm-vim-half-page-motion'
import { vimHalfPageKeymap } from './vim-half-page-keymap'

/**
 * The wiring the floating note, Quick Note and external-file windows use:
 * the default chords mapped on the global Vim plus the half-page keymap
 * ahead of the search and history keymaps. The main editor maps the user's
 * configured bindings through its keymap sync instead and is covered by
 * vim-half-page-keymap.test.ts.
 *
 * jsdom has no layout: `coordsAtPos` throws, so the motion takes its
 * logical-line fallback (one line per press, N lines with a count) and warns
 * once. The pixel path is covered by the fake-view tests in
 * cm-vim-half-page-motion.test.ts and by driving the built app. Unlike the
 * tests that await timers, this one presses synchronously and destroys every
 * view before the next frame, so the deferred measurement that the other Vim
 * tests stub `Range.prototype` for never runs here, and stubbing it would
 * hand the motion an empty geometry instead of the fallback under test.
 */
describe('default half-page keys in a secondary window', () => {
  const views: EditorView[] = []
  const doc = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'].join('\n')

  beforeAll(() => {
    // Both are the jsdom geometry failure: the motion's own fallback warning
    // and CodeMirror logging the block-cursor measure it runs on the way in.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    registerHalfPageMotion()
    mapDefaultHalfPageKeys()
  })

  afterEach(() => {
    views.splice(0).forEach((view) => view.destroy())
  })

  function mount(): EditorView {
    // Same order as the windows: keymap before vim(), so CodeMirror's keymap
    // handler sees the chord first, and multiple selections allowed as
    // cm-vim-visual-highlight does, which is what let Ctrl+D add a cursor.
    const view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [
          EditorState.allowMultipleSelections.of(true),
          keymap.of([...vimHalfPageKeymap(true, {}), ...historyKeymap, ...searchKeymap]),
          vim()
        ]
      }),
      parent: document.body
    })
    views.push(view)
    view.focus()
    return view
  }

  function press(view: EditorView, key: string, modifiers: KeyboardEventInit = {}): void {
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers })
    )
  }

  it('moves the cursor in normal mode instead of selecting the word under it (#825)', () => {
    const view = mount()

    press(view, 'd', { ctrlKey: true })
    // Left to the search keymap (Mod is Ctrl in jsdom, as on Linux) this would
    // have selected "one" as {anchor: 0, head: 3}.
    expect(view.state.selection.ranges).toHaveLength(1)
    expect(view.state.selection.main.toJSON()).toEqual({ anchor: 4, head: 4 })

    press(view, 'u', { ctrlKey: true })
    expect(view.state.selection.main.toJSON()).toEqual({ anchor: 0, head: 0 })
  })

  it('grows a visual selection as one range instead of adding cursors (#825)', () => {
    const view = mount()

    press(view, 'v')
    expect(view.state.selection.main.toJSON()).toEqual({ anchor: 0, head: 1 })

    press(view, 'd', { ctrlKey: true })
    expect(view.state.selection.ranges).toHaveLength(1)
    expect(view.state.selection.main.toJSON()).toEqual({ anchor: 0, head: 5 })

    press(view, 'd', { ctrlKey: true })
    expect(view.state.selection.ranges).toHaveLength(1)
    expect(view.state.selection.main.toJSON()).toEqual({ anchor: 0, head: 9 })

    press(view, 'u', { ctrlKey: true })
    expect(view.state.selection.ranges).toHaveLength(1)
    expect(view.state.selection.main.toJSON()).toEqual({ anchor: 0, head: 5 })
  })

  it('takes a count as a number of lines', () => {
    const view = mount()

    press(view, '3')
    press(view, 'd', { ctrlKey: true })
    expect(view.state.selection.main.toJSON()).toEqual({ anchor: 14, head: 14 })

    press(view, '2')
    press(view, 'u', { ctrlKey: true })
    expect(view.state.selection.main.toJSON()).toEqual({ anchor: 4, head: 4 })
  })

  it('leaves insert mode alone', () => {
    const view = mount()

    press(view, 'i')
    press(view, 'd', { ctrlKey: true })
    // Vim's own insert-mode Ctrl+D (unindent) or the search keymap may act on
    // the key, but the half-page motion must not move the cursor off line 1.
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(1)
  })
})
