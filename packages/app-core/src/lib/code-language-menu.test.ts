// @vitest-environment jsdom

import { history, undo } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { forceParsing } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import { contextMenuMatchRank } from '../components/ContextMenu'
import { resolveCodeLanguage } from './cm-code-languages'
import {
  codeFenceAt,
  codeFenceText,
  codeLanguagePickerItems,
  setCodeFenceLanguage
} from './code-language-menu'

const views: EditorView[] = []

function editor(doc: string, caret = 0): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(caret),
      extensions: [history(), markdown({ base: markdownLanguage, codeLanguages: resolveCodeLanguage })]
    })
  })
  forceParsing(view, doc.length, 5000)
  views.push(view)
  return view
}

afterEach(() => {
  for (const view of views.splice(0)) {
    view.dom.parentElement?.remove()
    view.destroy()
  }
})

function setAt(view: EditorView, pos: number, tag: string | null): boolean {
  const fence = codeFenceAt(view.state, pos)
  if (!fence) throw new Error('no fence')
  return setCodeFenceLanguage(view, fence.from, tag)
}

describe('setCodeFenceLanguage', () => {
  it('writes the language after a bare fence and nothing else', () => {
    const doc = 'Intro\n\n```\nprint("hi")\n```\n\nEnd.'
    const view = editor(doc)
    expect(setAt(view, doc.indexOf('print'), 'python')).toBe(true)
    expect(view.state.doc.toString()).toBe('Intro\n\n```python\nprint("hi")\n```\n\nEnd.')
  })

  it('replaces a tilde fence language and keeps the fence length and attributes', () => {
    const doc = '~~~~~ js title="a.js"\nlet a = 1\n~~~~~'
    const view = editor(doc)
    setAt(view, doc.indexOf('let'), 'typescript')
    expect(view.state.doc.toString()).toBe('~~~~~ typescript title="a.js"\nlet a = 1\n~~~~~')
  })

  it('works on a fence in a quote, and on the last line of the note', () => {
    const quoted = '> ```\n> SELECT 1;\n> ```'
    const view = editor(quoted)
    setAt(view, quoted.indexOf('SELECT'), 'sql')
    expect(view.state.doc.toString()).toBe('> ```sql\n> SELECT 1;\n> ```')

    const last = 'Text\n\n```'
    const open = editor(last)
    setAt(open, last.length, 'go')
    expect(open.state.doc.toString()).toBe('Text\n\n```go')
  })

  it('takes the language away with Text (plain)', () => {
    const doc = '```python\nx = 1\n```'
    const view = editor(doc)
    setAt(view, doc.indexOf('x ='), null)
    expect(view.state.doc.toString()).toBe('```\nx = 1\n```')
  })

  it('is one Undo step that restores the fence exactly', () => {
    const doc = 'a\n\n```js\nconst a = 1\n```'
    const view = editor(doc, doc.indexOf('const'))
    // Typing just before, so the pick could fold into it if history let it.
    view.dispatch({ changes: { from: 0, insert: 'b' }, userEvent: 'input.type' })
    setAt(view, view.state.doc.toString().indexOf('const'), 'typescript')
    expect(view.state.doc.toString()).toBe('ba\n\n```typescript\nconst a = 1\n```')
    undo(view)
    expect(view.state.doc.toString()).toBe('ba\n\n```js\nconst a = 1\n```')
  })

  it('leaves the caret on the character it was on', () => {
    const doc = '```\nconst value = 1\n```'
    const caret = doc.indexOf('value')
    const view = editor(doc, caret)
    setAt(view, caret, 'javascript')
    const head = view.state.selection.main.head
    expect(view.state.doc.sliceString(head, head + 5)).toBe('value')
  })

  it('does nothing when the block already has the pick, or is gone', () => {
    const doc = '```go\nfunc main() {}\n```'
    const view = editor(doc)
    expect(setAt(view, 6, 'go')).toBe(false)
    expect(setCodeFenceLanguage(view, 3, 'rust')).toBe(false)
    expect(view.state.doc.toString()).toBe(doc)
  })
})

describe('codeFenceAt', () => {
  const doc = 'Para\n\n```py\nx = 1\ny = 2\n```\n\nAfter'

  it('finds the block from its fences and its body, and nothing outside', () => {
    const view = editor(doc)
    const { state } = view
    for (const pos of [doc.indexOf('```'), doc.indexOf('y = 2'), doc.lastIndexOf('```') + 3]) {
      const fence = codeFenceAt(state, pos)
      expect(fence?.language).toBe('py')
      expect(fence && codeFenceText(state, fence)).toBe('x = 1\ny = 2')
    }
    expect(codeFenceAt(state, doc.indexOf('Para'))).toBeNull()
    expect(codeFenceAt(state, doc.indexOf('After'))).toBeNull()
  })

  it('reads a quoted block without its quote markers', () => {
    const quoted = '> ```\n> a()\n> b()\n> ```'
    const view = editor(quoted)
    const fence = codeFenceAt(view.state, quoted.indexOf('b()'))
    expect(fence?.language).toBeNull()
    expect(fence && codeFenceText(view.state, fence)).toBe('a()\nb()')
  })
})

describe('codeLanguagePickerItems', () => {
  it('checks the current language, by any of its tags', () => {
    const rows = codeLanguagePickerItems('py', null)
    expect(rows.filter((row) => row.checked).map((row) => row.label)).toEqual(['Python'])
    expect(rows[0].label).toBe('Text (plain)')
  })

  it('leads an unlabeled block with its guess, then Text (plain) checked', () => {
    const rows = codeLanguagePickerItems(null, 'python')
    expect(rows[0]).toMatchObject({ label: 'Python (detected)', tag: 'python', checked: false, role: 'detected' })
    expect(rows[1]).toMatchObject({ label: 'Text (plain)', tag: null, checked: true })
  })

  it('offers no guess for a block that names its language', () => {
    expect(codeLanguagePickerItems('rust', 'python').some((row) => row.role === 'detected')).toBe(false)
  })

  it('keeps a language the list does not know, checked, so the current one shows', () => {
    const rows = codeLanguagePickerItems('mermaid', null)
    expect(rows[0]).toMatchObject({ label: 'mermaid', checked: true, role: 'current' })
    expect(rows.find((row) => row.role === 'text')?.checked).toBe(false)
  })

  it('counts text and its spellings as Text (plain)', () => {
    const rows = codeLanguagePickerItems('txt', null)
    expect(rows.find((row) => row.role === 'text')?.checked).toBe(true)
  })

  it('shows the tag a pick writes when it is not the name', () => {
    const rows = codeLanguagePickerItems(null, null)
    expect(rows.find((row) => row.label === 'C++')?.hint).toBe('cpp')
    expect(rows.find((row) => row.label === 'Python')?.hint).toBeUndefined()
  })
})

describe('the find field over the picker', () => {
  const rows = codeLanguagePickerItems(null, 'python')
  const filter = (query: string): string[] =>
    rows
      .map((row, index) => ({ row, index, rank: contextMenuMatchRank(row, query) }))
      .filter((entry) => entry.rank !== null)
      .sort((a, b) => a.rank! - b.rank! || a.index - b.index)
      .map((entry) => entry.row.label)

  it('finds a language by an alias', () => {
    expect(filter('golang')[0]).toBe('Go')
    expect(filter('yml')[0]).toBe('YAML')
    expect(filter('sh')[0]).toBe('Shell')
  })

  it('puts an exact name before names that merely contain it', () => {
    expect(filter('c')[0]).toBe('C')
    expect(filter('ts')[0]).toBe('TypeScript')
    expect(filter('java')[0]).toBe('Java')
  })

  it('keeps the detected row reachable by its language', () => {
    expect(filter('pyth').slice(0, 2)).toEqual(['Python (detected)', 'Python'])
  })

  it('finds Text (plain) by its words', () => {
    expect(filter('plain')).toContain('Text (plain)')
  })
})
