// @vitest-environment jsdom

import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { foldedRanges, foldService, unfoldEffect } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorView } from '@codemirror/view'
import { foldAllOutline, foldAtCursor, headingFolding, unfoldAtCursor } from './cm-heading-fold'

/** Run the heading fold service over a given line; returns its fold range. */
function foldRangeAtLine(doc: string, lineNumber: number): { from: number; to: number } | null {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage }), headingFolding()]
  })
  const line = state.doc.line(lineNumber)
  for (const svc of state.facet(foldService)) {
    const range = svc(state, line.from, line.to)
    if (range) return range
  }
  return null
}

describe('heading folding', () => {
  it('treats a real heading line as foldable', () => {
    const doc = '# Real heading\n\nbody text\nmore\n'
    expect(foldRangeAtLine(doc, 1)).not.toBeNull()
  })

  it('does NOT treat a `#` comment inside a fenced code block as a heading (#83)', () => {
    // `# This is a comment` is line 3 inside the ```bash fence.
    const doc = '```bash\n#!/bin/bash\n# This is a comment\necho "Hello"\n```\n'
    expect(foldRangeAtLine(doc, 3)).toBeNull()
  })

  it('does NOT fold a `#` line inside a plain (unlabelled) fence', () => {
    const doc = '```\n# not a heading\nplain\n```\n'
    expect(foldRangeAtLine(doc, 2)).toBeNull()
  })

  it('still folds a real heading that follows a code block', () => {
    const doc = '```\n# in code\n```\n\n# Real\n\nbody\n'
    expect(foldRangeAtLine(doc, 5)).not.toBeNull()
  })

  it('shows the heading level before a heading when labels are enabled', () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: '## Design\n\nDetails',
        extensions: [
          markdown({ base: markdownLanguage }),
          headingFolding({ showLevelLabels: true })
        ]
      })
    })

    expect(parent.querySelector('.cm-heading-level-label')?.textContent).toBe('H2')

    view.destroy()
    parent.remove()
  })

  it('keeps heading level labels out of the editor by default', () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: '# Design\n\nDetails',
        extensions: [markdown({ base: markdownLanguage }), headingFolding()]
      })
    })

    expect(parent.querySelector('.cm-heading-level-label')).toBeNull()

    view.destroy()
    parent.remove()
  })

  it('folds and unfolds the heading at the cursor through commands', () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const doc = '# Top\n\nIntro\n\n## Fold me\n\nBody\n\n## Next\n'
    const cursor = doc.indexOf('## Fold me')
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        selection: { anchor: cursor },
        extensions: [markdown({ base: markdownLanguage }), headingFolding()]
      })
    })

    expect(foldAtCursor(view)).toBe(true)
    expect(
      Array.from(parent.querySelectorAll('.cm-heading-line-folded')).some((line) =>
        line.textContent?.includes('Fold me')
      )
    ).toBe(true)
    expect(unfoldAtCursor(view)).toBe(true)
    expect(parent.querySelector('.cm-heading-line-folded')).toBeNull()

    view.destroy()
    parent.remove()
  })
})

describe('list item folding (#848)', () => {
  const doc = [
    '# Todo', // 1
    '', // 2
    '- [ ] **Task title** #tag', // 3
    '    - detail line', // 4
    '    - another detail line', // 5
    '- [ ] **Next task** #tag', // 6
    '- plain bullet', // 7
    '    1. numbered child', // 8
    '1. First step', // 9
    '    - step detail', // 10
    '2. Second step', // 11
    '', // 12
    '```', // 13
    'code', // 14
    '```', // 15
    ''
  ].join('\n')

  function mount(text: string, line: number): { view: EditorView; done: () => void } {
    const parent = document.createElement('div')
    document.body.append(parent)
    const state = EditorState.create({
      doc: text,
      extensions: [markdown({ base: markdownLanguage }), headingFolding()]
    })
    const view = new EditorView({
      parent,
      state: state.update({ selection: { anchor: state.doc.line(line).from } }).state
    })
    return {
      view,
      done: () => {
        view.destroy()
        parent.remove()
      }
    }
  }

  /** Folded ranges as [first line, last hidden line]. */
  const folds = (view: EditorView): Array<[number, number]> => {
    const out: Array<[number, number]> = []
    foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
      out.push([view.state.doc.lineAt(from).number, view.state.doc.lineAt(to).number])
    })
    return out.sort((a, b) => a[0] - b[0])
  }

  it('puts an arrow beside every item with children and none beside the rest', () => {
    const { view, done } = mount(doc, 1)
    const arrows = [...view.dom.querySelectorAll('.cm-list-fold-arrow')]
    const lines = arrows.map((arrow) => view.state.doc.lineAt(view.posAtDOM(arrow)).number)
    expect(lines).toEqual([3, 7, 9])
    done()
  })

  it('gives a hard-wrapped item with nothing under it no arrow', () => {
    const { view, done } = mount('- a long item\n  that wraps onto a second line\n- next\n', 1)
    expect(view.dom.querySelector('.cm-list-fold-arrow')).toBeNull()
    done()
  })

  it('folds from the arrow and opens again from it', () => {
    const { view, done } = mount(doc, 1)
    const arrow = () => view.dom.querySelector<HTMLElement>('.cm-list-fold-arrow')!
    arrow().click()
    expect(folds(view)).toEqual([[3, 5]])
    expect(arrow().classList.contains('is-folded')).toBe(true)
    expect(arrow().getAttribute('aria-expanded')).toBe('false')
    arrow().click()
    expect(folds(view)).toEqual([])
    done()
  })

  it('folds the list item on the cursor line, tasks, bullets and numbers alike', () => {
    for (const [line, expected] of [
      [3, [3, 5]],
      [7, [7, 8]],
      [9, [9, 10]]
    ] as const) {
      const { view, done } = mount(doc, line)
      expect(foldAtCursor(view)).toBe(true)
      expect(folds(view)).toEqual([expected])
      expect(unfoldAtCursor(view)).toBe(true)
      expect(folds(view)).toEqual([])
      done()
    }
  })

  it('from a child line, folds the item it belongs to and moves the caret to its marker', () => {
    const { view, done } = mount(doc, 4)
    expect(foldAtCursor(view)).toBe(true)
    expect(folds(view)).toEqual([[3, 5]])
    expect(view.state.selection.main.head).toBe(view.state.doc.line(3).from)
    done()
  })

  it('still folds a code block from its fence line', () => {
    const { view, done } = mount(doc, 13)
    expect(foldAtCursor(view)).toBe(true)
    expect(folds(view)).toEqual([[13, 15]])
    done()
  })

  it('folds standalone code blocks with Fold All, without needing a heading or list', () => {
    const text = '```js\nconst answer = 42\n```\n\n~~~text\nlog line\n~~~\n'
    const { view, done } = mount(text, 1)
    expect(foldAllOutline(view)).toBe(true)
    expect(folds(view)).toEqual([[1, 3], [5, 7]])
    expect(foldAllOutline(view)).toBe(false)
    expect(folds(view)).toEqual([[1, 3], [5, 7]])
    expect(view.state.doc.toString()).toBe(text)
    done()
  })

  it('folds every heading and list item, nested, so opening the heading shows the items still folded', () => {
    const { view, done } = mount(doc, 4)
    expect(foldAllOutline(view)).toBe(true)
    expect(folds(view)).toEqual([
      [1, 16],
      [3, 5],
      [7, 8],
      [9, 10],
      [13, 15]
    ])
    // The caret moved out of the hidden text, onto the heading's line.
    expect(view.state.selection.main.head).toBe(0)
    const heading = { from: view.state.doc.line(1).to, to: view.state.doc.line(16).to }
    view.dispatch({ effects: unfoldEffect.of(heading) })
    expect(folds(view)).toEqual([
      [3, 5],
      [7, 8],
      [9, 10],
      [13, 15]
    ])
    done()
  })
})
