// @vitest-environment jsdom

import { indentMore } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { forceParsing, HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  listGuideStyle,
  listIndentPadCh,
  listPrefixCells,
  markdownListHangingIndentCh,
  markdownListIndentPlugin
} from './cm-markdown-list-indent'

describe('markdownListHangingIndentCh', () => {
  it('aligns wrapped unordered and ordered list text after the marker', () => {
    expect(markdownListHangingIndentCh('- item')).toBe(2)
    expect(markdownListHangingIndentCh('  - nested item')).toBe(4)
    expect(markdownListHangingIndentCh('10. ordered item')).toBe(4)
  })

  it('includes task markers in the hanging indent', () => {
    expect(markdownListHangingIndentCh('- [ ] task item')).toBe(6)
    expect(markdownListHangingIndentCh('  - [x] nested task')).toBe(8)
  })

  it('can align list items after a parsed markdown prefix', () => {
    expect(markdownListHangingIndentCh('> - quoted item', 2)).toBe(4)
  })

  it('does not treat paragraphs or horizontal rules as list items', () => {
    expect(markdownListHangingIndentCh('plain paragraph')).toBeNull()
    expect(markdownListHangingIndentCh('---')).toBeNull()
  })
})

describe('tab width aware hanging indent (#491)', () => {
  it('measures tab-indented markers with the configured width', () => {
    expect(markdownListHangingIndentCh('\t- item', 0, 4)).toBe(6)
    expect(markdownListHangingIndentCh('\t- item', 0, 8)).toBe(10)
  })
})

describe('listIndentPadCh (#491)', () => {
  it('widens shallow source indents to depth * width', () => {
    // 2-space source at depth 2, width 4: marker sits at 2, wants 4.
    expect(listIndentPadCh('  - item', 2, 2, 4)).toBe(2)
    // depth 3 at 4 source columns, width 4: wants 8.
    expect(listIndentPadCh('    - item', 4, 3, 4)).toBe(4)
  })

  it('never shifts top-level lines or already-wide sources', () => {
    expect(listIndentPadCh('- item', 0, 1, 4)).toBe(0)
    expect(listIndentPadCh('    - item', 4, 2, 4)).toBe(0)
    expect(listIndentPadCh('        - deep', 8, 2, 4)).toBe(0)
  })

  it('follows the configured width', () => {
    expect(listIndentPadCh('  - item', 2, 2, 8)).toBe(6)
    expect(listIndentPadCh('  - item', 2, 2, 2)).toBe(0)
  })
})

describe('listGuideStyle (#491)', () => {
  it('is empty for top-level lines', () => {
    expect(listGuideStyle(1, 4)).toBe('')
  })

  it('draws one layer per ancestor level at the level column', () => {
    const style = listGuideStyle(3, 4)
    expect(style).toContain('background-position: calc(0ch + 0.45ch) 0, calc(4ch + 0.45ch) 0')
    expect(style.match(/linear-gradient/g)).toHaveLength(2)
    expect(style).toContain('background-size: 1px 100%')
  })
})

describe('listPrefixCells (#952)', () => {
  it('boxes every indent and marker character to one column', () => {
    expect(listPrefixCells('- item', 0)).toEqual([1, 1])
    expect(listPrefixCells('    - item', 4)).toEqual([1, 1, 1, 1, 1, 1])
    expect(listPrefixCells('  1. item', 2)).toEqual([1, 1, 1, 1, 1])
    expect(listPrefixCells('10) item', 0)).toEqual([1, 1, 1, 1])
  })

  it('gives a tab the configured width, as the hanging indent counts it', () => {
    expect(listPrefixCells('\t- item', 1, 4)).toEqual([4, 1, 1])
    expect(listPrefixCells(' \t* item', 2, 8)).toEqual([1, 8, 1, 1])
  })

  it('adds up to the hanging indent, so the first line meets the wrapped ones', () => {
    for (const [text, offset] of [['- a', 0], ['      + b', 6], ['\t\t3. c', 2], ['  -   spaced', 2]] as const) {
      const cells = listPrefixCells(text, offset, 4) ?? []
      expect(cells.reduce((a, b) => a + b, 0)).toBe(markdownListHangingIndentCh(text, offset, 4))
    }
  })

  it('boxes only the indent of a task, whose marker renders as a checkbox', () => {
    expect(listPrefixCells('- [ ] task', 0)).toEqual([])
    expect(listPrefixCells('    - [x] done', 4)).toEqual([1, 1, 1, 1])
  })

  it('leaves a list inside a quote or callout alone', () => {
    expect(listPrefixCells('> - quoted', 2)).toBeNull()
    expect(listPrefixCells('>   - nested', 4)).toBeNull()
  })
})

describe('markdownListIndentPlugin', () => {
  it('redraws when only the syntax tree changes, as when a cut parse finishes', () => {
    // Swapping the language in changes the tree and nothing else: no edit, no
    // selection, no viewport. A parse that finishes after its time budget ran
    // out reaches the plugin the same way.
    const language = new Compartment()
    const doc = '- one\n  - two\n\nplain'
    const parent = document.createElement('div')
    document.body.append(parent)
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc, extensions: [language.of([]), markdownListIndentPlugin] })
    })
    expect(view.dom.querySelector('.cm-markdown-list-line')).toBeNull()
    view.dispatch({ effects: language.reconfigure(markdown({ base: markdownLanguage })) })
    forceParsing(view, doc.length, 5000)
    const lines = Array.from(view.dom.querySelectorAll('.cm-markdown-list-line'))
    expect(lines.map((line) => line.textContent)).toEqual(['- one', '  - two'])
    view.destroy()
    parent.remove()
  })
})

describe('the caret after Tab nests an empty task (#1012)', () => {
  // The editor's own token classes: the redraw that moves the caret's node
  // depends on the list spans they produce around the marker.
  const tokens = HighlightStyle.define([
    { tag: tags.list, class: 'tok-list' },
    { tag: tags.meta, class: 'tok-meta' },
    { tag: tags.atom, class: 'tok-atom' }
  ])
  let view: EditorView | null = null

  function mountFocused(doc: string): EditorView {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const parent = document.createElement('div')
    document.body.append(parent)
    view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        selection: { anchor: doc.length },
        extensions: [
          markdown({ base: markdownLanguage }),
          syntaxHighlighting(tokens),
          indentUnit.of('    '),
          markdownListIndentPlugin
        ]
      })
    })
    forceParsing(view, doc.length, 5000)
    view.focus()
    return view
  }

  afterEach(() => {
    view?.destroy()
    view = null
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('sets the DOM caret again where the page reports it, so typing lands after the marker', () => {
    const editor = mountFocused('- [ ] parent\n- [ ] ')
    const selection = document.getSelection()!
    const caretNode = selection.focusNode!
    expect(caretNode.textContent).toBe(' ')
    const collapse = vi.spyOn(selection, 'collapse')

    indentMore(editor)

    expect(editor.state.doc.toString()).toBe('- [ ] parent\n    - [ ] ')
    // The redraw reused the caret's node for an indent cell, and the page now
    // reports the line's end, which CodeMirror accepts without setting it.
    expect(caretNode.isConnected).toBe(true)
    expect((caretNode.parentNode as Element).closest('.cm-list-prefix-cell')).not.toBeNull()
    expect(selection.focusNode).not.toBe(caretNode)
    expect(editor.posAtDOM(selection.focusNode!, selection.focusOffset)).toBe(editor.state.doc.length)
    // So the plugin sets it, on that same reported place.
    expect(collapse).toHaveBeenCalledTimes(1)
    expect(collapse).toHaveBeenCalledWith(selection.focusNode, selection.focusOffset)
  })

  it('leaves the DOM caret alone when an edit keeps it in its node', () => {
    // A caret on the parent line while a nested task changes below it, the
    // way most edits leave the caret: no extra selection write per change.
    const editor = mountFocused('- [ ] parent\n    - [ ] x')
    editor.dispatch({ selection: { anchor: '- [ ] parent'.length } })
    const selection = document.getSelection()!
    const caretNode = selection.focusNode
    const collapse = vi.spyOn(selection, 'collapse')

    editor.dispatch({ changes: { from: editor.state.doc.length, insert: 'y' }, userEvent: 'input.type' })

    expect(editor.state.doc.toString()).toBe('- [ ] parent\n    - [ ] xy')
    expect(selection.focusNode).toBe(caretNode)
    expect(collapse).not.toHaveBeenCalled()
  })
})
