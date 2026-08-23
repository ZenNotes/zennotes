// @vitest-environment jsdom

import {
  acceptCompletion,
  autocompletion,
  completionStatus,
  CompletionContext,
  selectedCompletion,
  startCompletion
} from '@codemirror/autocomplete'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { forceParsing } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'

// The "Page" command reaches into the store on apply; nothing else does, and the
// tests below never apply Page, so a bare stub keeps the module store-free.
vi.mock('../store', () => ({ useStore: { getState: () => ({ vimMode: false }) } }))

import {
  slashCommandSource,
  templateSlashCommandSource,
  blockInsertPadding,
  tableCaretTrail
} from './cm-slash-commands'
import { tablePlugin } from './cm-table'

type Source = typeof templateSlashCommandSource

function complete(doc: string, source: Source = templateSlashCommandSource) {
  const state = EditorState.create({ doc })
  return source(new CompletionContext(state, doc.length, true))
}

function labels(doc: string, source: Source = templateSlashCommandSource): string[] {
  return (complete(doc, source)?.options ?? []).map((o) => o.displayLabel ?? o.label)
}

describe('slash command sources', () => {
  it('offers the full block menu for a slash at line start', () => {
    expect(labels('/')).toEqual(
      expect.arrayContaining([
        'Heading 1',
        'Task',
        'Bulleted list',
        'Numbered list',
        'Quote',
        'Code block',
        'Table',
        'Math block',
        'Callout',
        'Link',
        'Image'
      ])
    )
  })

  it('templateSlashCommandSource (Quick Capture) excludes the store-only "Page"', () => {
    expect(labels('/')).not.toContain('Page')
  })

  it('slashCommandSource (main editor) includes "Page"', () => {
    expect(labels('/', slashCommandSource)).toContain('Page')
  })

  it('does not trigger mid-word', () => {
    expect(complete('foo/bar')).toBeNull()
  })

  it('triggers after whitespace', () => {
    expect(complete('hello /')).not.toBeNull()
  })

  it('inserts the Task block on apply, replacing the slash', () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const view = new EditorView({ parent, state: EditorState.create({ doc: '/' }) })
    const result = templateSlashCommandSource(new CompletionContext(view.state, 1, true))
    const task = result?.options.find((o) => (o.displayLabel ?? o.label) === 'Task')
    const apply = task?.apply
    if (typeof apply !== 'function') throw new Error('expected a function apply handler')
    apply(view, task!, result!.from, view.state.doc.length)
    expect(view.state.doc.toString()).toBe('- [ ] ')
    view.destroy()
    parent.remove()
  })
})

describe('blockInsertPadding (#294 — tables become their own block)', () => {
  it('adds no padding at document start', () => {
    expect(blockInsertPadding('', '')).toEqual({ lead: '', trail: '' })
  })

  it('adds a blank line before text with no trailing newline', () => {
    expect(blockInsertPadding('Some text', '')).toEqual({ lead: '\n\n', trail: '' })
  })

  it('completes a single trailing newline into a blank line', () => {
    expect(blockInsertPadding('Some text\n', '')).toEqual({ lead: '\n', trail: '' })
  })

  it('leaves an existing blank line alone', () => {
    expect(blockInsertPadding('Some text\n\n', '')).toEqual({ lead: '', trail: '' })
  })

  it('pads before following content (and respects existing newlines)', () => {
    expect(blockInsertPadding('', 'More text')).toEqual({ lead: '', trail: '\n\n' })
    expect(blockInsertPadding('', '\nMore')).toEqual({ lead: '', trail: '\n' })
    expect(blockInsertPadding('', '\n\nMore')).toEqual({ lead: '', trail: '' })
  })

  it('pads both sides when inserted between two paragraphs', () => {
    expect(blockInsertPadding('para', 'para')).toEqual({ lead: '\n\n', trail: '\n\n' })
  })

  it('leaves a safe continuation line after a table', () => {
    expect(tableCaretTrail('')).toBe('\n\n')
    expect(tableCaretTrail('Following')).toBe('\n\n\n')
    expect(tableCaretTrail('\nFollowing')).toBe('\n\n')
    expect(tableCaretTrail('\n\nFollowing')).toBe('\n')
    expect(tableCaretTrail('\n\n\nFollowing')).toBe('')
  })
})

describe('/table insertion separates the table into its own block (#294)', () => {
  function applyTable(doc: string): string {
    const parent = document.createElement('div')
    document.body.append(parent)
    const view = new EditorView({ parent, state: EditorState.create({ doc }) })
    const result = templateSlashCommandSource(
      new CompletionContext(view.state, doc.length, true)
    )
    const table = result?.options.find((o) => (o.displayLabel ?? o.label) === 'Table')
    const apply = table?.apply
    if (typeof apply !== 'function') throw new Error('expected a Table apply handler')
    apply(view, table!, result!.from, view.state.doc.length)
    const out = view.state.doc.toString()
    view.destroy()
    parent.remove()
    return out
  }

  const TABLE = '| Column 1 | Column 2 |\n| --- | --- |\n| | |'

  // Two trailing newlines leave a blank separator before the caret line. A
  // single newline looks correct until the next text is parsed as a table row.
  it('inserts the bare table at document start', () => {
    expect(applyTable('/')).toBe(`${TABLE}\n\n`)
  })

  it('inserts a blank line before a table typed directly under a paragraph', () => {
    expect(applyTable('Some text\n/')).toBe(`Some text\n\n${TABLE}\n\n`)
  })

  it('does not double a blank line that already separates it', () => {
    expect(applyTable('Some text\n\n/')).toBe(`Some text\n\n${TABLE}\n\n`)
  })

  function applyTableCaretLine(doc: string): string {
    const parent = document.createElement('div')
    document.body.append(parent)
    const view = new EditorView({ parent, state: EditorState.create({ doc }) })
    const result = templateSlashCommandSource(new CompletionContext(view.state, doc.length, true))
    const table = result?.options.find((o) => (o.displayLabel ?? o.label) === 'Table')
    const apply = table?.apply
    if (typeof apply !== 'function') throw new Error('expected a Table apply handler')
    apply(view, table!, result!.from, view.state.doc.length)
    const line = view.state.doc.lineAt(view.state.selection.main.head)
    view.destroy()
    parent.remove()
    return line.text
  }

  it('lands the caret on the empty line after the table, not inside it (#340)', () => {
    // Every table source line contains a pipe; the landing line must not.
    const caretLine = applyTableCaretLine('/')
    expect(caretLine).toBe('')
    expect(caretLine.includes('|')).toBe(false)
  })

  it('keeps editor focus after the table widget instead of entering its first cell (#663)', async () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: '/table',
        selection: { anchor: 6 },
        extensions: [
          markdown({ base: markdownLanguage }),
          tablePlugin,
          autocompletion({
            override: [templateSlashCommandSource],
            interactionDelay: 0
          })
        ]
      })
    })
    view.focus()
    startCompletion(view)
    await vi.waitFor(() => {
      expect(completionStatus(view.state)).toBe('active')
      expect(selectedCompletion(view.state)?.displayLabel).toBe('Table')
    })
    expect(acceptCompletion(view)).toBe(true)
    forceParsing(view, view.state.doc.length, 5000)

    expect(view.state.doc.lineAt(view.state.selection.main.head).text).toBe('')
    expect(document.activeElement).toBe(view.contentDOM)

    for (const character of 'Continues below.') {
      view.dispatch(view.state.replaceSelection(character))
      forceParsing(view, view.state.doc.length, 5000)
    }
    expect(view.state.doc.toString()).toBe(
      '| Column 1 | Column 2 |\n| --- | --- |\n| | |\n\nContinues below.'
    )
    expect(view.dom.querySelectorAll('.cm-table-cell')).toHaveLength(4)
    expect(document.activeElement).toBe(view.contentDOM)

    view.destroy()
    parent.remove()
  })
})
