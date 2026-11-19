// @vitest-environment jsdom
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { Vim, getCM, vim } from '@replit/codemirror-vim'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { bidiExtension, lineIsRtl, registerVisualCharMotion } from './cm-bidi'

describe('lineIsRtl', () => {
  it.each([
    ['مرحبا بالعالم', true],
    ['שלום עולם', true],
    ['Hello world', false],
    ['', false],
    ['123 שלום', true],
    ['Hello مرحبا', false],
    ['مرحبا Hello', true],
    ['**مرحبا**', true],
    ['# عنوان', true],
    ['## Title عنوان', false],
    ['> اقتباس', true],
    ['- عنصر', true],
    ['1. خطوة', true],
    ['- [x] مهمة', true],
    ['- [ ] task', false],
    ['- [x]', false],
    ['‏abc', true],
    ['‎مرحبا', false]
  ])('%j reads right to left: %s', (text, rtl) => {
    expect(lineIsRtl(text)).toBe(rtl)
  })
})

const views: EditorView[] = []

afterEach(() => {
  views.splice(0).forEach((view) => view.destroy())
})

function editor(doc: string, cursor = 0, withVim = false): EditorView {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(cursor),
      extensions: [...(withVim ? [vim()] : []), bidiExtension]
    })
  })
  views.push(view)
  return view
}

describe('bidiExtension', () => {
  it('marks right-to-left lines with dir="rtl" and leaves the others alone', () => {
    const view = editor('Hello\nمرحبا\n- [x] مهمة\n- [ ] task\nשלום')
    const dirs = [...view.contentDOM.querySelectorAll('.cm-line')].map((line) =>
      line.getAttribute('dir')
    )
    expect(dirs).toEqual([null, 'rtl', 'rtl', null, 'rtl'])
  })

  it('follows edits', () => {
    const view = editor('Hello')
    view.dispatch({ changes: { from: 0, to: 5, insert: 'مرحبا' } })
    expect(view.contentDOM.querySelector('.cm-line')?.getAttribute('dir')).toBe('rtl')
  })
})

describe('registerVisualCharMotion', () => {
  beforeAll(() => {
    registerVisualCharMotion()
    registerVisualCharMotion() // idempotent
  })

  function press(view: EditorView, keys: string[]): void {
    const cm = getCM(view)!
    for (const key of keys) Vim.handleKey(cm, key, 'user')
  }

  it('keeps h/l logical in a left-to-right line', () => {
    const view = editor('abcdef', 2, true)
    press(view, ['l'])
    expect(view.state.selection.main.head).toBe(3)
    press(view, ['h', 'h'])
    expect(view.state.selection.main.head).toBe(1)
  })

  it('moves by what is on screen in a right-to-left line', () => {
    const view = editor('אבגדהו', 2, true)
    press(view, ['l'])
    expect(view.state.selection.main.head).toBe(1)
    press(view, ['h', 'h'])
    expect(view.state.selection.main.head).toBe(3)
  })

  it('takes a count and drives <Left>/<Right>', () => {
    const view = editor('أبجدهوز', 5, true)
    press(view, ['2', 'l'])
    expect(view.state.selection.main.head).toBe(3)
    press(view, ['<Left>'])
    expect(view.state.selection.main.head).toBe(4)
    press(view, ['<Right>'])
    expect(view.state.selection.main.head).toBe(3)
  })

  it('decides per line', () => {
    const view = editor('abc\nאבג', 1, true)
    press(view, ['l'])
    expect(view.state.selection.main.head).toBe(2)
    const second = view.state.doc.line(2).from
    view.dispatch({ selection: EditorSelection.cursor(second + 1) })
    press(view, ['l'])
    expect(view.state.selection.main.head).toBe(second)
  })

  it('deletes toward the visual right with dl in a right-to-left line', () => {
    const view = editor('אבג', 1, true)
    press(view, ['d', 'l'])
    expect(view.state.doc.toString()).toBe('בג')
  })
})
