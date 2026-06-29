// @vitest-environment jsdom

import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { forceParsing } from '@codemirror/language'
import { history } from '@codemirror/commands'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import {
  tablePlugin,
  nextWordStart,
  prevWordStart,
  nextWordEnd,
  textObjectRange
} from './cm-table'
import { closeTableContextMenu } from './cm-table-menu'
import { useStore } from '../store'

const TABLE_DOC = `Intro text.

| Name | Age |
| --- | --- |
| Alice | 30 |
| Bob | 25 |

Outro text.`

function mount(doc: string): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage }), history(), tablePlugin]
    })
  })
  // Ensure the GFM table node is parsed, then nudge the field to rebuild.
  forceParsing(view, doc.length, 5000)
  view.dispatch({ changes: { from: 0, insert: ' ' } })
  view.dispatch({ changes: { from: 0, to: 1 } })
  return view
}

describe('tablePlugin', () => {
  it('renders a GFM table as an editable table widget without throwing', () => {
    const view = mount(TABLE_DOC)
    const widget = view.dom.querySelector('.cm-table-widget')
    expect(widget).toBeTruthy()
    const cells = widget?.querySelectorAll('.cm-table-cell') ?? []
    // 2 header + 4 body cells.
    expect(cells.length).toBe(6)
    expect(view.dom.textContent).toContain('Alice')
    expect(view.dom.textContent).toContain('Age')
    // One row grip per body row (2), one column grip per column (2).
    expect(widget?.querySelectorAll('.cm-table-row-handle').length).toBe(2)
    expect(widget?.querySelectorAll('.cm-table-col-handle').length).toBe(2)
    view.destroy()
  })

  it('renders a plain doc with no table widget', () => {
    const view = mount('Just a paragraph, no table here.')
    expect(view.dom.querySelector('.cm-table-widget')).toBeNull()
    view.destroy()
  })

  // Vim mode defaults on (DEFAULT_PREFS.vimMode), so cells start in NORMAL mode.
  it('swallows vim normal-mode motion/printable keys inside a cell', () => {
    const view = mount(TABLE_DOC)
    const cell = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="0"][data-col="0"]'
    )!
    // h/j/k/l are consumed as motions, not typed.
    for (const key of ['h', 'j', 'k', 'l']) {
      const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      cell.dispatchEvent(ev)
      expect(ev.defaultPrevented).toBe(true)
    }
    // A stray printable key is swallowed too (won't corrupt the cell text).
    const xEv = new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true })
    cell.dispatchEvent(xEv)
    expect(xEv.defaultPrevented).toBe(true)
    view.destroy()
  })

  // #232: arrow keys used to fall through to CodeMirror and scroll the page;
  // they should navigate the cell like h/j/k/l (consumed, not propagated).
  it('consumes arrow keys inside a cell instead of scrolling the page (#232)', () => {
    const view = mount(TABLE_DOC)
    const cell = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="0"][data-col="0"]'
    )!
    for (const key of ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight']) {
      const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      cell.dispatchEvent(ev)
      expect(ev.defaultPrevented).toBe(true)
    }
    view.destroy()
  })

  // #213: directional cell navigation honors the configurable nav keymaps.
  it('honors a remapped nav key (nav.moveDown → n) inside a cell', () => {
    const view = mount(TABLE_DOC)
    const prev = useStore.getState().keymapOverrides
    useStore.setState({ keymapOverrides: { ...prev, 'nav.moveDown': 'n' } })
    try {
      const start = view.dom.querySelector<HTMLElement>(
        '.cm-table-widget [data-row="0"][data-col="0"]'
      )!
      start.focus()
      const ev = new KeyboardEvent('keydown', { key: 'n', bubbles: true, cancelable: true })
      start.dispatchEvent(ev)
      expect(ev.defaultPrevented).toBe(true)
      // The remapped key moved the focus down a row, like `j` would by default.
      const below = view.dom.querySelector('.cm-table-widget [data-row="1"][data-col="0"]')
      expect(document.activeElement).toBe(below)
    } finally {
      useStore.setState({ keymapOverrides: prev })
    }
    view.destroy()
  })

  it('enters insert mode on `i`, revealing the raw cell source', () => {
    const view = mount(TABLE_DOC)
    const cell = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="0"][data-col="0"]'
    )!
    expect(cell.dataset.rendered).toBe('true')
    // NORMAL cells are non-editable (no caret); editing turns it on.
    expect(cell.getAttribute('contenteditable')).toBe('false')
    const iEv = new KeyboardEvent('keydown', { key: 'i', bubbles: true, cancelable: true })
    cell.dispatchEvent(iEv)
    expect(iEv.defaultPrevented).toBe(true)
    // Now editing: cell is editable, shows raw markdown, accepts typed chars.
    expect(cell.getAttribute('contenteditable')).toBe('true')
    expect(cell.dataset.rendered).toBe('false')
    const xEv = new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true })
    cell.dispatchEvent(xEv)
    expect(xEv.defaultPrevented).toBe(false)
    view.destroy()
  })

  it('opens the keyboard-navigable action menu on `m`', () => {
    const view = mount(TABLE_DOC)
    const cell = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="0"][data-col="0"]'
    )!
    const mEv = new KeyboardEvent('keydown', { key: 'm', bubbles: true, cancelable: true })
    cell.dispatchEvent(mEv)
    expect(mEv.defaultPrevented).toBe(true)
    const menu = document.querySelector('.cm-table-menu')
    expect(menu).toBeTruthy()
    // The full Obsidian-style action set (add/move/dup/delete/align/sort).
    expect(menu!.querySelectorAll('.cm-table-menu-item').length).toBeGreaterThan(10)
    closeTableContextMenu()
    view.destroy()
  })

  it('supports x / dd / D editing operators in a cell', () => {
    const view = mount(TABLE_DOC)
    const cell = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="0"][data-col="0"]'
    )!
    expect(cell.dataset.raw).toBe('Alice')
    // x deletes the char under the cursor (offset 0).
    cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }))
    expect(cell.dataset.raw).toBe('lice')
    // D deletes to end of cell.
    cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'D', bubbles: true, cancelable: true }))
    expect(cell.dataset.raw).toBe('')
    view.destroy()
  })

  it('supports char-wise visual mode: v + motion + d deletes the selection', () => {
    const view = mount(TABLE_DOC)
    const cell = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="0"][data-col="0"]'
    )!
    expect(cell.dataset.raw).toBe('Alice')
    // v (anchor at 0) → l (extend to 1) → d (delete [0,2) = "Al").
    cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', bubbles: true, cancelable: true }))
    cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true, cancelable: true }))
    cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true, cancelable: true }))
    expect(cell.dataset.raw).toBe('ice')
    view.destroy()
  })

  it('u commits the pending cell edit and undoes it', () => {
    const view = mount(TABLE_DOC)
    const cell = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="0"][data-col="0"]'
    )!
    cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }))
    expect(cell.dataset.raw).toBe('lice')
    cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'u', bubbles: true, cancelable: true }))
    // The committed edit is undone — the source table is back to "Alice".
    expect(view.state.doc.toString()).toContain('| Alice |')
    view.destroy()
  })

  it('diw deletes the inner word (operator + text object)', () => {
    const view = mount(TABLE_DOC)
    const cell = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="0"][data-col="0"]'
    )!
    expect(cell.dataset.raw).toBe('Alice')
    for (const key of ['d', 'i', 'w']) {
      cell.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    }
    expect(cell.dataset.raw).toBe('')
    view.destroy()
  })

  it('Esc in a normal-mode cell is a no-op (stays put, no jump below)', () => {
    const view = mount(TABLE_DOC)
    const cell = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="0"][data-col="0"]'
    )!
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    cell.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    // Cell content untouched; widget still present (didn't tear down / jump out).
    expect(cell.dataset.raw).toBe('Alice')
    expect(view.dom.querySelector('.cm-table-widget')).toBeTruthy()
    view.destroy()
  })

  it('supports the dd operator (clear cell) via operator-pending', () => {
    const view = mount(TABLE_DOC)
    const cell = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="1"][data-col="0"]'
    )!
    expect(cell.dataset.raw).toBe('Bob')
    cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true, cancelable: true }))
    cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true, cancelable: true }))
    expect(cell.dataset.raw).toBe('')
    view.destroy()
  })
})

describe('vim word motions (cell cursor)', () => {
  const t = 'foo bar baz'
  it('w moves to the next word start', () => {
    expect(nextWordStart(t, 0)).toBe(4)
    expect(nextWordStart(t, 4)).toBe(8)
    expect(nextWordStart(t, 8)).toBe(t.length - 1) // clamps at the last word
  })
  it('b moves to the previous word start', () => {
    expect(prevWordStart(t, 8)).toBe(4)
    expect(prevWordStart(t, 4)).toBe(0)
    expect(prevWordStart(t, 0)).toBe(0)
  })
  it('e moves to the next word end', () => {
    expect(nextWordEnd(t, 0)).toBe(2)
    expect(nextWordEnd(t, 2)).toBe(6)
  })
  it('treats punctuation as its own word', () => {
    // "a, b" → a(0) ,(1) space(2) b(3)
    expect(nextWordStart('a, b', 0)).toBe(1) // 'a' → ','
    expect(nextWordStart('a, b', 1)).toBe(3) // ',' → 'b'
  })
})

describe('text objects (vi / va, di / ca)', () => {
  it('iw / aw select the word (a includes trailing space)', () => {
    const t = 'foo bar baz'
    expect(textObjectRange(t, 5, 'i', 'w')).toEqual({ from: 4, to: 7 }) // "bar"
    expect(textObjectRange(t, 5, 'a', 'w')).toEqual({ from: 4, to: 8 }) // "bar "
  })
  it('i" / a" select inside / around quotes', () => {
    const t = 'say "hi" now'
    expect(textObjectRange(t, 5, 'i', '"')).toEqual({ from: 5, to: 7 }) // hi
    expect(textObjectRange(t, 5, 'a', '"')).toEqual({ from: 4, to: 8 }) // "hi"
  })
  it('i( / a) select inside / around brackets', () => {
    const t = 'f(x, y)'
    expect(textObjectRange(t, 3, 'i', '(')).toEqual({ from: 2, to: 6 }) // x, y
    expect(textObjectRange(t, 3, 'a', ')')).toEqual({ from: 1, to: 7 }) // (x, y)
  })
  it('returns null when the object is absent', () => {
    expect(textObjectRange('plain', 0, 'i', '"')).toBeNull()
  })
})
