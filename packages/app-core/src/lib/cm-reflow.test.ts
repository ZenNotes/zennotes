// @vitest-environment jsdom
//
// Reflow joins hard-wrapped paragraph lines back into one line (#676). The
// paragraph boundaries come from the Markdown syntax tree, so the cases here
// are mostly about what must NOT be joined.
import { afterEach, describe, expect, it } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { reflowParagraph } from './cm-reflow'

let view: EditorView | null = null

afterEach(() => {
  view?.destroy()
  view = null
})

function mount(doc: string, anchor: number, head = anchor): EditorView {
  view = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.range(anchor, head),
      extensions: [markdown({ base: markdownLanguage })]
    }),
    parent: document.body
  })
  return view
}

/** Offset of the first occurrence of `needle` in `doc`. */
function at(doc: string, needle: string): number {
  const index = doc.indexOf(needle)
  if (index < 0) throw new Error(`no "${needle}" in doc`)
  return index
}

describe('reflowParagraph', () => {
  it('joins the hard-wrapped lines of the paragraph under the cursor', () => {
    const doc = 'So every start runs the reconciler to\ncompletion first, synchronously, at\nboot and on any restart.\n\nNext paragraph\nstays put.'
    const v = mount(doc, at(doc, 'completion'))
    expect(reflowParagraph(v)).toBe(true)
    expect(v.state.doc.toString()).toBe(
      'So every start runs the reconciler to completion first, synchronously, at boot and on any restart.\n\nNext paragraph\nstays put.'
    )
  })

  it('keeps the cursor on the word it was on', () => {
    const doc = 'one two\nthree four'
    const v = mount(doc, at(doc, 'four'))
    reflowParagraph(v)
    expect(v.state.doc.sliceString(v.state.selection.main.head)).toBe('four')
  })

  it('returns false with nothing to join so the key falls through', () => {
    const v = mount('a single line', 3)
    expect(reflowParagraph(v)).toBe(false)
  })

  it('trims the whitespace around the joined newline to a single space', () => {
    const v = mount('ends with a space \n   starts indented', 2)
    reflowParagraph(v)
    expect(v.state.doc.toString()).toBe('ends with a space starts indented')
  })

  it('keeps an explicit hard break: two trailing spaces, a backslash, or <br>', () => {
    const doc = 'roses are red  \nviolets are blue\\\nsugar is <br>\nsweet and\nso are you'
    const v = mount(doc, at(doc, 'sugar'))
    reflowParagraph(v)
    expect(v.state.doc.toString()).toBe(
      'roses are red  \nviolets are blue\\\nsugar is <br>\nsweet and so are you'
    )
  })

  it('never joins a heading, a list item, or a table row onto its neighbour', () => {
    const doc = '# Title\nfirst line\nsecond line\n- item one\n- item two\n| a | b |\n| - | - |\n| 1 | 2 |'
    const v = mount(doc, at(doc, 'first'))
    reflowParagraph(v)
    expect(v.state.doc.toString()).toBe(
      '# Title\nfirst line second line\n- item one\n- item two\n| a | b |\n| - | - |\n| 1 | 2 |'
    )
  })

  it('joins the wrapped continuation of a list item without touching the next item', () => {
    const doc = '- an item whose text\n  wraps onto a second line\n- the next item'
    const v = mount(doc, at(doc, 'wraps'))
    reflowParagraph(v)
    expect(v.state.doc.toString()).toBe(
      '- an item whose text wraps onto a second line\n- the next item'
    )
  })

  it('joins a blockquote paragraph and swallows the repeated > marker', () => {
    const doc = '> quoted text that\n> was wrapped\n\nafter'
    const v = mount(doc, at(doc, 'wrapped'))
    reflowParagraph(v)
    expect(v.state.doc.toString()).toBe('> quoted text that was wrapped\n\nafter')
  })

  it('leaves fenced code, indented code, and $$ math blocks alone', () => {
    const doc = [
      'prose that\nwraps',
      '```\ncode line one\ncode line two\n```',
      '    indented code\n    second line',
      '$$\nx = 1\ny = 2\n$$',
      'more prose\nthat wraps'
    ].join('\n\n')
    const v = mount(doc, 0, doc.length)
    reflowParagraph(v)
    expect(v.state.doc.toString()).toBe(
      [
        'prose that wraps',
        '```\ncode line one\ncode line two\n```',
        '    indented code\n    second line',
        '$$\nx = 1\ny = 2\n$$',
        'more prose that wraps'
      ].join('\n\n')
    )
  })

  it('does nothing inside frontmatter', () => {
    const doc = '---\ntitle: Note\ntags: [a, b]\n---\n\nbody\ntext'
    const v = mount(doc, at(doc, 'tags'))
    expect(reflowParagraph(v)).toBe(false)
    expect(v.state.doc.toString()).toBe(doc)
  })

  it('with a selection, joins every paragraph the selection touches, line-wise', () => {
    const doc = 'p1 line a\np1 line b\np1 line c\n\np2 line a\np2 line b\n\np3 line a\np3 line b'
    const v = mount(doc, at(doc, 'p1 line b') + 3, at(doc, 'p2 line b') + 2)
    reflowParagraph(v)
    expect(v.state.doc.toString()).toBe(
      'p1 line a\np1 line b p1 line c\n\np2 line a p2 line b\n\np3 line a\np3 line b'
    )
  })
})
