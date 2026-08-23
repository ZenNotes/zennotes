// @vitest-environment jsdom

import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { forceParsing } from '@codemirror/language'
import { history } from '@codemirror/commands'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Text } from '@codemirror/state'
import {
  renderInlineCell,
  tableBlockAt,
  tablePlugin,
  nextWordStart,
  prevWordStart,
  nextWordEnd,
  textObjectRange,
  findChar
} from './cm-table'
import { closeTableContextMenu } from './cm-table-menu'
import { isMacPlatform } from './keymaps'
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

function selectCellText(cell: HTMLElement): void {
  const range = document.createRange()
  range.selectNodeContents(cell)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

const modKey = isMacPlatform() ? { metaKey: true } : { ctrlKey: true }

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

  it('toggles bold Markdown around selected text in an editable cell (#664)', () => {
    const view = mount(TABLE_DOC)
    const cell = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="0"][data-col="0"]'
    )!
    cell.focus()
    cell.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'i', bubbles: true, cancelable: true })
    )
    selectCellText(cell)

    const bold = (): KeyboardEvent =>
      new KeyboardEvent('keydown', {
        key: 'b',
        code: 'KeyB',
        ...modKey,
        bubbles: true,
        cancelable: true
      })
    const apply = bold()
    cell.dispatchEvent(apply)
    expect(apply.defaultPrevented).toBe(true)
    expect(cell.dataset.raw).toBe('**Alice**')
    expect(window.getSelection()?.toString()).toBe('Alice')

    const remove = bold()
    cell.dispatchEvent(remove)
    expect(remove.defaultPrevented).toBe(true)
    expect(cell.dataset.raw).toBe('Alice')
    expect(window.getSelection()?.toString()).toBe('Alice')
    view.destroy()
  })

  it('wraps selected text in italic Markdown in an editable cell (#664)', () => {
    const view = mount(TABLE_DOC)
    const cell = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="1"][data-col="0"]'
    )!
    cell.focus()
    cell.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'i', bubbles: true, cancelable: true })
    )
    selectCellText(cell)

    const italic = new KeyboardEvent('keydown', {
      key: 'i',
      code: 'KeyI',
      ...modKey,
      bubbles: true,
      cancelable: true
    })
    cell.dispatchEvent(italic)
    expect(italic.defaultPrevented).toBe(true)
    expect(cell.dataset.raw).toBe('*Bob*')
    expect(window.getSelection()?.toString()).toBe('Bob')

    view.focus()
    expect(view.state.doc.toString()).toMatch(/\| \*Bob\* \| 25\s+\|/)
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

  it('keeps char-wise visual mode when `l` crosses into the next cell (#665)', () => {
    const view = mount(TABLE_DOC)
    const name = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="0"][data-col="0"]'
    )!
    const age = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="0"][data-col="1"]'
    )!
    name.focus()

    for (const key of ['v', '$', 'l']) {
      ;(document.activeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      )
    }

    expect(document.activeElement).toBe(age)
    expect(name.classList.contains('is-vim-visual')).toBe(true)
    expect(age.classList.contains('is-vim-visual')).toBe(true)

    age.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true, cancelable: true }))
    expect(name.dataset.raw).toBe('')
    expect(age.dataset.raw).toBe('0')
    view.destroy()
  })

  it('extends char-wise visual mode through intervening cells with `j` (#665)', () => {
    const view = mount(TABLE_DOC)
    const alice = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="0"][data-col="0"]'
    )!
    const bob = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="1"][data-col="0"]'
    )!
    alice.focus()
    alice.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', bubbles: true, cancelable: true }))
    alice.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true }))

    expect(document.activeElement).toBe(bob)
    expect(view.dom.querySelectorAll('.cm-table-cell.is-vim-visual')).toHaveLength(3)
    view.destroy()
  })

  it('continues visual `w` at the start of the next cell (#665)', () => {
    const view = mount(TABLE_DOC)
    const alice = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="0"][data-col="0"]'
    )!
    const age = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="0"][data-col="1"]'
    )!
    alice.focus()
    alice.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', bubbles: true, cancelable: true }))
    alice.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', bubbles: true, cancelable: true }))

    expect(document.activeElement).toBe(age)
    expect(view.dom.querySelectorAll('.cm-table-cell.is-vim-visual')).toHaveLength(2)
    view.destroy()
  })

  it('uses `V` to select complete table rows (#665)', () => {
    const view = mount(TABLE_DOC)
    const age = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="0"][data-col="1"]'
    )!
    const lastCell = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="1"][data-col="1"]'
    )!
    age.focus()
    age.dispatchEvent(new KeyboardEvent('keydown', { key: 'V', bubbles: true, cancelable: true }))
    age.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true }))

    expect(document.activeElement).toBe(lastCell)
    const selected = Array.from(
      view.dom.querySelectorAll<HTMLElement>('.cm-table-cell.is-vim-visual')
    )
    expect(selected).toHaveLength(4)
    expect(selected.map((cell) => cell.dataset.raw)).toEqual(['Alice', '30', 'Bob', '25'])
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

describe('vim find-char (f / t / F / T, cell cursor)', () => {
  const t = 'Engineer' // E n g i n e e r  (indices 0..7)
  it('f finds the next occurrence forward', () => {
    expect(findChar(t, 0, 'n', 1, false)).toBe(1)
    expect(findChar(t, 1, 'n', 1, false)).toBe(4) // skips the current char
    expect(findChar(t, 0, 'r', 1, false)).toBe(7)
  })
  it('t stops one char before the target (forward)', () => {
    expect(findChar(t, 0, 'e', 1, true)).toBe(4) // 'e' at 5 → 4
  })
  it('F finds the next occurrence backward', () => {
    expect(findChar(t, 7, 'n', -1, false)).toBe(4)
    expect(findChar(t, 7, 'E', -1, false)).toBe(0)
  })
  it('T stops one char after the target (backward)', () => {
    expect(findChar(t, 7, 'g', -1, true)).toBe(3) // 'g' at 2 → 3
  })
  it('returns null when the char is not found', () => {
    expect(findChar(t, 0, 'z', 1, false)).toBeNull()
    expect(findChar(t, 7, 'z', -1, false)).toBeNull()
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

describe('tablePlugin — column widths (#294)', () => {
  const WIDTH_DOC = `Intro.

| Name | Age |
| --- | --- |
| Alice | 30 |
<!-- zen:cols=120,200 -->`

  const PLAIN_DOC = `Intro.

| A | B |
| --- | --- |
| 1 | 2 |`

  it('renders persisted widths as a <colgroup> and swallows the marker', () => {
    const view = mount(WIDTH_DOC)
    const widget = view.dom.querySelector('.cm-table-widget')!
    expect(widget).toBeTruthy()
    const cols = widget.querySelectorAll('col')
    expect(cols.length).toBe(2)
    expect((cols[0] as HTMLElement).style.width).toBe('120px')
    expect((cols[1] as HTMLElement).style.width).toBe('200px')
    expect(widget.querySelector('table')?.classList.contains('cm-table-fixed')).toBe(true)
    // The raw marker is inside the widget's atomic range — never visible text.
    expect(view.dom.textContent ?? '').not.toContain('zen:cols')
    view.destroy()
  })

  it('a table with no marker renders a colgroup but no fixed widths', () => {
    const view = mount(PLAIN_DOC)
    const widget = view.dom.querySelector('.cm-table-widget')!
    const cols = widget.querySelectorAll('col')
    expect(cols.length).toBe(2)
    expect((cols[0] as HTMLElement).style.width).toBe('')
    expect(widget.querySelector('table')?.classList.contains('cm-table-fixed')).toBe(false)
    view.destroy()
  })

  const drag = (view: EditorView, from: number, to: number): void => {
    const handle = view.dom.querySelector<HTMLElement>('.cm-table-col-resize')
    if (!handle) throw new Error('no resize handle')
    handle.dispatchEvent(new MouseEvent('pointerdown', { clientX: from, bubbles: true, cancelable: true }))
    handle.dispatchEvent(new MouseEvent('pointermove', { clientX: to, bubbles: true }))
    handle.dispatchEvent(new MouseEvent('pointerup', { clientX: to, bubbles: true }))
  }

  it('dragging a column resize grip persists a zen:cols marker in the source', () => {
    const view = mount(PLAIN_DOC)
    drag(view, 100, 180)
    expect(view.state.doc.toString()).toContain('<!-- zen:cols=')
    view.destroy()
  })

  it('re-resizing replaces the marker — never duplicates it', () => {
    const view = mount(PLAIN_DOC)
    drag(view, 100, 180)
    drag(view, 100, 140)
    const markers = view.state.doc.toString().match(/zen:cols/g) ?? []
    expect(markers.length).toBe(1)
    view.destroy()
  })
})

describe('table cell link following (#445)', () => {
  const saved = {
    notes: useStore.getState().notes,
    selectNote: useStore.getState().selectNote,
    selectedPath: useStore.getState().selectedPath,
    vimMode: useStore.getState().vimMode
  }
  afterEach(() => {
    useStore.setState(saved)
    vi.restoreAllMocks()
  })

  function setup(vimMode: boolean): ReturnType<typeof vi.fn> {
    const selectNote = vi.fn(async () => {})
    useStore.setState({
      vimMode,
      selectedPath: 'Doc.md',
      // Minimal note refs the resolvers need (title + folder + path).
      notes: [{ path: 'Target-Note.md', title: 'Target-Note', folder: 'inbox' }],
      selectNote
    } as never)
    return selectNote
  }

  const WIKILINK_DOC = '| A | B |\n| --- | --- |\n| x | [[Target-Note]] |'
  const MDLINK_DOC = '| A | B |\n| --- | --- |\n| x | [go](Target-Note.md) |'

  it('follows a [[wikilink]] in a cell on plain click instead of revealing raw source', () => {
    const selectNote = setup(false)
    const view = mount(WIKILINK_DOC)
    const anchor = view.dom.querySelector<HTMLAnchorElement>('.cm-table-cell a.wikilink')
    expect(anchor).toBeTruthy()
    expect(anchor?.dataset.wikilink).toBe('Target-Note')
    anchor?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    expect(selectNote).toHaveBeenCalledWith('Target-Note.md')
    view.destroy()
  })

  it('follows a [text](Note.md) link in a cell on Cmd/Ctrl-click', () => {
    const selectNote = setup(false)
    const view = mount(MDLINK_DOC)
    const anchor = view.dom.querySelector<HTMLAnchorElement>('.cm-table-cell a[href="Target-Note.md"]')
    expect(anchor).toBeTruthy()
    anchor?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, metaKey: true }))
    expect(selectNote).toHaveBeenCalledWith('Target-Note.md')
    view.destroy()
  })

  it('follows the link under the cursor on `gd` in a cell (Vim)', () => {
    const selectNote = setup(true)
    const view = mount(WIKILINK_DOC)
    const cell = [...view.dom.querySelectorAll<HTMLElement>('.cm-table-cell')].find(
      (c) => c.dataset.raw === '[[Target-Note]]'
    )
    expect(cell).toBeTruthy()
    cell?.focus() // Vim: enter NORMAL mode in the cell (cursor at offset 0)
    cell?.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true }))
    cell?.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }))
    expect(selectNote).toHaveBeenCalledWith('Target-Note.md')
    view.destroy()
  })
})

describe('tableBlockAt — the fallback when the parse has not caught up (#485)', () => {
  const doc = (text: string) => Text.of(text.split('\n'))

  it('finds the table around a position, header row to last row', () => {
    const text = 'intro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nafter'
    const t = doc(text)
    const inside = text.indexOf('| 1 | 2 |') + 2
    const range = tableBlockAt(t, inside)
    expect(range).not.toBeNull()
    expect(text.slice(range!.from, range!.to)).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |')
  })

  it('takes the trailing zen:cols marker with it, like the tree path does', () => {
    const text = '| A | B |\n| --- | --- |\n| 1 | 2 |\n<!-- zen:cols=273,227 -->\ntail'
    const t = doc(text)
    const range = tableBlockAt(t, 3)
    expect(text.slice(range!.from, range!.to)).toContain('zen:cols=273,227')
  })

  it('refuses a lone pipe line — that is prose, not a table', () => {
    const t = doc('a | b is not a table\n| stray |\nplain')
    expect(tableBlockAt(t, t.line(2).from + 2)).toBeNull()
  })

  it('returns null off the table', () => {
    const t = doc('prose here\n\n| A |\n| --- |')
    expect(tableBlockAt(t, 2)).toBeNull()
  })

  it('handles a table at the very start and end of the document', () => {
    const text = '| A | B |\n| --- | --- |'
    const t = doc(text)
    const range = tableBlockAt(t, 0)
    expect(range).toEqual({ from: 0, to: text.length })
  })
})

describe('renderInlineCell', () => {
  // A cell is inline content, so a leading block marker is just a character.
  // These all rendered as empty blocks before, losing the text outright. (#559)
  it('keeps a cell that is only a list marker visible', () => {
    expect(renderInlineCell('-')).toBe('-')
    expect(renderInlineCell('+')).toBe('+')
    expect(renderInlineCell('*')).toBe('*')
  })

  it('keeps the other block markers literal too', () => {
    expect(renderInlineCell('#')).toBe('#')
    expect(renderInlineCell('1.')).toBe('1.')
    expect(renderInlineCell('---')).toBe('---')
    expect(renderInlineCell('# H')).toBe('# H')
    expect(renderInlineCell('- x')).toBe('- x')
    expect(renderInlineCell('> q')).toBe('&gt; q')
  })

  it('still renders inline markup', () => {
    expect(renderInlineCell('**b**')).toBe('<strong>b</strong>')
    expect(renderInlineCell('`c`')).toBe('<code>c</code>')
    expect(renderInlineCell('[[note]]')).toContain('class="wikilink"')
    expect(renderInlineCell('#tag')).toContain('class="hashtag"')
  })

  it('renders a literal pipe rather than splitting the synthetic row', () => {
    expect(renderInlineCell('a | b')).toBe('a | b')
  })

  it('renders nothing for an empty cell', () => {
    expect(renderInlineCell('')).toBe('')
    expect(renderInlineCell('   ')).toBe('')
  })

  it('flattens a pasted newline instead of breaking out of the cell', () => {
    expect(renderInlineCell('a\nb')).toBe('a b')
  })
})
