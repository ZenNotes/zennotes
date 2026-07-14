// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { historyKeymap } from '@codemirror/commands'
import { searchKeymap } from '@codemirror/search'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { Vim, vim } from '@replit/codemirror-vim'
import type { KeymapOverrides } from './keymaps'
import { vimHalfPageKeymap } from './vim-half-page-keymap'

describe('vimHalfPageKeymap', () => {
  const views: EditorView[] = []
  const mapped: string[] = []

  afterEach(() => {
    views.splice(0).forEach((view) => view.destroy())
    mapped.splice(0).forEach((binding) => Vim.unmap(binding, 'normal'))
  })

  function mount(overrides: KeymapOverrides = {}): EditorView {
    const view = new EditorView({
      state: EditorState.create({
        doc: 'one\ntwo\nthree',
        extensions: [
          vim(),
          keymap.of([
            ...vimHalfPageKeymap(true, overrides),
            ...historyKeymap,
            ...searchKeymap
          ])
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
    mapped.push(binding)
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

  it('defers outside Vim normal mode', () => {
    let calls = 0
    mapAction('<C-d>', 'testNormalHalfPageDown', () => calls++)
    const view = mount()

    press(view, 'i', {})
    press(view, 'd', { ctrlKey: true })

    expect(calls).toBe(0)
    expect(vimHalfPageKeymap(false, {})).toEqual([])
  })
})
