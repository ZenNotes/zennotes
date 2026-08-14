import { describe, expect, it, vi } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import {
  cursorDisplayRowEnd,
  cursorDisplayRowStart,
  selectDisplayRowEnd
} from './cm-display-row'

// Simulated layout: line 2 (offsets 6..106) holds 100 characters wrapping into
// rows of 30, so the wrap points sit at 36, 66 and 96. `jitter` adds sub-pixel
// noise like the fractional-scaling environments where an x hit-test mislands.
const DOC = `alpha\n${'x'.repeat(100)}\nomega`

function fakeView(jitter = false) {
  const state = EditorState.create({
    doc: DOC,
    selection: EditorSelection.cursor(50)
  })
  const posAtCoords = vi.fn(() => 0)
  const view = {
    state,
    posAtCoords,
    coordsAtPos: (offset: number) => {
      if (offset < 6 || offset > 106) return null
      const row = Math.min(3, Math.floor((offset - 6) / 30))
      const noise = jitter ? ((offset * 7) % 5) - 2 : 0
      const top = 100 + row * 20 + noise
      return { left: 0, right: 0, top, bottom: top + 18 }
    },
    dispatch: vi.fn((spec: { selection?: EditorSelection }) => {
      if (spec.selection) view.state = state.update({ selection: spec.selection }).state
    })
  }
  return view as unknown as EditorView & {
    posAtCoords: ReturnType<typeof vi.fn>
    dispatch: ReturnType<typeof vi.fn>
  }
}

function cursorAfter(view: ReturnType<typeof fakeView>): { head: number; assoc: number } {
  const spec = view.dispatch.mock.calls.at(-1)?.[0] as { selection: EditorSelection }
  const range = spec.selection.main
  return { head: range.head, assoc: range.assoc }
}

// #591: Home and End were CodeMirror's own bindings, which find the row edge by
// hit-testing an x coordinate at the editor's edge. That is the resolution #575
// removed from `$` because it lands short of the wrap point, or on a
// neighboring row, under fractional display scaling.
describe('Home/End on a wrapped display row (#591)', () => {
  it('End lands on the end of the row the cursor is on, never past it', () => {
    const view = fakeView()
    expect(cursorDisplayRowEnd(view)).toBe(true)
    // Offset 50 sits in the second row (36..65), which ends at 66.
    expect(cursorAfter(view)).toEqual({ head: 66, assoc: -1 })
  })

  it('Home lands on the start of that same row', () => {
    const view = fakeView()
    expect(cursorDisplayRowStart(view)).toBe(true)
    expect(cursorAfter(view)).toEqual({ head: 36, assoc: 1 })
  })

  it('never resolves an x coordinate, which is what mislands', () => {
    const view = fakeView()
    cursorDisplayRowEnd(view)
    cursorDisplayRowStart(view)
    expect(view.posAtCoords).not.toHaveBeenCalled()
  })

  it('sub-pixel jitter in the row coordinates changes nothing', () => {
    const view = fakeView(true)
    cursorDisplayRowEnd(view)
    expect(cursorAfter(view).head).toBe(66)
  })

  it('Shift+End extends the selection to the row end instead of moving the caret', () => {
    const view = fakeView()
    expect(selectDisplayRowEnd(view)).toBe(true)
    const spec = view.dispatch.mock.calls.at(-1)?.[0] as { selection: EditorSelection }
    expect(spec.selection.main.anchor).toBe(50)
    expect(spec.selection.main.head).toBe(66)
  })

  it('reports the key as handled at the boundary so the old bindings never run', () => {
    const view = fakeView()
    cursorDisplayRowEnd(view)
    view.dispatch.mockClear()
    // A second press has nowhere to go, but handing the key back to
    // CodeMirror would reintroduce the hit-testing this replaces.
    expect(cursorDisplayRowEnd(view)).toBe(true)
    expect(view.dispatch).not.toHaveBeenCalled()
  })

  it('falls back to the logical line boundary when coordinates are unavailable', () => {
    const state = EditorState.create({ doc: DOC, selection: EditorSelection.cursor(50) })
    const view = {
      state,
      posAtCoords: vi.fn(),
      coordsAtPos: () => null,
      dispatch: vi.fn()
    } as unknown as EditorView & { dispatch: ReturnType<typeof vi.fn> }
    cursorDisplayRowEnd(view)
    const spec = view.dispatch.mock.calls.at(-1)?.[0] as { selection: EditorSelection }
    expect(spec.selection.main.head).toBe(106)
  })
})
