// @vitest-environment jsdom
//
// The `]]` / `[[` bindings driven through a real codemirror-vim, rather than
// by calling the motion directly. `]<character>` is a built-in Vim motion, so
// `]]` matches it too, and only pressing the keys for real proves which of the
// two wins (#578).
import { afterEach, describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { vim } from '@replit/codemirror-vim'
import { registerHeadingMotion } from './cm-vim-heading-motion'

const DOC = [
  '# Title', // 1
  '', // 2
  'intro', // 3
  '## Section one', // 4
  'body', // 5
  '```md', // 6
  '# not a heading', // 7
  '```', // 8
  '## Section two', // 9
  'tail' // 10
].join('\n')

let view: EditorView | null = null

afterEach(() => {
  view?.destroy()
  view = null
})

function mount(): EditorView {
  registerHeadingMotion()
  view = new EditorView({
    state: EditorState.create({ doc: DOC, extensions: [vim()] }),
    parent: document.body
  })
  return view
}

function press(target: EditorView, ...keys: string[]): void {
  for (const key of keys) {
    target.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    )
  }
}

function line(target: EditorView): number {
  return target.state.doc.lineAt(target.state.selection.main.head).number
}

describe(']] and [[ pressed for real (#578)', () => {
  it('walks forward to each heading, and skips one inside a code fence', () => {
    const v = mount()
    press(v, ']', ']')
    expect(line(v)).toBe(4)
    press(v, ']', ']')
    // Line 7 is `# not a heading` inside the fence; the next stop is line 9.
    expect(line(v)).toBe(9)
  })

  it('walks back the same way', () => {
    const v = mount()
    press(v, ']', ']', ']', ']')
    expect(line(v)).toBe(9)
    press(v, '[', '[')
    expect(line(v)).toBe(4)
    press(v, '[', '[')
    expect(line(v)).toBe(1)
  })

  it('takes a count', () => {
    const v = mount()
    press(v, '2', ']', ']')
    expect(line(v)).toBe(9)
  })

  it('composes with an operator, so d]] deletes up to the next heading', () => {
    const v = mount()
    press(v, ']', ']') // on `## Section one`
    press(v, 'd', ']', ']')
    // That heading and its body are gone, fenced block included. The blank
    // line left behind is Vim's own rule for an exclusive motion that ends in
    // column one: the end backs up to the end of the previous line, so the
    // newline closing the deleted section survives. Real Vim's `d]]` leaves
    // the same gap.
    expect(v.state.doc.toString()).toBe(
      ['# Title', '', 'intro', '', '## Section two', 'tail'].join('\n')
    )
  })

  it('extends a visual selection', () => {
    const v = mount()
    press(v, 'v', ']', ']')
    expect(v.state.selection.main.empty).toBe(false)
    expect(line(v)).toBe(4)
  })
})
