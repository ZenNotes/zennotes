// @vitest-environment jsdom

import { describe, it, expect } from 'vitest'
import { Compartment, EditorState } from '@codemirror/state'
import { foldEffect, foldedRanges, foldService, forceParsing, unfoldEffect } from '@codemirror/language'
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

  it('redraws when only the syntax tree changes, as when a cut parse finishes', () => {
    // Swapping the language in changes the tree and nothing else: no edit, no
    // selection, no viewport. A parse that finishes after its time budget ran
    // out reaches the plugin the same way.
    const language = new Compartment()
    const doc = '```bash\n# a comment\n```\n\n# Real\n\nbody'
    const parent = document.createElement('div')
    document.body.append(parent)
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc, extensions: [language.of([]), headingFolding()] })
    })
    const headingLines = (): Array<string | null> =>
      Array.from(parent.querySelectorAll('.cm-heading-line')).map((line) => line.textContent)
    // No tree yet, so nothing says the fence is code.
    expect(headingLines()).toHaveLength(2)
    view.dispatch({ effects: language.reconfigure(markdown({ base: markdownLanguage })) })
    forceParsing(view, doc.length, 5000)
    expect(headingLines()).toHaveLength(1)
    expect(headingLines()[0]).toContain('# Real')

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
    // Folds read the syntax tree, and on a cold, loaded worker the first parse
    // can run out of its time budget before it reaches the list.
    forceParsing(view, text.length, 5000)
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

describe('heading arrows', () => {
  const doc = [
    '# Shapes', // 1
    '', // 2
    'Intro', // 3
    '', // 4
    '## Empty', // 5: a heading of the same level follows
    '## Has body', // 6
    '', // 7
    'text', // 8
    '', // 9
    '### Deep', // 10
    '#### Deeper', // 11
    '##### Five', // 12
    '###### Six', // 13
    'six body', // 14
    '## Same level next', // 15
    '## Followed', // 16
    '', // 17
    '```bash', // 18
    '# comment in fence', // 19
    '## another in fence', // 20
    '```', // 21
    '', // 22
    '    # indented code', // 23
    '', // 24
    '#nospace', // 25
    '### Three then two', // 26: a higher level follows
    '## Two', // 27
    'x', // 28
    '# Second H1', // 29
    '## Last line heading' // 30
  ].join('\n')

  /** Lines each heading's fold hides, first to last. */
  const sections: Record<number, [number, number]> = {
    1: [2, 28],
    6: [7, 14],
    10: [11, 14],
    11: [12, 14],
    12: [13, 14],
    13: [14, 14],
    16: [17, 26],
    27: [28, 28],
    29: [30, 30]
  }
  const levels: Record<number, number> = { 1: 1, 6: 2, 10: 3, 11: 4, 12: 5, 13: 6, 16: 2, 27: 2, 29: 1 }

  function mount(text: string): { view: EditorView; done: () => void } {
    const parent = document.createElement('div')
    document.body.append(parent)
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: text,
        extensions: [markdown({ base: markdownLanguage }), headingFolding({ showLevelLabels: true })]
      })
    })
    // Only the tree knows the `#` lines in the fence and the indented block are code.
    forceParsing(view, text.length, 5000)
    return {
      view,
      done: () => {
        view.destroy()
        parent.remove()
      }
    }
  }

  /** `<line> <label> <arrow>` for every rendered line with any heading
   *  decoration, once its line classes and the arrow's state attributes are
   *  checked against the label and the arrow. */
  function headingRows(view: EditorView): string[] {
    const rows: string[] = []
    for (const el of view.dom.querySelectorAll<HTMLElement>('.cm-line')) {
      const arrow = el.querySelector<HTMLElement>('.cm-heading-fold-arrow')
      const label = el.querySelector('.cm-heading-level-label')
      const classes = [...el.classList].filter((name) => name.startsWith('cm-heading-line'))
      if (!arrow && !label && classes.length === 0) continue
      const folded = arrow?.classList.contains('is-folded') ?? false
      expect(arrow?.classList.contains(folded ? 'is-folded' : 'is-open')).toBe(true)
      expect(arrow?.getAttribute('aria-expanded')).toBe(String(!folded))
      expect(arrow?.getAttribute('aria-label')).toBe(folded ? 'Expand heading' : 'Collapse heading')
      expect(classes).toEqual([
        'cm-heading-line',
        `cm-heading-line-h${label?.textContent?.slice(1)}`,
        ...(folded ? ['cm-heading-line-folded'] : [])
      ])
      rows.push(`${view.state.doc.lineAt(view.posAtDOM(el)).number} ${label?.textContent} ${arrow?.textContent}`)
    }
    return rows
  }

  const foldedLines = (view: EditorView): Array<[number, number]> => {
    const out: Array<[number, number]> = []
    foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
      out.push([view.state.doc.lineAt(from).number + 1, view.state.doc.lineAt(to).number])
    })
    return out
  }

  const arrowOn = (view: EditorView, line: number): HTMLElement => {
    const arrow = [...view.dom.querySelectorAll<HTMLElement>('.cm-heading-fold-arrow')].find(
      (el) => view.state.doc.lineAt(view.posAtDOM(el)).number === line
    )
    expect(arrow).toBeDefined()
    return arrow!
  }

  const open = Object.keys(levels).map((line) => `${line} H${levels[Number(line)]} ▾`)

  it('marks only headings with a section: not one right above the same or a higher level, the last line or code', () => {
    const { view, done } = mount(doc)
    expect(headingRows(view)).toEqual(open)
    done()
  })

  it('marks a heading folded while its own section is folded, at every level', () => {
    const { view, done } = mount(doc)
    for (const [key, [first, last]] of Object.entries(sections)) {
      const line = Number(key)
      arrowOn(view, line).click()
      expect(foldedLines(view)).toEqual([[first, last]])
      expect(headingRows(view)).toEqual(
        Object.keys(levels)
          .map(Number)
          .filter((other) => other < first || other > last)
          .map((other) => `${other} H${levels[other]} ${other === line ? '▸' : '▾'}`)
      )
      arrowOn(view, line).click()
      expect(foldedLines(view)).toEqual([])
      expect(headingRows(view)).toEqual(open)
    }
    done()
  })

  it('marks a heading folded for a fold from its line that covers part of its section (#1066)', () => {
    // What a line opened below a folded section leaves: the fold stays on the
    // heading, the new line joins the section below it.
    const { view, done } = mount(doc)
    const line = (n: number) => view.state.doc.line(n)
    view.dispatch({ effects: foldEffect.of({ from: line(6).to, to: line(8).to }) })
    expect(headingRows(view)).toContain('6 H2 ▸')
    // The arrow opens it, and opens it completely.
    arrowOn(view, 6).click()
    expect(foldedLines(view)).toEqual([])
    expect(headingRows(view)).toContain('6 H2 ▾')
    // Folding again from the arrow takes the whole section.
    arrowOn(view, 6).click()
    expect(foldedLines(view)).toEqual([[7, 14]])
    arrowOn(view, 6).click()
    // zc on the heading replaces a partial fold with the whole section.
    view.dispatch({
      effects: foldEffect.of({ from: line(6).to, to: line(8).to }),
      selection: { anchor: line(6).from }
    })
    expect(foldAtCursor(view)).toBe(true)
    expect(foldedLines(view)).toEqual([[7, 14]])
    done()
  })

  it('keeps the arrow open for a fold that starts below the heading line', () => {
    const { view, done } = mount(doc)
    const line = (n: number) => view.state.doc.line(n)
    // Ends where the section of line 6 ends but starts later.
    view.dispatch({ effects: foldEffect.of({ from: line(7).to, to: line(14).to }) })
    expect(headingRows(view)).toContain('6 H2 ▾')
    done()
  })

  it('gives a heading above a trailing newline a section, the empty last line', () => {
    const { view, done } = mount('# Top\n\n## End\n')
    expect(headingRows(view)).toEqual(['1 H1 ▾', '3 H2 ▾'])
    arrowOn(view, 3).click()
    expect(foldedLines(view)).toEqual([[4, 4]])
    expect(headingRows(view)).toEqual(['1 H1 ▾', '3 H2 ▸'])
    done()
  })
})
