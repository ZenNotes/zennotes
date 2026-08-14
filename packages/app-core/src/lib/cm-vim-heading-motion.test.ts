import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { zenMoveToHeading } from './cm-vim-heading-motion'

const DOC = [
  '---', // 1
  'title: Front matter', // 2  a `#` in here is not a heading
  'tags: [a]', // 3
  '---', // 4
  'intro paragraph', // 5
  '# One', // 6
  'body', // 7
  '```python', // 8
  '# not a heading, this is a comment', // 9
  '```', // 10
  '## Two', // 11
  'body', // 12
  'Setext heading', // 13
  '==============', // 14
  'tail' // 15
].join('\n')

function cm(doc = DOC) {
  const state = EditorState.create({ doc })
  return {
    firstLine: () => 0,
    lastLine: () => state.doc.lines - 1,
    cm6: { state } as unknown as EditorView
  }
}

// #578: `]]` / `[[` move between markdown headings, the way Vim's section
// motions move between sections and the way Zed maps the same keys.
describe('heading motion (#578)', () => {
  it(']] walks forward through the headings', () => {
    const view = cm()
    // From the intro (line 5, 0-based 4) to `# One` on line 6.
    expect(zenMoveToHeading(view, { line: 4, ch: 3 }, { forward: true })).toEqual({
      line: 5,
      ch: 0
    })
    // From `# One` to `## Two`, stepping over the fenced block between them.
    expect(zenMoveToHeading(view, { line: 5, ch: 0 }, { forward: true })).toEqual({
      line: 10,
      ch: 0
    })
  })

  it('[[ walks back the same way', () => {
    const view = cm()
    expect(zenMoveToHeading(view, { line: 11, ch: 2 }, { forward: false })).toEqual({
      line: 10,
      ch: 0
    })
    expect(zenMoveToHeading(view, { line: 10, ch: 0 }, { forward: false })).toEqual({
      line: 5,
      ch: 0
    })
  })

  it('never stops on a `#` line inside a code fence or in frontmatter', () => {
    const view = cm()
    // Line 9 is `# not a heading…` inside the fence: jumping forward from the
    // intro skips it, and nothing lands before `# One` going backward.
    expect(zenMoveToHeading(view, { line: 6, ch: 0 }, { forward: true })).toEqual({
      line: 10,
      ch: 0
    })
    expect(zenMoveToHeading(view, { line: 5, ch: 0 }, { forward: false })).toEqual({
      line: 0,
      ch: 0
    })
  })

  it('finds a setext heading by its text line, not its underline', () => {
    const view = cm()
    expect(zenMoveToHeading(view, { line: 10, ch: 0 }, { forward: true })).toEqual({
      line: 12,
      ch: 0
    })
  })

  it('takes a count, and stops at the furthest heading rather than overshooting', () => {
    const view = cm()
    expect(zenMoveToHeading(view, { line: 4, ch: 0 }, { forward: true, repeat: 2 })).toEqual({
      line: 10,
      ch: 0
    })
    expect(zenMoveToHeading(view, { line: 4, ch: 0 }, { forward: true, repeat: 99 })).toEqual({
      line: 12,
      ch: 0
    })
  })

  it('runs to the end or start of the note when no heading is left that way', () => {
    const view = cm()
    // Past the last heading, like Vim's section motions.
    expect(zenMoveToHeading(view, { line: 13, ch: 0 }, { forward: true })).toEqual({
      line: 14,
      ch: 0
    })
    expect(zenMoveToHeading(view, { line: 4, ch: 0 }, { forward: false })).toEqual({
      line: 0,
      ch: 0
    })
  })

  it('leaves the cursor alone when there is no view to measure', () => {
    const detached = { firstLine: () => 0, lastLine: () => 5 }
    expect(zenMoveToHeading(detached, { line: 2, ch: 4 }, { forward: true })).toEqual({
      line: 2,
      ch: 4
    })
  })
})
