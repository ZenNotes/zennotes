// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import {
  anchorSidebarCursor,
  findSidebarCursorRow,
  sidebarCursorFallbackInDom,
  sidebarCursorNeighbors,
  sidebarRowIdentity
} from './sidebar-cursor'

type Attrs = Record<string, string>

const noteKey = (path: string): string => `note:${encodeURIComponent(path)}`
const folderKey = (subpath: string): string => `folder:inbox:${encodeURIComponent(subpath)}`

/** A tree note row, with the attributes NoteLeaf (and its placeholder) carry. */
const note = (idx: number, path: string): [number, Attrs] => [
  idx,
  { 'data-sidebar-type': 'note', 'data-sidebar-path': path, 'data-sidebar-select-key': noteKey(path) }
]
/** A tree folder row, with the attributes the folder row carries. */
const folder = (idx: number, subpath: string): [number, Attrs] => [
  idx,
  {
    'data-sidebar-type': 'folder',
    'data-sidebar-folder': 'inbox',
    'data-sidebar-subpath': subpath,
    'data-sidebar-key': `inbox:${subpath}`,
    'data-sidebar-expandable': 'false',
    'data-sidebar-collapsed': 'true',
    'data-sidebar-select-key': folderKey(subpath)
  }
]
const plain = (idx: number, type: string): [number, Attrs] => [idx, { 'data-sidebar-type': type }]

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/** Rows in display (document) order, each with the number Sidebar gave it.
 *  jsdom lays nothing out, so every row says it is on screen unless hidden. */
function renderRows(rows: Array<[number, Attrs]>, hidden: number[] = []): void {
  document.body.innerHTML = rows
    .map(([idx, attrs]) => {
      const rendered = Object.entries(attrs)
        .map(([name, value]) => `${name}="${escapeHtml(value)}"`)
        .join(' ')
      return `<button data-sidebar-idx="${idx}" ${rendered}></button>`
    })
    .join('')
  document.querySelectorAll<HTMLElement>('[data-sidebar-idx]').forEach((el) => {
    const idx = Number(el.dataset.sidebarIdx)
    el.getClientRects = (() =>
      (hidden.includes(idx) ? [] : [{ width: 200, height: 24 }]) as unknown as DOMRectList) as never
  })
}

const pathAt = (idx: number): string | null =>
  document.querySelector(`[data-sidebar-idx="${idx}"]`)?.getAttribute('data-sidebar-path') ??
  document.querySelector(`[data-sidebar-idx="${idx}"]`)?.getAttribute('data-sidebar-subpath') ??
  null

beforeEach(() => {
  document.body.innerHTML = ''
})

// The measured repro: a folder numbers its notes before the subfolders it
// shows above them, so a note written from outside the app renumbers rows
// the cursor sits on, and the cursor used to stay on the number.
describe('keeping the sidebar cursor on its row', () => {
  const before: Array<[number, Attrs]> = [
    plain(0, 'vault'),
    folder(9, ''),
    folder(12, 'Areas'),
    folder(13, 'Projects'),
    folder(14, 'Reading'),
    note(10, 'inbox/Another.md'),
    note(11, 'inbox/Open note.md'),
    plain(15, 'archive')
  ]
  const afterOutsideWrite: Array<[number, Attrs]> = [
    plain(0, 'vault'),
    folder(9, ''),
    folder(13, 'Areas'),
    folder(14, 'Projects'),
    folder(15, 'Reading'),
    note(10, 'inbox/Another.md'),
    note(11, 'inbox/Churn.md'),
    note(12, 'inbox/Open note.md'),
    plain(16, 'archive')
  ]

  it('follows its row to the new number after an outside write renumbers it', () => {
    renderRows(before)
    const anchor = anchorSidebarCursor(document, 12)
    expect(anchor).not.toBeNull()
    renderRows(afterOutsideWrite)
    // The old number now names another row; the anchor still finds Areas.
    expect(pathAt(12)).toBe('inbox/Open note.md')
    expect(findSidebarCursorRow(document, anchor!)).toBe(13)
    expect(pathAt(13)).toBe('Areas')
  })

  it('stays on a row whose number did not change', () => {
    renderRows(before)
    const anchor = anchorSidebarCursor(document, 10)!
    renderRows(afterOutsideWrite)
    expect(findSidebarCursorRow(document, anchor)).toBe(10)
  })

  it('has no anchor for a number no row carries', () => {
    renderRows(before)
    expect(anchorSidebarCursor(document, 99)).toBeNull()
  })

  it('reads a folder by its identity, not its open or closed state', () => {
    renderRows(before)
    const anchor = anchorSidebarCursor(document, 12)!
    renderRows(
      before.map(([idx, attrs]) =>
        idx === 12 ? [idx, { ...attrs, 'data-sidebar-collapsed': 'false' }] : [idx, attrs]
      )
    )
    expect(findSidebarCursorRow(document, anchor)).toBe(12)
  })

  it('tells a tree note from the same note pinned under Favorites', () => {
    const favorite: [number, Attrs] = [
      1,
      { 'data-sidebar-type': 'note', 'data-sidebar-path': 'inbox/Open note.md' }
    ]
    renderRows([plain(0, 'vault'), favorite, note(11, 'inbox/Open note.md')])
    const tree = anchorSidebarCursor(document, 11)!
    const pinned = anchorSidebarCursor(document, 1)!
    expect(tree.identity).not.toBe(pinned.identity)
    // A second favorite above both renumbers them.
    renderRows([
      plain(0, 'vault'),
      [1, { 'data-sidebar-type': 'note', 'data-sidebar-path': 'inbox/Another.md' }],
      [2, favorite[1]],
      note(12, 'inbox/Open note.md')
    ])
    expect(findSidebarCursorRow(document, tree)).toBe(12)
    expect(findSidebarCursorRow(document, pinned)).toBe(2)
  })

  it('tells twins apart by their order (Atlas shares Workflows type)', () => {
    renderRows([plain(0, 'vault'), plain(1, 'tasks'), plain(2, 'workflows'), plain(3, 'workflows')])
    const atlas = anchorSidebarCursor(document, 3)!
    const workflows = anchorSidebarCursor(document, 2)!
    expect(atlas.occurrence).toBe(1)
    expect(workflows.occurrence).toBe(0)
    // A favorite above them moves both down one.
    renderRows([
      plain(0, 'vault'),
      note(1, 'inbox/Pinned.md'),
      plain(2, 'tasks'),
      plain(3, 'workflows'),
      plain(4, 'workflows')
    ])
    expect(findSidebarCursorRow(document, atlas)).toBe(4)
    expect(findSidebarCursorRow(document, workflows)).toBe(3)
    // With one twin left, either anchor lands on it: it is also the row next door.
    renderRows([plain(0, 'vault'), plain(1, 'tasks'), plain(2, 'workflows')])
    expect(findSidebarCursorRow(document, atlas)).toBe(2)
  })

  it('treats a windowed placeholder and its full row as one row', () => {
    document.body.innerHTML = `<div data-sidebar-idx="20" data-sidebar-type="note" data-sidebar-path="inbox/x.md" data-sidebar-select-key="${noteKey('inbox/x.md')}"></div>`
    const anchor = anchorSidebarCursor(document, 20)!
    document.body.innerHTML = `<button class="vim-cursor" data-sidebar-idx="21" data-sidebar-type="note" data-sidebar-path="inbox/x.md" data-sidebar-select-key="${noteKey('inbox/x.md')}">x</button>`
    expect(findSidebarCursorRow(document, anchor)).toBe(21)
  })

  it('copes with quotes and backslashes in a path', () => {
    const odd = 'inbox/He said "hi" \\ there.md'
    renderRows([note(4, 'inbox/a.md'), note(5, odd)])
    const anchor = anchorSidebarCursor(document, 5)!
    renderRows([note(4, 'inbox/a.md'), note(5, 'inbox/b.md'), note(6, odd)])
    expect(findSidebarCursorRow(document, anchor)).toBe(6)
    expect(sidebarRowIdentity(document.querySelector('[data-sidebar-idx="6"]')!)).toBe(anchor.identity)
  })
})

describe('when the cursor row is gone', () => {
  it('reports it gone', () => {
    renderRows([note(10, 'inbox/a.md'), note(11, 'inbox/b.md')])
    const anchor = anchorSidebarCursor(document, 11)!
    renderRows([note(10, 'inbox/a.md')])
    expect(findSidebarCursorRow(document, anchor)).toBeNull()
  })

  it('takes the row that now sits where it sat', () => {
    // Display order: Areas, Reading, a, b, c. Deleting `b` (ordinal 3) leaves `c` there.
    renderRows([folder(12, 'Areas'), folder(13, 'Reading'), note(9, 'inbox/a.md'), note(10, 'inbox/b.md'), note(11, 'inbox/c.md')])
    const anchor = anchorSidebarCursor(document, 10)!
    expect(anchor.ordinal).toBe(3)
    renderRows([folder(11, 'Areas'), folder(12, 'Reading'), note(9, 'inbox/a.md'), note(10, 'inbox/c.md')])
    expect(findSidebarCursorRow(document, anchor)).toBeNull()
    expect(sidebarCursorFallbackInDom(document, anchor)).toBe(10)
    expect(pathAt(10)).toBe('inbox/c.md')
  })

  it('takes the renamed row when a rename keeps its place', () => {
    renderRows([note(9, 'inbox/a.md'), note(10, 'inbox/b.md'), note(11, 'inbox/c.md')])
    const anchor = anchorSidebarCursor(document, 10)!
    renderRows([note(9, 'inbox/a.md'), note(10, 'inbox/bb.md'), note(11, 'inbox/c.md')])
    expect(findSidebarCursorRow(document, anchor)).toBeNull()
    expect(sidebarCursorFallbackInDom(document, anchor)).toBe(10)
  })

  it('takes the row before it when it was the last one', () => {
    renderRows([note(9, 'inbox/a.md'), note(10, 'inbox/b.md')])
    const anchor = anchorSidebarCursor(document, 10)!
    renderRows([note(9, 'inbox/a.md')])
    expect(sidebarCursorFallbackInDom(document, anchor)).toBe(9)
  })

  it('skips rows that are not laid out', () => {
    renderRows([note(9, 'inbox/a.md'), note(10, 'inbox/b.md'), note(11, 'inbox/c.md'), note(12, 'inbox/d.md')])
    const anchor = anchorSidebarCursor(document, 10)!
    renderRows([note(9, 'inbox/a.md'), note(11, 'inbox/c.md'), note(12, 'inbox/d.md')], [11])
    expect(sidebarCursorFallbackInDom(document, anchor)).toBe(12)
  })

  // The measured layout: the Inbox tree, then the System section.
  function renderTree(): void {
    document.body.innerHTML = `
      <section>
        <button data-sidebar-idx="9" data-sidebar-type="folder" data-sidebar-folder="inbox" data-sidebar-subpath=""></button>
        <div>
          <div>
            <button data-sidebar-idx="12" data-sidebar-type="folder" data-sidebar-folder="inbox" data-sidebar-subpath="Areas"></button>
            <div><button data-sidebar-idx="13" data-sidebar-type="note" data-sidebar-path="inbox/Areas/x.md"></button></div>
          </div>
          <button data-sidebar-idx="10" data-sidebar-type="note" data-sidebar-path="inbox/Another.md"></button>
          <button data-sidebar-idx="11" data-sidebar-type="note" data-sidebar-path="inbox/Open note.md"></button>
        </div>
      </section>
      <section><button data-sidebar-idx="3" data-sidebar-type="archive"></button></section>`
    document.querySelectorAll<HTMLElement>('[data-sidebar-idx]').forEach((el) => {
      el.getClientRects = (() => [{ width: 200, height: 24 }] as unknown as DOMRectList) as never
    })
  }
  const removeRow = (idx: number): void => document.querySelector(`[data-sidebar-idx="${idx}"]`)!.remove()

  it('stays in the folder when the gone row was its last one', () => {
    // Deleting Inbox's last note used to hand the cursor to Archive, a section away.
    renderTree()
    const anchor = anchorSidebarCursor(document, 11)!
    removeRow(11)
    expect(sidebarCursorFallbackInDom(document, anchor)).toBe(10)
  })

  it('takes the row in its place from the middle of a folder', () => {
    renderTree()
    const anchor = anchorSidebarCursor(document, 10)!
    removeRow(10)
    expect(sidebarCursorFallbackInDom(document, anchor)).toBe(11)
  })

  it('goes up to the folder when its only note goes', () => {
    renderTree()
    const anchor = anchorSidebarCursor(document, 13)!
    removeRow(13)
    expect(sidebarCursorFallbackInDom(document, anchor)).toBe(12)
  })

  it('finds no neighbor in an empty or hidden sidebar', () => {
    expect(sidebarCursorNeighbors([], 3)).toEqual({ after: -1, before: -1 })
    expect(sidebarCursorNeighbors([{ index: 4, rendered: false }], 0)).toEqual({ after: -1, before: -1 })
    renderRows([note(9, 'inbox/a.md')])
    const anchor = anchorSidebarCursor(document, 9)!
    document.body.innerHTML = ''
    expect(sidebarCursorFallbackInDom(document, anchor)).toBeNull()
  })

  it('looks back from past the end, and never lands on a row without a number', () => {
    const rows = [
      { index: 2, rendered: true },
      { index: -1, rendered: true },
      { index: 7, rendered: false }
    ]
    expect(sidebarCursorNeighbors(rows, 9)).toEqual({ after: -1, before: 0 })
    expect(sidebarCursorNeighbors(rows, 1)).toEqual({ after: -1, before: 0 })
    expect(sidebarCursorNeighbors(rows, 0)).toEqual({ after: 0, before: -1 })
  })
})
