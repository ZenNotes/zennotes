// @vitest-environment jsdom
//
// The IME guard makes the content DOM non-editable outside insert mode so a
// CJK input method cannot swallow normal-mode keys (#84, #464), driven through
// a real codemirror-vim.
import { afterEach, describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { vim } from '@replit/codemirror-vim'
import { vimImeGuard } from './cm-vim-ime-guard'

// jsdom has no layout. Focusing the editor makes CodeMirror measure on the
// next frame, and without these two methods that measurement throws from a
// deferred callback, which Vitest reports as an unhandled error (it failed CI
// while passing locally by timing luck). Empty geometry is all we need.
const rangeProto = Range.prototype as Range & {
  getClientRects?: () => DOMRectList
  getBoundingClientRect?: () => DOMRect
}
if (typeof rangeProto.getClientRects !== 'function') {
  rangeProto.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList
}
if (typeof rangeProto.getBoundingClientRect !== 'function') {
  rangeProto.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0)
}

let view: EditorView | null = null

afterEach(() => {
  view?.destroy()
  view = null
})

function mount(enabled: () => boolean, withVim = true): EditorView {
  view = new EditorView({
    state: EditorState.create({
      doc: 'first line\nsecond line',
      extensions: [withVim ? vim() : [], vimImeGuard(enabled)]
    }),
    parent: document.body
  })
  return view
}

function press(target: EditorView, key: string): void {
  target.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('vimImeGuard', () => {
  it('is non-editable in normal mode and editable again in insert mode', async () => {
    const v = mount(() => true)
    await flush()
    expect(v.contentDOM.getAttribute('contenteditable')).toBe('false')
    press(v, 'i')
    await flush()
    expect(v.contentDOM.getAttribute('contenteditable')).toBe('true')
    press(v, 'Escape')
    await flush()
    expect(v.contentDOM.getAttribute('contenteditable')).toBe('false')
  })

  it('keeps the content focusable (tabindex) and focused while non-editable', async () => {
    const v = mount(() => true)
    v.focus()
    await flush()
    expect(v.contentDOM.getAttribute('contenteditable')).toBe('false')
    expect(v.contentDOM.getAttribute('tabindex')).toBe('0')
    expect(document.activeElement).toBe(v.contentDOM)
    press(v, 'i')
    await flush()
    expect(document.activeElement).toBe(v.contentDOM)
  })

  it('still lets normal-mode edits and motions through', async () => {
    const v = mount(() => true)
    await flush()
    press(v, 'x')
    expect(v.state.doc.line(1).text).toBe('irst line')
    press(v, 'd')
    press(v, 'd')
    expect(v.state.doc.toString()).toBe('second line')
  })

  it('treats replace mode like insert mode', async () => {
    const v = mount(() => true)
    await flush()
    press(v, 'R')
    await flush()
    expect(v.contentDOM.getAttribute('contenteditable')).toBe('true')
  })

  it('stays editable when the setting is off, and follows the setting at runtime', async () => {
    let on = false
    const v = mount(() => on)
    await flush()
    expect(v.contentDOM.getAttribute('contenteditable')).toBe('true')
    on = true
    press(v, 'l')
    await flush()
    expect(v.contentDOM.getAttribute('contenteditable')).toBe('false')
  })

  it('does nothing without Vim', async () => {
    const v = mount(() => true, false)
    await flush()
    expect(v.contentDOM.getAttribute('contenteditable')).toBe('true')
  })
})
