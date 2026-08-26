// @vitest-environment jsdom
//
// `gq` / `gw` driven through a real codemirror-vim: the package ships its own
// `gq` (a hard wrap at textwidth 80), so only pressing the keys proves the
// reflow operator is the one that answers (#676).
import { afterEach, describe, expect, it } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { vim } from '@replit/codemirror-vim'
import { registerReflowOperator } from './cm-vim-reflow'

const DOC = [
  '# Title', // 1
  '', // 2
  'para one line a', // 3
  'para one line b', // 4
  'para one line c', // 5
  '', // 6
  'para two line a', // 7
  'para two line b', // 8
  '', // 9
  '- item that', // 10
  '  wraps', // 11
  '- next item' // 12
].join('\n')

let view: EditorView | null = null

afterEach(() => {
  view?.destroy()
  view = null
})

function mount(cursorLine: number, ch = 0): EditorView {
  registerReflowOperator()
  const state = EditorState.create({ doc: DOC, extensions: [vim(), markdown({ base: markdownLanguage })] })
  const pos = state.doc.line(cursorLine).from + ch
  view = new EditorView({
    state: state.update({ selection: EditorSelection.cursor(pos) }).state,
    parent: document.body
  })
  return view
}

// Motions that need layout (`j`, `k`) cannot run under jsdom, so the ranges
// below are built with `G`, text objects, and visual-line mode instead.
function press(target: EditorView, ...keys: string[]): void {
  for (const key of keys) {
    target.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        shiftKey: /^[A-Z]$/.test(key),
        bubbles: true,
        cancelable: true
      })
    )
  }
}

function lines(target: EditorView): string[] {
  return target.state.doc.toString().split('\n')
}

function cursor(target: EditorView): { line: number; ch: number } {
  const head = target.state.selection.main.head
  const line = target.state.doc.lineAt(head)
  return { line: line.number, ch: head - line.from }
}

describe('gq pressed for real (#676)', () => {
  it('gqip joins the paragraph under the cursor and leaves the rest alone', () => {
    const v = mount(4, 5)
    press(v, 'g', 'q', 'i', 'p')
    expect(lines(v)).toEqual([
      '# Title',
      '',
      'para one line a para one line b para one line c',
      '',
      'para two line a',
      'para two line b',
      '',
      '- item that',
      '  wraps',
      '- next item'
    ])
    // Vim lands on the first formatted line.
    expect(cursor(v)).toEqual({ line: 3, ch: 0 })
  })

  it('gq4G joins only the lines the motion covers, not the whole paragraph', () => {
    const v = mount(3)
    press(v, 'g', 'q', '4', 'G')
    expect(lines(v).slice(2, 5)).toEqual(['para one line a para one line b', 'para one line c', ''])
  })

  it('gw keeps the cursor on the same text', () => {
    const v = mount(4, 5)
    press(v, 'g', 'w', 'i', 'p')
    expect(lines(v)[2]).toBe('para one line a para one line b para one line c')
    // Line 4 col 5 sat on "one" of line b; that word now lives on line 3.
    const { line, ch } = cursor(v)
    expect(line).toBe(3)
    expect(lines(v)[2].slice(ch, ch + 3)).toBe('one')
  })

  it('visual-line gq formats the selection', () => {
    const v = mount(7)
    press(v, 'V', '8', 'G', 'g', 'q')
    expect(lines(v)[6]).toBe('para two line a para two line b')
    expect(lines(v)).toHaveLength(11)
    expect(cursor(v)).toEqual({ line: 7, ch: 0 })
  })

  it('gqgq on a wrapped list item joins nothing past its own line', () => {
    const v = mount(10)
    press(v, 'g', 'q', 'g', 'q')
    // One line only: nothing to join, the item is untouched.
    expect(lines(v)[9]).toBe('- item that')
    expect(lines(v)[10]).toBe('  wraps')
  })

  it('gqip on a wrapped list item joins its continuation, not the next item', () => {
    const v = mount(11)
    press(v, 'g', 'q', 'i', 'p')
    expect(lines(v).slice(9)).toEqual(['- item that wraps', '- next item'])
  })

  it('does not hard-wrap at 80 columns the way the stock gq did', () => {
    const v = mount(3)
    press(v, 'g', 'q', 'i', 'p')
    expect(lines(v)[2].length).toBeGreaterThan(40)
    expect(lines(v)[2]).not.toContain('\n')
  })
})
