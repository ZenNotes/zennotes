// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { historyKeymap } from '@codemirror/commands'
import { searchKeymap } from '@codemirror/search'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { CodeMirror, Vim, vim } from '@replit/codemirror-vim'
import type { KeymapOverrides } from './keymaps'
import { keyBindingsFor, vimHalfPageKeymap } from './vim-half-page-keymap'

describe('vimHalfPageKeymap', () => {
  const views: EditorView[] = []
  const mapped: Array<{ binding: string; context: 'normal' | 'visual' }> = []

  afterEach(() => {
    views.splice(0).forEach((view) => view.destroy())
    mapped.splice(0).forEach(({ binding, context }) => Vim.unmap(binding, context))
  })

  function mount(overrides: KeymapOverrides = {}): EditorView {
    // Extension order mirrors EditorPane: a keymap precedes the Vim plugin
    // there (the snippet keymap comes first), so CodeMirror's keymap handler
    // runs before Vim sees the key. Listing vim() first would hand every
    // key to Vim and leave the keymap under test unexercised. Multiple
    // selections are allowed as in the app (cm-vim-visual-highlight), which
    // is what lets the search keymap's Ctrl+D add a range.
    const view = new EditorView({
      state: EditorState.create({
        doc: 'one\ntwo\nthree',
        extensions: [
          EditorState.allowMultipleSelections.of(true),
          keymap.of([
            ...vimHalfPageKeymap(true, overrides),
            ...historyKeymap,
            ...searchKeymap
          ]),
          vim()
        ]
      }),
      parent: document.body
    })
    views.push(view)
    view.focus()
    return view
  }

  function mapAction(binding: string, action: string, callback: () => void): void {
    Vim.defineAction(action, callback)
    Vim.mapCommand(binding, 'action', action, {}, { context: 'normal' })
    mapped.push({ binding, context: 'normal' })
  }

  /** A stand-in for the half-page motion: one logical line in the given direction. */
  function mapVisualMotion(binding: string, motion: string, forward: boolean): void {
    Vim.defineMotion(motion, ((_cm: unknown, head: { line: number; ch: number }) =>
      new CodeMirror.Pos(
        forward ? head.line + 1 : Math.max(0, head.line - 1),
        head.ch
      )) as unknown as Parameters<typeof Vim.defineMotion>[1])
    Vim.mapCommand(binding, 'motion', motion, { forward }, { context: 'visual' })
    mapped.push({ binding, context: 'visual' })
  }

  function press(view: EditorView, key: string, modifiers: KeyboardEventInit): void {
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers })
    )
  }

  it('runs Ctrl+D and Ctrl+U through Vim before search and history keymaps', () => {
    const calls: string[] = []
    mapAction('<C-d>', 'testHalfPageDown', () => calls.push('down'))
    mapAction('<C-u>', 'testHalfPageUp', () => calls.push('up'))
    const view = mount()

    press(view, 'd', { ctrlKey: true })
    press(view, 'u', { ctrlKey: true })

    expect(calls).toEqual(['down', 'up'])
  })

  it('uses configured bindings', () => {
    let calls = 0
    mapAction('<A-u>', 'testRemappedHalfPageDown', () => calls++)
    const view = mount({ 'nav.halfPageDown': 'Alt+U' })

    press(view, 'u', { altKey: true })

    expect(calls).toBe(1)
  })

  it('runs the visual-context mapping in visual mode instead of the search keymap (#825)', () => {
    // jsdom is not a Mac, so Mod is Ctrl and searchKeymap's Mod-d
    // (selectNextOccurrence) competes for the key exactly as on Linux.
    mapVisualMotion('<C-d>', 'testVisualHalfPageDown', true)
    mapVisualMotion('<C-u>', 'testVisualHalfPageUp', false)
    const view = mount()

    press(view, 'v', {})
    expect(view.state.selection.main.toJSON()).toEqual({ anchor: 0, head: 1 })

    press(view, 'd', { ctrlKey: true })
    // The selection grew to the next line's first character (inclusive).
    // Left to the search keymap it would instead have gained a second range.
    expect(view.state.selection.ranges).toHaveLength(1)
    expect(view.state.selection.main.toJSON()).toEqual({ anchor: 0, head: 5 })

    press(view, 'u', { ctrlKey: true })
    expect(view.state.selection.ranges).toHaveLength(1)
    expect(view.state.selection.main.toJSON()).toEqual({ anchor: 0, head: 1 })
  })

  it('defers in insert mode', () => {
    let calls = 0
    mapAction('<C-d>', 'testNormalHalfPageDown', () => calls++)
    const view = mount()

    press(view, 'i', {})
    press(view, 'd', { ctrlKey: true })

    expect(calls).toBe(0)
    expect(vimHalfPageKeymap(false, {})).toEqual([])
  })

  it('binds nothing for an unbound action', () => {
    // An override of "" is a deliberate unbind: the keymap must not carry an
    // empty key name that CodeMirror could match against a keyless keydown.
    expect(vimHalfPageKeymap(true, { 'nav.halfPageDown': '' }).map((b) => b.key)).toEqual([
      'Ctrl-u'
    ])
    expect(keyBindingsFor('', () => true)).toEqual([])
    expect(keyBindingsFor('Mod+L', () => true).map((b) => b.key)).toEqual(['Mod-l'])
  })
})
