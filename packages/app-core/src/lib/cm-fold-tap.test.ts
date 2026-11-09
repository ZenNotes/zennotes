// @vitest-environment jsdom
//
// A tap right of a folded heading's `…` on iOS left the caret in the next
// heading's text, so Return split that heading. The check that decides when
// to move the caret back.
import { afterEach, describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { foldedRanges, forceParsing } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { noteMarkdown } from './cm-markdown-language'
import { foldAtCursor, headingFolding } from './cm-heading-fold'
import { caretMissedFoldedBlock } from './cm-fold-tap'

const NOTE = ['# Tap test', '', '## The sidebar', 'one', 'two', '', '## Try it now', 'three'].join('\n')

const views: EditorView[] = []
afterEach(() => views.splice(0).forEach((v) => v.destroy()))

function mount(): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc: NOTE,
      selection: { anchor: NOTE.indexOf('## The sidebar') + '## The sidebar'.length },
      extensions: [noteMarkdown(), headingFolding()]
    }),
    parent: document.body
  })
  views.push(view)
  forceParsing(view, NOTE.length, 5000)
  return view
}

function foldedBlock(view: EditorView): { from: number; to: number } {
  const heading = view.state.doc.line(3)
  let to = heading.to
  foldedRanges(view.state).between(heading.from, heading.to, (_from, end) => {
    to = Math.max(to, end)
  })
  return { from: heading.from, to }
}

describe('caretMissedFoldedBlock', () => {
  it('catches a caret that landed in the next heading after a tap on a folded one', () => {
    const view = mount()
    expect(foldAtCursor(view)).toBe(true)
    const block = foldedBlock(view)
    const nextTitle = NOTE.indexOf('Try it now')
    expect(caretMissedFoldedBlock(view.state, block.from, block.to, nextTitle)).toBe(true)
  })

  it('leaves a caret on the folded line alone', () => {
    const view = mount()
    foldAtCursor(view)
    const block = foldedBlock(view)
    expect(caretMissedFoldedBlock(view.state, block.from, block.to, block.to)).toBe(false)
    expect(caretMissedFoldedBlock(view.state, block.from, block.to, block.from + 3)).toBe(false)
  })

  it('leaves a line with no fold alone', () => {
    const view = mount()
    const heading = view.state.doc.line(3)
    expect(caretMissedFoldedBlock(view.state, heading.from, heading.to, NOTE.indexOf('one'))).toBe(false)
  })
})
