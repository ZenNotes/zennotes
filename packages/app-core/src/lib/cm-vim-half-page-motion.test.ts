import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorSelection, Text } from '@codemirror/state'
import { halfPageDistance, zenMoveByHalfPage, type HalfPageView } from './cm-vim-half-page-motion'

// Ten pixels per character, so a goal column in pixels is ten times the
// character column. The content starts 100px from the window's left edge to
// make sure the motion subtracts it like the codemirror-vim adapter does.
const CHAR_WIDTH = 10
const CONTENT_LEFT = 100

type FakeView = HalfPageView & { moveVertically: ReturnType<typeof vi.fn> }

/**
 * A view whose vertical movement is one logical line per step at the same
 * column (clipped to the target line's length) and whose edge behavior is
 * CM6's: moving past the last line lands on the end of the document, past the
 * first on offset 0, and from either of those the head does not move.
 */
function fakeView(
  lines: string[],
  geometry: { clientHeight: number; lineHeight: number; scrollTop?: number }
): FakeView {
  const doc = Text.of(lines)
  const view: FakeView = {
    scrollDOM: {
      clientHeight: geometry.clientHeight,
      scrollHeight: lines.length * geometry.lineHeight,
      scrollTop: geometry.scrollTop ?? 0
    },
    contentDOM: { getBoundingClientRect: () => ({ left: CONTENT_LEFT }) },
    defaultLineHeight: geometry.lineHeight,
    state: { doc },
    coordsAtPos: (pos) => {
      const line = doc.lineAt(pos)
      return { left: CONTENT_LEFT + (pos - line.from) * CHAR_WIDTH }
    },
    moveVertically: vi.fn((start, forward) => {
      const edge = forward ? doc.length : 0
      if (start.head === edge) return start
      const line = doc.lineAt(start.head)
      const goal = start.goalColumn ?? (start.head - line.from) * CHAR_WIDTH
      const targetNumber = forward ? line.number + 1 : line.number - 1
      if (targetNumber < 1 || targetNumber > doc.lines) {
        return EditorSelection.cursor(edge, 1, undefined, goal)
      }
      const target = doc.line(targetNumber)
      const col = Math.min(target.length, Math.round(goal / CHAR_WIDTH))
      return EditorSelection.cursor(target.from + col, 1, undefined, goal)
    })
  }
  return view
}

function cmFor(view: HalfPageView | undefined, lineCount: number) {
  return { firstLine: () => 0, lastLine: () => lineCount - 1, cm6: view }
}

const LONG = 'abcdefghij'
const thirtyLines = Array.from({ length: 30 }, () => LONG)

describe('halfPageDistance', () => {
  it('is half the viewport without a count, in lines and pixels', () => {
    expect(halfPageDistance(400, 20, 0)).toEqual({ lines: 10, pixels: 200 })
    // Odd viewports round rather than truncate.
    expect(halfPageDistance(410, 20, 0)).toEqual({ lines: 10, pixels: 205 })
  })

  it('is the typed count in lines and the same number of line heights in pixels', () => {
    expect(halfPageDistance(400, 20, 3)).toEqual({ lines: 3, pixels: 60 })
  })

  it('always moves at least one line and never divides by a zero line height', () => {
    expect(halfPageDistance(0, 20, 0)).toEqual({ lines: 1, pixels: 1 })
    expect(halfPageDistance(400, 0, 0)).toEqual({ lines: 11, pixels: 200 })
  })
})

describe('zenMoveByHalfPage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('moves the head down half a page of display lines and scrolls the viewport as far', () => {
    const view = fakeView(thirtyLines, { clientHeight: 400, lineHeight: 20 })
    const vim = {}

    const target = zenMoveByHalfPage(cmFor(view, 30), { line: 0, ch: 2 }, { forward: true, repeat: 0 }, vim)

    expect(target).toMatchObject({ line: 10, ch: 2 })
    expect(view.scrollDOM.scrollTop).toBe(200)
    expect(view.moveVertically).toHaveBeenCalledTimes(10)
  })

  it('moves back up and never scrolls above the top', () => {
    const view = fakeView(thirtyLines, { clientHeight: 400, lineHeight: 20, scrollTop: 120 })

    const target = zenMoveByHalfPage(cmFor(view, 30), { line: 12, ch: 4 }, { forward: false, repeat: 0 }, {})

    expect(target).toMatchObject({ line: 2, ch: 4 })
    expect(view.scrollDOM.scrollTop).toBe(0)
  })

  it('stops on the last line instead of wrapping, and clamps the scroll to the document', () => {
    const view = fakeView(thirtyLines, { clientHeight: 400, lineHeight: 20, scrollTop: 150 })

    const target = zenMoveByHalfPage(cmFor(view, 30), { line: 25, ch: 3 }, { forward: true, repeat: 0 }, {})

    expect(target.line).toBe(29)
    // scrollHeight 600 minus clientHeight 400: the viewport cannot go past 200.
    expect(view.scrollDOM.scrollTop).toBe(200)
  })

  it('stops on the first line instead of wrapping', () => {
    const view = fakeView(thirtyLines, { clientHeight: 400, lineHeight: 20, scrollTop: 40 })

    const target = zenMoveByHalfPage(cmFor(view, 30), { line: 3, ch: 5 }, { forward: false, repeat: 0 }, {})

    expect(target.line).toBe(0)
    expect(view.scrollDOM.scrollTop).toBe(0)
  })

  it('moves and scrolls by the typed count instead of half a page', () => {
    const view = fakeView(thirtyLines, { clientHeight: 400, lineHeight: 20 })

    const target = zenMoveByHalfPage(
      cmFor(view, 30),
      { line: 0, ch: 0 },
      { forward: true, repeat: 3, repeatIsExplicit: true },
      {}
    )

    expect(target).toMatchObject({ line: 3, ch: 0 })
    expect(view.scrollDOM.scrollTop).toBe(60)
  })

  it('ignores a leftover repeat that was not typed as a count', () => {
    // codemirror-vim only marks the repeat explicit when digits were typed;
    // a plain press arrives with repeat 0 and no flag and must page.
    const view = fakeView(thirtyLines, { clientHeight: 400, lineHeight: 20 })

    const target = zenMoveByHalfPage(cmFor(view, 30), { line: 0, ch: 0 }, { forward: true, repeat: 7 }, {})

    expect(target.line).toBe(10)
    expect(view.scrollDOM.scrollTop).toBe(200)
  })

  it('keeps the goal column across consecutive presses through a short line', () => {
    const lines = thirtyLines.slice()
    lines[10] = 'ab'
    const view = fakeView(lines, { clientHeight: 400, lineHeight: 20 })
    const vim: { lastMotion?: unknown; lastHSPos?: number } = {}

    const first = zenMoveByHalfPage(cmFor(view, 30), { line: 0, ch: 6 }, { forward: true, repeat: 0 }, vim)
    expect(first).toMatchObject({ line: 10, ch: 2 })
    expect(vim.lastHSPos).toBe(60)

    // codemirror-vim records the motion that ran; the next press sees it.
    vim.lastMotion = zenMoveByHalfPage
    const second = zenMoveByHalfPage(cmFor(view, 30), first, { forward: true, repeat: 0 }, vim)
    expect(second).toMatchObject({ line: 20, ch: 6 })

    // Any other motion in between re-measures from the current head.
    vim.lastMotion = () => undefined
    const third = zenMoveByHalfPage(cmFor(view, 30), { line: 20, ch: 1 }, { forward: false, repeat: 0 }, vim)
    expect(third).toMatchObject({ line: 10, ch: 1 })
    expect(vim.lastHSPos).toBe(10)
  })

  it('falls back to logical lines when the pixel path throws, and still scrolls', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const view = fakeView(thirtyLines, { clientHeight: 400, lineHeight: 20 })
    view.moveVertically.mockImplementation(() => {
      throw new Error('no layout')
    })

    const target = zenMoveByHalfPage(cmFor(view, 30), { line: 4, ch: 3 }, { forward: true, repeat: 0 }, {})

    expect(target).toMatchObject({ line: 14, ch: 3 })
    expect(view.scrollDOM.scrollTop).toBe(200)
  })

  it('steps one logical line without a view to measure', () => {
    expect(zenMoveByHalfPage(cmFor(undefined, 30), { line: 4, ch: 3 }, { forward: true, repeat: 0 }, {})).toMatchObject({
      line: 5,
      ch: 3
    })
    expect(
      zenMoveByHalfPage(
        cmFor(undefined, 30),
        { line: 4, ch: 3 },
        { forward: false, repeat: 9, repeatIsExplicit: true },
        {}
      )
    ).toMatchObject({ line: 0, ch: 3 })
  })
})
