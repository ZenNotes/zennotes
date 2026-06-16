// @vitest-environment jsdom

import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { forceParsing } from '@codemirror/language'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { codeBlockFlairPlugin } from './cm-code-block-flair'
import { codeBlockFontPlugin } from './cm-code-block-font'
import { markdownSnippetExtension } from './cm-markdown-snippets'
import { tablePlugin } from './cm-table'
import { wysiwygBlocksPlugin } from './cm-wysiwyg-blocks'

function mount(doc: string, anchor = doc.length, extensions: Extension[] = []): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [
        markdown({ base: markdownLanguage }),
        ...extensions,
        codeBlockFontPlugin,
        codeBlockFlairPlugin,
        wysiwygBlocksPlugin
      ]
    })
  })
  forceParsing(view, doc.length, 5000)
  view.dispatch({ changes: { from: doc.length, insert: ' ' } })
  view.dispatch({ changes: { from: doc.length, to: doc.length + 1 } })
  return view
}

function typeChars(view: EditorView, text: string): void {
  for (const char of text) {
    const pos = view.state.selection.main.head
    view.dispatch({
      changes: { from: pos, to: pos, insert: char },
      selection: { anchor: pos + char.length },
      userEvent: 'input.type'
    })
  }
  forceParsing(view, view.state.doc.length, 5000)
}

describe('WYSIWYG fenced code blocks', () => {
  it('does not render an unclosed fence as a code block', () => {
    const view = mount('```\n1111111111111111111111')

    expect(view.dom.querySelector('.cm-code-flair')).toBeNull()
    expect(view.dom.querySelector('.cm-code-block-line')).toBeNull()
    expect(view.dom.textContent).toContain('```')
    expect(view.dom.textContent).toContain('1111111111111111111111')

    view.destroy()
  })

  it('still renders a paired fence as a code block', () => {
    const view = mount('before\n\n```text\nconst x = 1\n```\n\nafter')

    const flair = view.dom.querySelector<HTMLElement>('.cm-code-flair')
    expect(flair?.textContent).toBe('TEXT')
    expect(flair?.dataset.copyTooltip).toBe('Copy')
    expect(view.dom.querySelectorAll('.cm-code-block-line')).toHaveLength(3)
    expect(view.dom.textContent).not.toContain('```text')
    expect(view.dom.textContent).toContain('const x = 1')

    view.destroy()
  })

  it('anchors the language flair before the opening fence text', () => {
    const view = mount('```text\nconst x = 1\n```')
    const firstLine = view.dom.querySelector('.cm-line')
    const flair = view.dom.querySelector('.cm-code-flair')

    expect(firstLine?.firstElementChild).toBe(flair)

    view.destroy()
  })

  it('keeps existing WYSIWYG rendering while a new fence is pending', () => {
    const doc = '\n| 项目 | 状态 |\n| --- | --- |\n| 编辑模式 | 对齐 |\n```ts\nconst mode = "preview"\n```'
    const view = mount(doc, 0, [markdownSnippetExtension(), tablePlugin])

    typeChars(view, '```')

    expect(view.dom.querySelector('.cm-table-widget')).toBeTruthy()
    expect(view.dom.querySelector('.cm-code-flair')?.textContent).toBe('TS')
    expect(view.dom.querySelectorAll('.cm-code-block-line')).toHaveLength(3)
    expect(view.dom.querySelectorAll('.cm-pending-code-block-line').length).toBeGreaterThan(0)
    expect(view.dom.textContent).toContain('项目')
    expect(view.dom.textContent).toContain('const mode = "preview"')

    view.destroy()
  })
})
