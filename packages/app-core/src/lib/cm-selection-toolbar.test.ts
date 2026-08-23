// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { getCM, vim } from '@replit/codemirror-vim'
import { shouldShowSelectionToolbar } from './cm-selection-toolbar'

describe('selection toolbar in Vim mode (discussion #597)', () => {
  const views: EditorView[] = []

  afterEach(() => {
    views.splice(0).forEach((view) => view.destroy())
  })

  function mount(): EditorView {
    const view = new EditorView({
      state: EditorState.create({
        doc: 'alpha\nbeta\ngamma',
        extensions: [vim()]
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

  it('keeps the formatting toolbar out of normal and visual-block mode', () => {
    const view = mount()

    expect(shouldShowSelectionToolbar(view, true)).toBe(false)

    press(view, 'v', { ctrlKey: true })
    expect(getCM(view)?.state.vim?.visualBlock).toBe(true)
    expect(shouldShowSelectionToolbar(view, true)).toBe(false)
  })

  it('still offers the toolbar for ordinary and Vim insert-mode selections', () => {
    const view = mount()

    expect(shouldShowSelectionToolbar(view, false)).toBe(true)

    press(view, 'i')
    expect(getCM(view)?.state.vim?.insertMode).toBe(true)
    expect(shouldShowSelectionToolbar(view, true)).toBe(true)
  })
})
