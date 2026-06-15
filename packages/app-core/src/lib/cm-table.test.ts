// @vitest-environment jsdom

import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { forceParsing } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { tablePlugin, nextWordStart, prevWordStart, nextWordEnd } from './cm-table'
import { closeTableContextMenu } from './cm-table-menu'

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
      extensions: [markdown({ base: markdownLanguage }), tablePlugin]
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
