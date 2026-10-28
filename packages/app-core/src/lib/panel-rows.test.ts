// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const storeMock = vi.hoisted(() => ({
  state: {
    outlineCursorIndex: 0,
    connectionsCursorIndex: 0,
    sidebarCursorIndex: 0,
    noteListCursorIndex: 0,
    activeCommentId: null as string | null,
    setOutlineCursorIndex: (idx: number) => {
      storeMock.state.outlineCursorIndex = idx
    },
    setConnectionsCursorIndex: (idx: number) => {
      storeMock.state.connectionsCursorIndex = idx
    },
    setSidebarCursorIndex: (idx: number) => {
      storeMock.state.sidebarCursorIndex = idx
    },
    setNoteListCursorIndex: (idx: number) => {
      storeMock.state.noteListCursorIndex = idx
    },
    setActiveCommentId: (id: string | null) => {
      storeMock.state.activeCommentId = id
    }
  }
}))

vi.mock('../store', () => ({
  useStore: { getState: () => storeMock.state }
}))

import {
  findPositionByIndex,
  getIndexedElements,
  isRowPanel,
  pageMoveForKey,
  pageRowCount,
  pageTargetPosition
} from './panel-rows'

/** jsdom has no layout: every element reports no client rects (which the row
 *  scan reads as "not on screen") and a zero bounding box. Stack the rows
 *  vertically by hand so they sort the way real rows do. */
function layOutRows(): void {
  document.querySelectorAll<HTMLElement>('[data-outline-idx],[data-connections-idx],[data-comments-idx]')
    .forEach((el, i) => {
      el.getClientRects = (() => [{ width: 200, height: 24 }] as unknown as DOMRectList) as never
      el.getBoundingClientRect = (() =>
        ({ top: i * 24, bottom: i * 24 + 24, left: 0, right: 200, width: 200, height: 24 }) as DOMRect) as never
      el.scrollIntoView = (() => {}) as never
    })
}

function renderRows(attr: string, count: number, extra = ''): void {
  document.body.innerHTML = Array.from(
    { length: count },
    (_, i) => `<button ${attr}="${i}" ${extra ? extra.replace('%i', String(i)) : ''}>row ${i}</button>`
  ).join('')
  layOutRows()
}

beforeEach(() => {
  document.body.innerHTML = ''
  storeMock.state.outlineCursorIndex = 0
  storeMock.state.connectionsCursorIndex = 0
  storeMock.state.activeCommentId = null
})

describe('panel row cursors (#477 follow-up)', () => {
  it('knows which panels are row lists', () => {
    expect(isRowPanel('outline')).toBe(true)
    expect(isRowPanel('connections')).toBe(true)
    // Comments track the active comment by id, calendar owns its own keys.
    expect(isRowPanel('comments')).toBe(false)
    expect(isRowPanel('calendar')).toBe(false)
    expect(isRowPanel(null)).toBe(false)
  })

  it('re-seats a cursor left past the end of a shrunken list', () => {
    renderRows('data-outline-idx', 2)
    const items = getIndexedElements('[data-outline-idx]', 'outlineIdx')
    // Headings were edited away while the panel was not looking.
    expect(findPositionByIndex(items, 'outlineIdx', 7)).toBe(1)
  })
})

/** Rows of the given heights, one under the other, in a scroll box that
 *  shows `boxHeight` pixels. */
function renderStack(heights: number[], boxHeight: number): HTMLElement[] {
  document.body.innerHTML = `<div data-panel-scroll>${heights
    .map((_, i) => `<button data-comments-idx="${i}">card ${i}</button>`)
    .join('')}</div>`
  Object.defineProperty(document.querySelector('[data-panel-scroll]'), 'clientHeight', {
    configurable: true,
    value: boxHeight
  })
  let top = 0
  const rows = [...document.querySelectorAll<HTMLElement>('[data-comments-idx]')]
  rows.forEach((el, i) => {
    const rowTop = top
    const height = heights[i]
    el.getBoundingClientRect = (() =>
      ({ top: rowTop, bottom: rowTop + height, left: 0, right: 200, width: 200, height }) as DOMRect) as never
    top += height
  })
  return rows
}

describe('page keys in a panel', () => {
  const keydown = (key: string, init: KeyboardEventInit = {}): KeyboardEvent =>
    new KeyboardEvent('keydown', { key, ...init })

  it('reads Home, End and the page keys with Vim off only', () => {
    expect(pageMoveForKey(keydown('Home'), false)).toBe('first')
    expect(pageMoveForKey(keydown('End'), false)).toBe('last')
    expect(pageMoveForKey(keydown('PageDown'), false)).toBe('pageDown')
    expect(pageMoveForKey(keydown('PageUp'), false)).toBe('pageUp')
    expect(pageMoveForKey(keydown('ArrowDown'), false)).toBeNull()
    expect(pageMoveForKey(keydown('G', { shiftKey: true }), false)).toBeNull()
    // Vim mode keeps gg and G, and leaves these four alone.
    expect(pageMoveForKey(keydown('PageDown'), true)).toBeNull()
    expect(pageMoveForKey(keydown('Home'), true)).toBeNull()
    // A chord is never a page key.
    expect(pageMoveForKey(keydown('PageDown', { metaKey: true }), false)).toBeNull()
    expect(pageMoveForKey(keydown('End', { altKey: true }), false)).toBeNull()
  })

  it('counts a page of same-height rows as the rows on screen, less one', () => {
    const rows = renderStack([24, 24, 24, 24, 24, 24, 24, 24], 24 * 5)
    expect(pageRowCount(rows, 0)).toBe(4)
    expect(pageRowCount(rows, 7)).toBe(4)
    // No rows, no box or no layout: one row, never zero.
    expect(pageRowCount([], 0)).toBe(1)
    Object.defineProperty(document.querySelector('[data-panel-scroll]'), 'clientHeight', {
      configurable: true,
      value: 0
    })
    expect(pageRowCount(rows, 0)).toBe(1)
  })

  it('measures a row by its step to the next, inside the box’s padding', () => {
    // The note list: 72 px rows 76 px apart in a box with 8 px of padding
    // above and below, 808 px tall. Ten rows fit (792 / 76), so a page is
    // nine; by the rows' own height it would be ten, one too far.
    document.body.innerHTML = `<div data-panel-scroll style="padding: 8px 0">${Array.from(
      { length: 14 },
      (_, i) => `<button data-notelist-idx="${i}">row ${i}</button>`
    ).join('')}</div>`
    Object.defineProperty(document.querySelector('[data-panel-scroll]'), 'clientHeight', {
      configurable: true,
      value: 808
    })
    const rows = [...document.querySelectorAll<HTMLElement>('[data-notelist-idx]')]
    rows.forEach((el, i) => {
      el.getBoundingClientRect = (() =>
        ({ top: 8 + i * 76, bottom: 8 + i * 76 + 72, left: 0, right: 200, width: 200, height: 72 }) as DOMRect) as never
    })
    expect(pageRowCount(rows, 3)).toBe(9)
    // A section header between two rows does not stretch the step.
    rows.slice(5).forEach((el, n) => {
      const top = 8 + (5 + n) * 76 + 120
      el.getBoundingClientRect = (() =>
        ({ top, bottom: top + 72, left: 0, right: 200, width: 200, height: 72 }) as DOMRect) as never
    })
    expect(pageRowCount(rows, 5)).toBe(9)
  })

  it('gives the same page as the row count when the rows share a height', () => {
    const rows = renderStack(Array(12).fill(24), 24 * 5)
    expect(pageTargetPosition(rows, 0, 1)).toBe(4)
    expect(pageTargetPosition(rows, 4, 1)).toBe(8)
    expect(pageTargetPosition(rows, 10, 1)).toBe(11)
    expect(pageTargetPosition(rows, 11, -1)).toBe(7)
    expect(pageTargetPosition(rows, 2, -1)).toBe(0)
  })

  it('never pages past a tall card the screen has not shown', () => {
    // A 300 px box: from card 0 (80), the 260 px card 2 does not fit with it.
    const rows = renderStack([80, 60, 260, 40, 40], 300)
    expect(pageTargetPosition(rows, 0, 1)).toBe(1)
    // From the tall card itself it still moves one card.
    expect(pageTargetPosition(rows, 2, 1)).toBe(3)
    expect(pageTargetPosition(rows, 3, 1)).toBe(4)
    expect(pageTargetPosition(rows, 4, -1)).toBe(3)
    expect(pageTargetPosition(rows, 3, -1)).toBe(2)
  })

  it('stays put at the ends and on an empty list', () => {
    const rows = renderStack([24, 24, 24], 24 * 5)
    expect(pageTargetPosition(rows, 2, 1)).toBe(2)
    expect(pageTargetPosition(rows, 0, -1)).toBe(0)
    expect(pageTargetPosition([], 0, 1)).toBe(0)
  })
})
