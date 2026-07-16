// @vitest-environment jsdom
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { forceParsing } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { Vim, getCM, vim } from '@replit/codemirror-vim'
import { afterEach, describe, expect, it } from 'vitest'
import { mathBlockArrowKeymap } from './cm-math-nav'
import { mathBlockLineRanges, mathRenderExtension } from './cm-math-render'
import { registerDisplayLineMotion } from './cm-vim-display-line'

// The app registers the display-line j/k motion once per renderer
// (Editor.tsx / QuickCaptureApp); mirror that here.
registerDisplayLineMotion()

// 1-based lines: 1 `alpha`, 2 ``, 3 `$$`, 4 `x+1`, 5 `$$`, 6 ``, 7 `omega`.
const DOC = 'alpha\n\n$$\nx+1\n$$\n\nomega'

describe('keyboard navigation into rendered block math', () => {
  const views: EditorView[] = []

  afterEach(() => {
    views.splice(0).forEach((view) => view.destroy())
  })

  function mount(anchor: number, withVim: boolean): EditorView {
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: DOC,
        selection: { anchor },
        extensions: [
          ...(withVim ? [vim()] : []),
          markdown({ base: markdownLanguage }),
          mathRenderExtension,
          keymap.of([...mathBlockArrowKeymap])
        ]
      })
    })
    views.push(view)
    forceParsing(view, DOC.length, 5000)
    // Nudge a rebuild so decorations reflect the fully parsed tree.
    view.dispatch({ changes: { from: DOC.length, insert: ' ' } })
    view.dispatch({ changes: { from: DOC.length, to: DOC.length + 1 } })
    view.focus()
    return view
  }

  function headLine(view: EditorView): number {
    return view.state.doc.lineAt(view.state.selection.main.head).number
  }

  function blockWidgets(view: EditorView): number {
    return view.dom.querySelectorAll('.cm-math-block').length
  }

  function pressVim(view: EditorView, key: string): void {
    const cm = getCM(view)
    expect(cm).toBeTruthy()
    Vim.handleKey(cm!, key, 'user')
  }

  it('reports the block line ranges (and none for currency)', () => {
    const view = mount(0, false)
    expect(mathBlockLineRanges(view.state)).toEqual([{ fromLine: 3, toLine: 5 }])

    const plain = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: 'I paid $5 and got $10 back.',
        extensions: [markdown({ base: markdownLanguage }), mathRenderExtension]
      })
    })
    views.push(plain)
    expect(mathBlockLineRanges(plain.state)).toEqual([])
  })

  it('vim j steps from the line above into the rendered block and reveals it', () => {
    const view = mount(6, true) // line 2 (blank above the block)
    expect(blockWidgets(view)).toBe(1)

    pressVim(view, 'j')
    expect(headLine(view)).toBe(3) // opening $$
    expect(blockWidgets(view)).toBe(0) // revealed
  })

  it('vim k steps from the line below into the rendered block and reveals it', () => {
    const view = mount(17, true) // line 6 (blank below the block)
    expect(blockWidgets(view)).toBe(1)

    pressVim(view, 'k')
    expect(headLine(view)).toBe(5) // closing $$
    expect(blockWidgets(view)).toBe(0)
  })

  it('an explicit count (3j) still lands logically inside the block', () => {
    const view = mount(6, true) // line 2
    pressVim(view, '3')
    pressVim(view, 'j')
    expect(headLine(view)).toBe(5)
    expect(blockWidgets(view)).toBe(0)
  })

  it('re-renders the block once the cursor leaves it', () => {
    const view = mount(6, true)
    pressVim(view, 'j')
    expect(blockWidgets(view)).toBe(0)

    view.dispatch({ selection: { anchor: 0 } }) // back to line 1
    expect(blockWidgets(view)).toBe(1)
  })

  it('ArrowDown/ArrowUp step into the rendered block outside vim', () => {
    const down = mount(6, false) // line 2
    down.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    )
    expect(headLine(down)).toBe(3)
    expect(blockWidgets(down)).toBe(0)

    const up = mount(17, false) // line 6
    up.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })
    )
    expect(headLine(up)).toBe(5)
    expect(blockWidgets(up)).toBe(0)
  })
})
