// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { vim } from '@replit/codemirror-vim'
import {
  autoPairBackspaceTransaction,
  autoPairExtension,
  autoPairInputTransaction,
  isInMarkdownCode
} from './cm-auto-pairs'
import { vimAwareDefaultKeymap, vimAwareMarkdownKeymap } from './cm-vim-default-keymap'

function state(doc: string, anchor = doc.length, head = anchor): EditorState {
  return EditorState.create({ doc, selection: EditorSelection.range(anchor, head) })
}

describe('autoPairInputTransaction', () => {
  it.each([
    ['(', ')'],
    ['[', ']'],
    ['{', '}']
  ])('inserts %s with its matching closer', (open, close) => {
    const next = state('').update(autoPairInputTransaction(state(''), 0, 0, open)!).state

    expect(next.doc.toString()).toBe(open + close)
    expect(next.selection.main.head).toBe(1)
  })

  it('marks the pair insert as typed input, so autocomplete activates on it (#514)', () => {
    const tr = state('').update(autoPairInputTransaction(state(''), 0, 0, '[')!)
    expect(tr.isUserEvent('input.type')).toBe(true)
  })

  it('wraps the selected text', () => {
    const current = state('note', 0, 4)
    const next = current.update(autoPairInputTransaction(current, 0, 4, '{')!).state

    expect(next.doc.toString()).toBe('{note}')
    expect(next.selection.main.from).toBe(1)
    expect(next.selection.main.to).toBe(5)
  })

  it('moves over an existing closer instead of inserting another', () => {
    const current = state('()', 1)
    const next = current.update(autoPairInputTransaction(current, 1, 1, ')')!).state

    expect(next.doc.toString()).toBe('()')
    expect(next.selection.main.head).toBe(2)
  })

  it.each(['"', "'"])('pairs %s only when quotes are enabled', (quote) => {
    const current = state('')
    expect(autoPairInputTransaction(current, 0, 0, quote)).toBeNull()

    const next = current.update(autoPairInputTransaction(current, 0, 0, quote, true)!).state
    expect(next.doc.toString()).toBe(quote + quote)
    expect(next.selection.main.head).toBe(1)
  })

  it('skips an existing generated quote and leaves contractions alone', () => {
    const quoted = state('""', 1)
    const skipped = quoted.update(autoPairInputTransaction(quoted, 1, 1, '"', true)!).state
    expect(skipped.selection.main.head).toBe(2)

    expect(autoPairInputTransaction(state('don', 3), 3, 3, "'", true)).toBeNull()
  })

  it('does not handle unrelated or multi-character input', () => {
    const current = state('')
    expect(autoPairInputTransaction(current, 0, 0, 'x')).toBeNull()
    expect(autoPairInputTransaction(current, 0, 0, '()')).toBeNull()
  })
})

describe('autoPairBackspaceTransaction', () => {
  it('removes an empty pair around the cursor', () => {
    const current = state('{}', 1)
    const next = current.update(autoPairBackspaceTransaction(current)!).state

    expect(next.doc.toString()).toBe('')
    expect(next.selection.main.head).toBe(0)
  })

  it('leaves non-empty pairs to normal backspace behavior', () => {
    expect(autoPairBackspaceTransaction(state('{x}', 1))).toBeNull()
  })

  it('removes empty quotes when quote pairing is enabled', () => {
    const current = state("''", 1)
    const next = current.update(autoPairBackspaceTransaction(current, true)!).state
    expect(next.doc.toString()).toBe('')
  })
})

describe('isInMarkdownCode', () => {
  it('identifies fenced and inline code but not Markdown prose', () => {
    const doc = 'Prose\n\n```ts\nconst fenced = \n```\n\nInline `const inline = `'
    const fresh = EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage, addKeymap: false })]
    })
    // A new state parses only within a small time budget; a slow runner can
    // hand `syntaxTree` a tree that stops before the fence. Finish the parse,
    // then take the state that carries the finished tree.
    ensureSyntaxTree(fresh, doc.length, 5_000)
    const current = fresh.update({}).state

    expect(isInMarkdownCode(current, 2)).toBe(false)
    expect(isInMarkdownCode(current, doc.indexOf('const fenced') + 'const fenced = '.length)).toBe(true)
    expect(isInMarkdownCode(current, doc.indexOf('const inline') + 'const inline = '.length)).toBe(true)
  })
})

describe('disabled auto pairs', () => {
  const views: EditorView[] = []
  afterEach(() => views.splice(0).forEach((view) => view.destroy()))

  function mount(withDisabledAutoPairs: boolean): EditorView {
    const view = new EditorView({
      state: EditorState.create({
        doc: '{',
        selection: { anchor: 1 },
        extensions: [
          vim(),
          markdown({ base: markdownLanguage, addKeymap: false }),
          vimAwareMarkdownKeymap,
          ...(withDisabledAutoPairs ? [autoPairExtension({ shouldHandle: () => false })] : []),
          keymap.of([...vimAwareDefaultKeymap(true)])
        ]
      }),
      parent: document.body
    })
    views.push(view)
    view.focus()
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'i', keyCode: 73, bubbles: true, cancelable: true })
    )
    return view
  }

  function pressEnter(view: EditorView): void {
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true })
    )
  }

  it('leaves Enter behavior unchanged from the editor without the extension', () => {
    const baseline = mount(false)
    const disabled = mount(true)

    pressEnter(baseline)
    pressEnter(disabled)

    expect(baseline.state.doc.toString()).toBe('{\n')
    expect(disabled.state.doc.toString()).toBe(baseline.state.doc.toString())
    expect(disabled.state.selection.main.head).toBe(baseline.state.selection.main.head)
  })
})
