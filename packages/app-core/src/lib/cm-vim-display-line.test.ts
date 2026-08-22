import { describe, it, expect, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { mathRenderExtension } from './cm-math-render'
import {
  zenEnterInsertAtLineBoundary,
  zenMoveByDisplayLine,
  zenMoveToDisplayLineBoundary,
  zenMoveToViewportEdge
} from './cm-vim-display-line'

type Cm = Parameters<typeof zenMoveByDisplayLine>[0]
type MotionArgs = Parameters<typeof zenMoveByDisplayLine>[2]
type VimState = Parameters<typeof zenMoveByDisplayLine>[3]

// Drive the motion with a mock CodeMirror-Vim adapter. `findPosV` is the
// display-line move — spying on it tells us whether the display path (bare j/k)
// or the logical fallback (count / operator / visual) was taken.
function run(
  args: MotionArgs,
  vim: VimState = {},
  head: { line: number; ch: number } = { line: 10, ch: 3 },
  inputState?: { prefixRepeat: string[]; motionRepeat: string[] }
): { res: { line: number; ch: number }; findPosV: ReturnType<typeof vi.fn> } {
  const findPosV = vi.fn(() => ({ line: 99, ch: 7 }))
  const cm = {
    firstLine: () => 0,
    lastLine: () => 100,
    findPosV,
    charCoords: () => ({ left: 42 })
  } as unknown as Cm
  const res = zenMoveByDisplayLine(cm, head, args, vim, inputState)
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

  it('reads a typed 8j count from the adapter input state (#660)', () => {
    const { res, findPosV } = run(
      { forward: true, repeat: 8 },
      {},
      { line: 0, ch: 0 },
      { prefixRepeat: ['8'], motionRepeat: [] }
    )

    expect(findPosV).not.toHaveBeenCalled()
    expect(res.line).toBe(8)
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
    const state = EditorState.create({ doc, extensions: [mathRenderExtension('katex')] })
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

describe('zenMoveByDisplayLine no-progress fallback (#423)', () => {
  // Simulate the pixel motion failing to advance across a soft-wrap boundary
  // (sub-pixel-imprecise coords, e.g. under fractional display scaling):
  // findPosV returns the same head, which used to leave k/j stuck.
  function runStuck(head: { line: number; ch: number }, forward: boolean): { line: number; ch: number } {
    const cm = {
      firstLine: () => 0,
      lastLine: () => 100,
      findPosV: () => ({ line: head.line, ch: head.ch }),
      charCoords: () => ({ left: 42 })
    } as unknown as Cm
    return zenMoveByDisplayLine(cm, head, { forward, repeat: 1 }, {})
  }

  it('a k that fails to advance falls back to a logical step up', () => {
    const res = runStuck({ line: 50, ch: 10 }, false)
    expect(res.line).toBe(49)
    expect(res.ch).toBe(10)
  })

  it('a j that fails to advance falls back to a logical step down', () => {
    const res = runStuck({ line: 50, ch: 10 }, true)
    expect(res.line).toBe(51)
  })

  it('does not fabricate movement above the first line', () => {
    const res = runStuck({ line: 0, ch: 5 }, false)
    expect(res.line).toBe(0)
    expect(res.ch).toBe(5)
  })

  it('does not fabricate movement below the last line', () => {
    const res = runStuck({ line: 100, ch: 5 }, true)
    expect(res.line).toBe(100)
  })

  it('keeps the display-line result when it advances up a wrapped row', () => {
    // Same logical line, smaller ch → a real one-row move; no fallback.
    const cm = {
      firstLine: () => 0,
      lastLine: () => 100,
      findPosV: () => ({ line: 50, ch: 3 }),
      charCoords: () => ({ left: 42 })
    } as unknown as Cm
    const res = zenMoveByDisplayLine(cm, { line: 50, ch: 10 }, { forward: false, repeat: 1 }, {})
    expect(res.line).toBe(50)
    expect(res.ch).toBe(3)
  })
})

describe('measurement-crash fallback (#574)', () => {
  // codemirror-vim rethrows a motion exception after clearing its state, and
  // the un-preventDefault-ed keydown then types the pressed key into the note.
  // A throw anywhere in the pixel path must therefore degrade to the logical
  // step, never escape.

  it('j falls back to one logical line down when findPosV throws', () => {
    const cm = {
      firstLine: () => 0,
      lastLine: () => 100,
      findPosV: () => {
        throw new TypeError("Cannot read properties of null (reading 'top')")
      },
      charCoords: () => ({ left: 42 })
    } as unknown as Cm
    const res = zenMoveByDisplayLine(cm, { line: 50, ch: 10 }, { forward: true, repeat: 1 }, {})
    expect(res).toEqual({ line: 51, ch: 10 })
  })

  it('k falls back to one logical line up when charCoords throws', () => {
    const cm = {
      firstLine: () => 0,
      lastLine: () => 100,
      findPosV: () => ({ line: 49, ch: 10 }),
      charCoords: () => {
        throw new TypeError('measure failed')
      }
    } as unknown as Cm
    const res = zenMoveByDisplayLine(cm, { line: 50, ch: 10 }, { forward: false, repeat: 1 }, {})
    expect(res).toEqual({ line: 49, ch: 10 })
  })

  it('the fallback still clamps to the document bounds', () => {
    const cm = {
      firstLine: () => 0,
      lastLine: () => 100,
      findPosV: () => {
        throw new Error('boom')
      },
      charCoords: () => ({ left: 42 })
    } as unknown as Cm
    const res = zenMoveByDisplayLine(cm, { line: 0, ch: 5 }, { forward: false, repeat: 1 }, {})
    expect(res).toEqual({ line: 0, ch: 5 })
  })

  it('a bare $ falls back to the logical line end when goLineRight throws', () => {
    const cm = {
      execCommand: () => {
        throw new Error('boom')
      },
      getCursor: vi.fn()
    }
    const res = zenMoveToDisplayLineBoundary(cm, { line: 4, ch: 7 }, { forward: true, repeat: 1 })
    expect(res).toEqual({ line: 4, ch: Infinity })
  })

  it('g0 falls back to column 0 when the row measurement throws', () => {
    const cm = {
      execCommand: vi.fn(),
      getCursor: vi.fn(),
      charCoords: () => {
        throw new Error('boom')
      },
      coordsChar: vi.fn()
    }
    const res = zenMoveToDisplayLineBoundary(cm, { line: 4, ch: 30 }, { forward: false, repeat: 1 })
    expect(res).toEqual({ line: 4, ch: 0 })
  })

  it('H stays put instead of throwing when the viewport measurement fails', () => {
    const cm = {
      firstLine: () => 0,
      lastLine: () => 99,
      getScrollInfo: () => {
        throw new Error('boom')
      },
      coordsChar: vi.fn(),
      getLine: () => '',
      findPosV: vi.fn()
    }
    const res = zenMoveToViewportEdge(cm, { line: 15, ch: 4 }, { forward: false, repeat: 1 })
    expect(res).toEqual({ line: 15, ch: 4 })
  })
})

describe('wrapped display-row boundaries (#536)', () => {
  it('moves $ to the end of the current display row', () => {
    let cursor = { line: 4, ch: 7, sticky: 'before' }
    const cm = {
      execCommand: (command: string) => {
        expect(command).toBe('goLineRight')
        cursor = { line: 4, ch: 23, sticky: 'before' }
      },
      getCursor: () => cursor
    }

    expect(
      zenMoveToDisplayLineBoundary(cm, { line: 4, ch: 7 }, { forward: true, repeat: 1 })
    ).toEqual({ line: 4, ch: 22 })
  })

  it('moves I to the start of the current display row', () => {
    const cm = {
      execCommand: vi.fn(),
      getCursor: vi.fn(),
      charCoords: vi.fn(() => ({ left: 180, top: 40, bottom: 60 })),
      coordsChar: vi.fn(() => ({ line: 4, ch: 18 }))
    }

    expect(
      zenMoveToDisplayLineBoundary(cm, { line: 4, ch: 30 }, { forward: false, repeat: 1 })
    ).toEqual({ line: 4, ch: 18 })
    expect(cm.coordsChar).toHaveBeenCalledWith({ left: 0, top: 50 }, 'div')
    expect(cm.execCommand).not.toHaveBeenCalled()
  })

  it('keeps counted $ on logical lines', () => {
    const cm = {
      firstLine: () => 0,
      lastLine: () => 20,
      execCommand: vi.fn(),
      getCursor: vi.fn()
    }

    expect(
      zenMoveToDisplayLineBoundary(cm, { line: 4, ch: 7 }, { forward: true, repeat: 3 })
    ).toEqual({ line: 6, ch: Infinity })
    expect(cm.execCommand).not.toHaveBeenCalled()
  })
})

describe('configurable wrapped-line boundaries (#638)', () => {
  it('moves a bare $ to the logical line end without measuring the display row', () => {
    const cm = {
      execCommand: vi.fn(),
      getCursor: vi.fn()
    }

    expect(
      zenMoveToDisplayLineBoundary(cm, { line: 4, ch: 7 }, {
        forward: true,
        repeat: 1,
        lineMode: 'logical'
      })
    ).toEqual({ line: 4, ch: Infinity })
    expect(cm.execCommand).not.toHaveBeenCalled()
  })

  it('enters insert mode at the first non-blank character of the logical line for I', () => {
    const enterInsertMode = vi.fn()
    const cm = {
      execCommand: vi.fn(),
      getCursor: () => ({ line: 4, ch: 30 }),
      getLine: () => '    logical line'
    }

    zenEnterInsertAtLineBoundary.call(
      { enterInsertMode },
      cm,
      { forward: false, lineMode: 'logical' },
      { insertMode: false }
    )

    expect(enterInsertMode).toHaveBeenCalledWith(
      cm,
      { head: { line: 4, ch: 4 }, insertAt: 'inplace', repeat: undefined },
      { insertMode: false }
    )
    expect(cm.execCommand).not.toHaveBeenCalled()
  })

  it('enters insert mode at the logical line end for A', () => {
    const enterInsertMode = vi.fn()
    const cm = {
      execCommand: vi.fn(),
      getCursor: () => ({ line: 4, ch: 7 }),
      getLine: () => 'complete logical line'
    }

    zenEnterInsertAtLineBoundary.call(
      { enterInsertMode },
      cm,
      { forward: true, lineMode: 'logical' },
      { insertMode: false }
    )

    expect(enterInsertMode).toHaveBeenCalledWith(
      cm,
      { head: { line: 4, ch: 21 }, insertAt: 'inplace', repeat: undefined },
      { insertMode: false }
    )
    expect(cm.execCommand).not.toHaveBeenCalled()
  })
})

describe('wrap-point landings disambiguate by goal column (#580)', () => {
  // Line 2 (0-based line 1) holds 100 chars wrapping into rows of 30, so the
  // wrap points sit at ch 30/60/90. coordsAtPos honors the side argument:
  // side -1 is the end of the previous row (right edge, x 240), side 1 the
  // start of the next (left edge, x 0). vim.lastHSPos is the goal x.
  const DOC = `alpha\n${'x'.repeat(100)}\nomega`

  function wrapCm(findPosVResult: { line: number; ch: number }) {
    const state = EditorState.create({ doc: DOC })
    const coordsAtPos = (offset: number, side: 1 | -1 = 1) => {
      if (offset < 6 || offset > 106) return null
      const rel = offset - 6
      const effective = side === -1 ? Math.max(0, rel - 1) : rel
      const row = Math.min(3, Math.floor(effective / 30))
      const left = side === -1 && rel % 30 === 0 && rel > 0 ? 240 : (rel % 30) * 8
      const top = 100 + row * 20
      return { left, right: left, top, bottom: top + 18 }
    }
    const findPosV = vi.fn((_start: { line: number; ch: number }) => ({ ...findPosVResult }))
    const charCoords = vi.fn((_pos: { line: number; ch: number }) => ({ left: 42 }))
    return {
      cm: {
        firstLine: () => 0,
        lastLine: () => 2,
        findPosV,
        charCoords,
        cm6: {
          state,
          coordsAtPos,
          contentDOM: { getBoundingClientRect: () => ({ left: 0 }) }
        } as unknown as EditorView
      } as unknown as Cm,
      findPosV,
      charCoords
    }
  }

  // Sticky goal columns across presses need vim.lastMotion to be this motion.
  const vimWithGoal = (lastHSPos: number): VimState =>
    ({ lastMotion: zenMoveByDisplayLine, lastHSPos }) as VimState

  it('a right-edge goal landing on a wrap point rests on the last character of the previous row', () => {
    const { cm } = wrapCm({ line: 1, ch: 60 })
    const res = zenMoveByDisplayLine(
      cm,
      { line: 1, ch: 29 },
      { forward: true, repeat: 1 },
      vimWithGoal(235)
    )
    expect(res).toEqual({ line: 1, ch: 59 })
  })

  it('a left-edge goal landing on a wrap point keeps the start of the next row', () => {
    const { cm } = wrapCm({ line: 1, ch: 60 })
    const res = zenMoveByDisplayLine(
      cm,
      { line: 1, ch: 30 },
      { forward: true, repeat: 1 },
      vimWithGoal(2)
    )
    expect(res).toEqual({ line: 1, ch: 60 })
  })

  it('mid-row landings are untouched either way', () => {
    const { cm } = wrapCm({ line: 1, ch: 45 })
    const res = zenMoveByDisplayLine(
      cm,
      { line: 1, ch: 15 },
      { forward: true, repeat: 1 },
      vimWithGoal(235)
    )
    expect(res).toEqual({ line: 1, ch: 45 })
  })

  it('line starts and ends are not wrap points', () => {
    const { cm } = wrapCm({ line: 2, ch: 0 })
    const res = zenMoveByDisplayLine(
      cm,
      { line: 1, ch: 100 },
      { forward: true, repeat: 1 },
      vimWithGoal(235)
    )
    expect(res).toEqual({ line: 2, ch: 0 })
  })
})

describe('display-row boundaries from row midpoints (#575)', () => {
  // Simulated layout: line 2 (0-based line 1) holds 100 chars wrapping into
  // rows of 30 (offsets 6-35, 36-65, 66-95, 96-106). coordsAtPos reports a
  // top per row; `jitter` adds sub-pixel noise like the fractional-scaling
  // environments where x hit-testing mislands.
  const DOC = `alpha\n${'x'.repeat(100)}\nomega`

  function boundaryCm(jitter = false) {
    const state = EditorState.create({ doc: DOC })
    const coordsAtPos = (offset: number) => {
      if (offset < 6 || offset > 106) return null
      const row = Math.min(3, Math.floor((offset - 6) / 30))
      const noise = jitter ? ((offset * 7) % 5) - 2 : 0
      const top = 100 + row * 20 + noise
      return { left: 0, right: 0, top, bottom: top + 18 }
    }
    return {
      execCommand: vi.fn(),
      getCursor: vi.fn(),
      cm6: { state, coordsAtPos } as unknown as EditorView
    }
  }

  it('$ from a row start lands on the last character of that row', () => {
    const cm = boundaryCm()
    const res = zenMoveToDisplayLineBoundary(cm, { line: 1, ch: 0 }, { forward: true, repeat: 1 })
    expect(res).toEqual({ line: 1, ch: 29 })
    expect(cm.execCommand).not.toHaveBeenCalled()
  })

  it('$ from the middle of an inner row lands on the last character of that row', () => {
    const cm = boundaryCm()
    const res = zenMoveToDisplayLineBoundary(cm, { line: 1, ch: 70 }, { forward: true, repeat: 1 })
    expect(res).toEqual({ line: 1, ch: 89 })
  })

  it('$ on the last row reaches the actual line end', () => {
    const cm = boundaryCm()
    const res = zenMoveToDisplayLineBoundary(cm, { line: 1, ch: 97 }, { forward: true, repeat: 1 })
    expect(res).toEqual({ line: 1, ch: 99 })
  })

  it('g0 lands on the first character of the current row', () => {
    const cm = boundaryCm()
    const res = zenMoveToDisplayLineBoundary(cm, { line: 1, ch: 70 }, { forward: false, repeat: 1 })
    expect(res).toEqual({ line: 1, ch: 60 })
  })

  it('sub-pixel jitter in the row coordinates changes nothing', () => {
    const cm = boundaryCm(true)
    expect(
      zenMoveToDisplayLineBoundary(cm, { line: 1, ch: 0 }, { forward: true, repeat: 1 })
    ).toEqual({ line: 1, ch: 29 })
    expect(
      zenMoveToDisplayLineBoundary(cm, { line: 1, ch: 97 }, { forward: true, repeat: 1 })
    ).toEqual({ line: 1, ch: 99 })
    expect(
      zenMoveToDisplayLineBoundary(cm, { line: 1, ch: 70 }, { forward: false, repeat: 1 })
    ).toEqual({ line: 1, ch: 60 })
  })

  it('falls back to the LOGICAL line end when coordinates are unavailable (#582)', () => {
    // goLineRight would resolve the rightmost visible glyph, which live
    // preview's hidden closing tokens pull short of the real end; plain
    // Vim's logical $ is the safe degradation.
    const state = EditorState.create({ doc: DOC })
    const cm = {
      execCommand: vi.fn(),
      getCursor: vi.fn(),
      cm6: { state, coordsAtPos: () => null } as unknown as EditorView
    }
    const res = zenMoveToDisplayLineBoundary(cm, { line: 1, ch: 0 }, { forward: true, repeat: 1 })
    expect(cm.execCommand).not.toHaveBeenCalled()
    expect(res).toEqual({ line: 1, ch: Infinity })
  })

  it('a taller inline chip on the row does not read as a wrap (#582)', () => {
    // The line-end coords sit lower and taller (a rendered wikilink chip)
    // but still overlap the text row; $ must reach the line end, not stop
    // at an imaginary wrap before the chip.
    const state = EditorState.create({ doc: 'alpha\nnote [[wikilink]]\nomega' })
    const line = { from: 6, to: 23 }
    const coordsAtPos = (offset: number) => {
      if (offset < line.from || offset > line.to) return null
      // Text glyphs: top 100..118 (midpoint 109). The trailing chip region:
      // top 106..134 (midpoint 120), a skew past the old half-row midpoint
      // tolerance, yet clearly overlapping the same visual row.
      const inChip = offset >= 11
      const top = inChip ? 106 : 100
      const bottom = inChip ? 134 : 118
      return { left: (offset - line.from) * 8, right: 0, top, bottom }
    }
    const cm = {
      execCommand: vi.fn(),
      getCursor: vi.fn(),
      cm6: { state, coordsAtPos } as unknown as EditorView
    }
    const res = zenMoveToDisplayLineBoundary(cm, { line: 1, ch: 0 }, { forward: true, repeat: 1 })
    expect(cm.execCommand).not.toHaveBeenCalled()
    expect(res).toEqual({ line: 1, ch: 16 }) // line length 17, $ rests ON the last char
  })
})

describe('repeatable viewport H/L (#513)', () => {
  function viewportCm() {
    return {
      firstLine: () => 0,
      lastLine: () => 99,
      getScrollInfo: () => ({ top: 100, clientHeight: 220 }),
      coordsChar: ({ top }: { top: number }) =>
        top < 200 ? { line: 10, ch: 0 } : { line: 20, ch: 0 },
      getLine: (line: number) => (line === 10 || line === 20 ? '  edge' : ' next'),
      findPosV: (
        start: { line: number; ch: number },
        amount: number
      ): { line: number; ch: number } => ({ line: start.line + amount, ch: start.ch })
    }
  }

  it('H first reaches the top visible line', () => {
    expect(
      zenMoveToViewportEdge(viewportCm(), { line: 15, ch: 4 }, { forward: false, repeat: 1 })
    ).toEqual({ line: 10, ch: 2 })
  })

  it('a second H steps above the edge so the viewport keeps scrolling', () => {
    expect(
      zenMoveToViewportEdge(viewportCm(), { line: 10, ch: 2 }, { forward: false, repeat: 1 })
    ).toEqual({ line: 9, ch: 1 })
  })

  it('a second L steps below the edge so the viewport keeps scrolling', () => {
    expect(
      zenMoveToViewportEdge(viewportCm(), { line: 20, ch: 2 }, { forward: true, repeat: 1 })
    ).toEqual({ line: 21, ch: 1 })
  })
})
