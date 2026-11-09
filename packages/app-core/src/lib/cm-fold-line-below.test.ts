// @vitest-environment jsdom
//
// #1066: a line opened below a folded line goes below the fold, so the fold
// stays on its own line and keeps covering exactly what it covered.
import { afterEach, describe, expect, it } from 'vitest'
import { EditorState, type Extension } from '@codemirror/state'
import { foldedRanges, forceParsing } from '@codemirror/language'
import { EditorView, keymap } from '@codemirror/view'
import { undo, history, historyKeymap } from '@codemirror/commands'
import { vim } from '@replit/codemirror-vim'
import { noteMarkdown } from './cm-markdown-language'
import { foldAtCursor, headingFolding } from './cm-heading-fold'
import { vimAwareDefaultKeymap, vimAwareMarkdownKeymap } from './cm-vim-default-keymap'
import { registerOpenLineContinuation } from './cm-vim-open-line'
import { installSystemClipboardRegisters } from './cm-vim-clipboard'

const NOTE = [
  '# Fold test', // 1
  '', // 2
  '### example', // 3
  'alpha line', // 4
  'beta line', // 5
  '', // 6
  '### next', // 7
  'gamma' // 8
].join('\n')

const views: EditorView[] = []
afterEach(() => views.splice(0).forEach((v) => v.destroy()))

function mount(doc: string, lineText: string, extra: Extension[] = []): EditorView {
  const lines = doc.split('\n')
  const at = lines.indexOf(lineText)
  if (at < 0) throw new Error(`no line ${JSON.stringify(lineText)}`)
  const lineEnd = lines.slice(0, at + 1).reduce((n, line) => n + line.length + 1, 0) - 1
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: lineEnd },
      extensions: [...extra, noteMarkdown(), history(), headingFolding()]
    }),
    parent: document.body
  })
  views.push(view)
  forceParsing(view, doc.length, 5000)
  return view
}

/** Folds on the doc as [first line, last hidden line]. */
function folds(view: EditorView): Array<[number, number]> {
  const out: Array<[number, number]> = []
  const { doc } = view.state
  foldedRanges(view.state).between(0, doc.length, (from, to) => {
    out.push([doc.lineAt(from).number, doc.lineAt(to).number])
  })
  return out
}

function lineText(view: EditorView, n: number): string {
  return view.state.doc.line(n).text
}

function caretLine(view: EditorView): number {
  return view.state.doc.lineAt(view.state.selection.main.head).number
}

function insert(view: EditorView, from: number, text: string, userEvent?: string, caret?: number): void {
  view.dispatch({
    changes: { from, insert: text },
    ...(caret !== undefined ? { selection: { anchor: caret } } : {}),
    ...(userEvent ? { userEvent } : {})
  })
}

function foldExample(view: EditorView): number {
  expect(foldAtCursor(view)).toBe(true)
  expect(folds(view)).toEqual([[3, 6]])
  return view.state.doc.line(3).to
}

describe('typing and pasting at a fold (#1066)', () => {
  it('puts a pasted block that starts with a line break below the folded section', () => {
    const view = mount(NOTE, '### example')
    const at = foldExample(view)
    insert(view, at, '\n### pasted\n- [ ] item', 'input.paste')
    expect(view.state.doc.toString()).toBe(
      [
        '# Fold test',
        '',
        '### example',
        'alpha line',
        'beta line',
        '',
        '### pasted',
        '- [ ] item',
        '### next',
        'gamma'
      ].join('\n')
    )
    // The fold still starts on the heading and hides only its own section.
    expect(folds(view)).toEqual([[3, 6]])
    expect(view.dom.querySelector('.cm-heading-line-folded')?.textContent).toContain('example')
  })

  it('opens the line Enter makes at the end of a folded heading below the fold', () => {
    const view = mount(NOTE, '### example')
    const at = foldExample(view)
    insert(view, at, '\n', 'input', at + 1)
    expect(folds(view)).toEqual([[3, 6]])
    expect(caretLine(view)).toBe(7)
    expect(lineText(view, 7)).toBe('')
    expect(lineText(view, 8)).toBe('### next')
    insert(view, view.state.selection.main.head, 'typed', 'input.type', view.state.selection.main.head + 5)
    expect(lineText(view, 7)).toBe('typed')
    expect(folds(view)).toEqual([[3, 6]])
    // The typed line joined the heading's section; the heading still shows
    // folded, and its arrow opens all of it.
    const row = view.dom.querySelector<HTMLElement>('.cm-heading-line-folded')
    expect(row?.textContent).toContain('example')
    row?.querySelector<HTMLElement>('.cm-heading-fold-arrow')?.click()
    expect(folds(view)).toEqual([])
  })

  it('undoes the moved text in one step and keeps the fold', () => {
    const view = mount(NOTE, '### example')
    const at = foldExample(view)
    insert(view, at, '\nmoved', 'input.paste')
    expect(lineText(view, 7)).toBe('moved')
    undo(view)
    expect(view.state.doc.toString()).toBe(NOTE)
    expect(folds(view)).toEqual([[3, 6]])
  })

  it('leaves a change that is not typed or pasted where it was made', () => {
    // A file reload or a workflow write must land exactly where it was made.
    const view = mount(NOTE, '### example')
    const at = foldExample(view)
    insert(view, at, '\nfrom disk')
    expect(lineText(view, 4)).toBe('from disk')
  })

  it('leaves text pasted on the line below the fold alone', () => {
    const view = mount(NOTE, '### example')
    foldExample(view)
    const below = view.state.doc.line(7).from
    insert(view, below, '- [ ] item\n', 'input.paste')
    expect(lineText(view, 7)).toBe('- [ ] item')
    expect(folds(view)).toEqual([[3, 6]])
  })

  it('leaves text inserted at the end of the folded section alone', () => {
    const view = mount(NOTE, '### example')
    const at = foldExample(view)
    const end = view.state.doc.line(6).to
    insert(view, end, '\nafter', 'input.paste')
    expect(view.state.doc.line(3).to).toBe(at)
    expect(lineText(view, 7)).toBe('after')
    expect(folds(view)).toEqual([[3, 6]])
  })

  it('keeps the fold when whole lines are pasted above the heading', () => {
    const view = mount(NOTE, '### example')
    foldExample(view)
    insert(view, view.state.doc.line(3).from, 'above\n', 'input.paste')
    expect(lineText(view, 3)).toBe('above')
    expect(folds(view)).toEqual([[4, 7]])
  })

  it('opens the fold when multi-line text is pasted onto the end of the heading line', () => {
    // The heading line itself changes, so the fold has no line to stay on.
    const view = mount(NOTE, '### example')
    const at = foldExample(view)
    insert(view, at, ' more\n- [ ] item', 'input.paste')
    expect(folds(view)).toEqual([])
    expect(lineText(view, 3)).toBe('### example more')
    expect(lineText(view, 4)).toBe('- [ ] item')
  })

  it('opens the fold when Enter splits the folded heading line', () => {
    const view = mount(NOTE, '### example')
    foldExample(view)
    const mid = view.state.doc.line(3).from + 7
    insert(view, mid, '\n', 'input', mid + 1)
    expect(folds(view)).toEqual([])
  })

  it('leaves a paste at the end of an open heading where it was made', () => {
    const view = mount(NOTE, '### next')
    const at = view.state.doc.line(7).to
    insert(view, at, '\nunder next', 'input.paste')
    expect(lineText(view, 8)).toBe('under next')
  })

  it('puts a line opened at a folded list item after its children', () => {
    const doc = ['- [ ] parent', '    - child one', '    - child two', '- [ ] sibling'].join('\n')
    const view = mount(doc, '- [ ] parent')
    expect(foldAtCursor(view)).toBe(true)
    expect(folds(view)).toEqual([[1, 3]])
    const at = view.state.doc.line(1).to
    insert(view, at, '\n- [ ] ', 'input', at + 7)
    expect(view.state.doc.toString()).toBe(
      ['- [ ] parent', '    - child one', '    - child two', '- [ ] ', '- [ ] sibling'].join('\n')
    )
    expect(caretLine(view)).toBe(4)
    expect(folds(view)).toEqual([[1, 3]])
  })
})

describe('Vim on a closed fold (#1066)', () => {
  function mountVim(doc: string, line: string): EditorView {
    registerOpenLineContinuation()
    installSystemClipboardRegisters()
    const view = mount(doc, line, [
      vim(),
      vimAwareMarkdownKeymap,
      keymap.of([...vimAwareDefaultKeymap(true), ...historyKeymap])
    ])
    view.focus()
    return view
  }

  function press(view: EditorView, ...keys: string[]): void {
    for (const key of keys) {
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    }
  }

  const DOC = `${NOTE}\n\n### pasted\n- [ ] item`

  it('p puts yanked lines below the folded section and leaves the fold closed', () => {
    const view = mountVim(DOC, '### pasted')
    press(view, 'Escape', '0', '2', 'y', 'y')
    view.dispatch({ selection: { anchor: view.state.doc.line(3).from } })
    foldExample(view)
    press(view, 'p')
    expect(view.state.doc.toString()).toBe(
      [
        '# Fold test',
        '',
        '### example',
        'alpha line',
        'beta line',
        '',
        '### pasted',
        '- [ ] item',
        '### next',
        'gamma',
        '',
        '### pasted',
        '- [ ] item'
      ].join('\n')
    )
    expect(folds(view)).toEqual([[3, 6]])
    // The cursor lands on the first pasted line, as Vim's p leaves it.
    expect(caretLine(view)).toBe(7)
  })

  it('P on a closed fold still puts above the folded line', () => {
    const view = mountVim(DOC, '### pasted')
    press(view, 'Escape', '0', 'y', 'y')
    view.dispatch({ selection: { anchor: view.state.doc.line(3).from } })
    foldExample(view)
    press(view, 'P')
    expect(lineText(view, 3)).toBe('### pasted')
    expect(lineText(view, 4)).toBe('### example')
    expect(folds(view)).toEqual([[4, 7]])
  })

  it('o opens a line below the folded section and leaves the fold closed', () => {
    const view = mountVim(NOTE, '### example')
    press(view, 'Escape')
    foldExample(view)
    press(view, 'o')
    const head = view.state.selection.main.head
    view.dispatch({ changes: { from: head, insert: 'zz' }, selection: { anchor: head + 2 }, userEvent: 'input.type' })
    press(view, 'Escape')
    expect(lineText(view, 7)).toBe('zz')
    expect(lineText(view, 8)).toBe('### next')
    expect(folds(view)).toEqual([[3, 6]])
  })

  it('o on a folded task opens its next sibling after the children', () => {
    const doc = ['- [ ] parent', '    - child one', '    - child two', '- [ ] sibling'].join('\n')
    const view = mountVim(doc, '- [ ] parent')
    press(view, 'Escape')
    expect(foldAtCursor(view)).toBe(true)
    press(view, 'o')
    const head = view.state.selection.main.head
    view.dispatch({ changes: { from: head, insert: 'new' }, selection: { anchor: head + 3 }, userEvent: 'input.type' })
    press(view, 'Escape')
    expect(view.state.doc.toString()).toBe(
      ['- [ ] parent', '    - child one', '    - child two', '- [ ] new', '- [ ] sibling'].join('\n')
    )
    expect(folds(view)).toEqual([[1, 3]])
  })

  it('p on an open heading still puts right below its line', () => {
    const view = mountVim(DOC, '### pasted')
    press(view, 'Escape', '0', 'y', 'y')
    view.dispatch({ selection: { anchor: view.state.doc.line(3).from } })
    press(view, 'p')
    expect(lineText(view, 4)).toBe('### pasted')
    expect(lineText(view, 5)).toBe('alpha line')
  })
})
