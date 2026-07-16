import { describe, it, expect, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { mathRenderExtension } from './cm-math-render'
import { zenMoveByDisplayLine } from './cm-vim-display-line'

type Cm = Parameters<typeof zenMoveByDisplayLine>[0]
type MotionArgs = Parameters<typeof zenMoveByDisplayLine>[2]
type VimState = Parameters<typeof zenMoveByDisplayLine>[3]

// Drive the motion with a mock CodeMirror-Vim adapter. `findPosV` is the
// display-line move — spying on it tells us whether the display path (bare j/k)
// or the logical fallback (count / operator / visual) was taken.
function run(
  args: MotionArgs,
  vim: VimState = {},
  head: { line: number; ch: number } = { line: 10, ch: 3 }
): { res: { line: number; ch: number }; findPosV: ReturnType<typeof vi.fn> } {
  const findPosV = vi.fn(() => ({ line: 99, ch: 7 }))
  const cm = {
    firstLine: () => 0,
    lastLine: () => 100,
    findPosV,
    charCoords: () => ({ left: 42 })
  } as unknown as Cm
  const res = zenMoveByDisplayLine(cm, head, args, vim)
  return { res, findPosV }
}

describe('zenMoveByDisplayLine (#290 display-line j/k, #314 count fallback)', () => {
  it('a bare j (no count) moves by display line via findPosV', () => {
    const { res, findPosV } = run({ forward: true, repeat: 1, repeatIsExplicit: false })
    expect(findPosV).toHaveBeenCalledTimes(1)
    expect(res.line).toBe(99) // the display-move sentinel
  })

  it('an explicit count (3j) moves by LOGICAL lines, not display rows (#314)', () => {
    const { res, findPosV } = run({ forward: true, repeat: 3, repeatIsExplicit: true })
    expect(findPosV).not.toHaveBeenCalled()
    expect(res.line).toBe(13) // 10 + 3 logical lines — matches the relativenumber gutter
    expect(res.ch).toBe(3) // keeps the column
  })

  it('an explicit count upward (4k) moves logical lines up (#314)', () => {
    const { res, findPosV } = run({ forward: false, repeat: 4, repeatIsExplicit: true })
    expect(findPosV).not.toHaveBeenCalled()
    expect(res.line).toBe(6) // 10 - 4
  })

  it('an operator-pending motion (dj) stays logical', () => {
    const { res, findPosV } = run({ forward: true, repeat: 1 }, { inputState: { operator: {} } })
    expect(findPosV).not.toHaveBeenCalled()
    expect(res.line).toBe(11)
  })

  it('a visual-line selection (Vj) stays logical', () => {
    const { res, findPosV } = run({ forward: true, repeat: 1 }, { visualLine: true })
    expect(findPosV).not.toHaveBeenCalled()
    expect(res.line).toBe(11)
  })

  it('a logical count clamps to the document bounds', () => {
    const { res } = run(
      { forward: false, repeat: 10, repeatIsExplicit: true },
      {},
      { line: 2, ch: 0 }
    )
    expect(res.line).toBe(0) // clamped to firstLine
  })
})

describe('zenMoveByDisplayLine around rendered block math', () => {
  // 0-based lines: 0 `alpha`, 1 ``, 2 `$$`, 3 `x+1`, 4 `$$`, 5 ``, 6 `omega`.
  const MATH_DOC = 'alpha\n\n$$\nx+1\n$$\n\nomega'

  function runWithDoc(
    doc: string,
    head: { line: number; ch: number },
    args: MotionArgs,
    findPosVResult: { line: number; ch: number }
  ): { res: { line: number; ch: number }; findPosV: ReturnType<typeof vi.fn> } {
    const state = EditorState.create({ doc, extensions: [mathRenderExtension] })
    const findPosV = vi.fn(() => findPosVResult)
    const cm = {
      firstLine: () => 0,
      lastLine: () => state.doc.lines - 1,
      findPosV,
      charCoords: () => ({ left: 42 }),
      cm6: { state } as unknown as EditorView
    } as unknown as Cm
    const res = zenMoveByDisplayLine(cm, head, args, {})
    return { res, findPosV }
  }

  it('bare j steps logically into the block from the line above', () => {
    const { res, findPosV } = runWithDoc(
      MATH_DOC,
      { line: 1, ch: 0 },
      { forward: true, repeat: 1 },
      { line: 5, ch: 0 } // what the pixel skip would have produced
    )
    expect(findPosV).not.toHaveBeenCalled()
    expect(res.line).toBe(2) // the opening $$
  })

  it('bare k steps logically into the block from the line below', () => {
    const { res, findPosV } = runWithDoc(
      MATH_DOC,
      { line: 5, ch: 0 },
      { forward: false, repeat: 1 },
      { line: 1, ch: 0 }
    )
    expect(findPosV).not.toHaveBeenCalled()
    expect(res.line).toBe(4) // the closing $$
  })

  it('inside the (revealed) block the display path still applies', () => {
    const { res, findPosV } = runWithDoc(
      MATH_DOC,
      { line: 2, ch: 0 },
      { forward: true, repeat: 1 },
      { line: 3, ch: 0 } // a sane one-row move within visible source
    )
    expect(findPosV).toHaveBeenCalledTimes(1)
    expect(res.line).toBe(3)
  })

  it('snaps an overshooting pixel move back to one logical step when it skipped a block', () => {
    // e.g. launched off a heading with large CSS margins: findPosV leaps from
    // line 0 clean past the widget to line 6.
    const { res, findPosV } = runWithDoc(
      MATH_DOC,
      { line: 0, ch: 0 },
      { forward: true, repeat: 1 },
      { line: 6, ch: 0 }
    )
    expect(findPosV).toHaveBeenCalledTimes(1)
    expect(res.line).toBe(1) // the blank line above the block, not past it
  })

  it('leaves overshoots alone when no math block was skipped', () => {
    const { res } = runWithDoc(
      'plain\ntext\nonly\nhere\nnow',
      { line: 0, ch: 0 },
      { forward: true, repeat: 1 },
      { line: 3, ch: 0 }
    )
    expect(res.line).toBe(3) // non-math skips (tables, folds) keep today's behavior
  })
})
