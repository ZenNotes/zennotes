// @vitest-environment jsdom

import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { forceParsing } from '@codemirror/language'
import { history } from '@codemirror/commands'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { DatabaseDoc } from '@shared/databases'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tablePlugin } from './cm-table'
import { closeTableContextMenu, openTableContextMenu } from './cm-table-menu'
import { parseTable } from './markdown-table'
import { registerNoteEditor } from './note-editor-context'
import { getPromptRequest, settlePromptRequest } from './prompt-requests'
import {
  convertTableToDatabase,
  defaultDatabaseTitle,
  headingAbove,
  tableToSeed,
  tableUnderCursor,
  validateDatabaseTitle
} from './table-to-database'
import { useToastStore } from './toast'
import { useStore } from '../store'

const NOTE = `# Weekly plan

Some intro text.

## Roadmap

| Item | Done | Estimate |
| --- | --- | --- |
| Write spec, v1 | yes | 3 |
| Ship | no | 1 |

Closing text.`

function mount(doc: string, withWidgets: boolean): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        history(),
        ...(withWidgets ? [tablePlugin] : [])
      ]
    })
  })
  forceParsing(view, doc.length, 5000)
  // Nudge the table field so it rebuilds against the completed parse.
  view.dispatch({ changes: { from: 0, insert: ' ' } })
  view.dispatch({ changes: { from: 0, to: 1 } })
  return view
}

const tableStart = (doc: string): number => doc.indexOf('| Item')

const saved = {
  notes: useStore.getState().notes,
  activeNote: useStore.getState().activeNote,
  createDatabase: useStore.getState().createDatabase,
  openDatabase: useStore.getState().openDatabase,
  vaultSettings: useStore.getState().vaultSettings
}

afterEach(() => {
  closeTableContextMenu()
  useStore.setState(saved)
  useToastStore.setState({ toasts: [] })
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('tableUnderCursor', () => {
  it('finds the raw pipe table around the caret when tables are plain text', () => {
    const view = mount(NOTE, false)
    view.dispatch({ selection: { anchor: NOTE.indexOf('Ship') } })
    const found = tableUnderCursor(view)
    expect(found).not.toBeNull()
    expect(found!.from).toBe(tableStart(NOTE))
    expect(found!.source).toBe(
      '| Item | Done | Estimate |\n| --- | --- | --- |\n| Write spec, v1 | yes | 3 |\n| Ship | no | 1 |'
    )
    expect(found!.table.headers).toEqual(['Item', 'Done', 'Estimate'])
    view.destroy()
  })

  it('is null when the caret sits in prose next to the table', () => {
    const view = mount(NOTE, false)
    view.dispatch({ selection: { anchor: NOTE.indexOf('Closing') } })
    expect(tableUnderCursor(view)).toBeNull()
    view.destroy()
  })

  it('resolves the rendered table whose cell holds focus, even after focus moves on', () => {
    const view = mount(NOTE, true)
    // The caret is far from the table; only the widget knows which one.
    view.dispatch({ selection: { anchor: 2 } })
    const cell = view.dom.querySelector<HTMLElement>('.cm-table-cell[data-row="0"][data-col="0"]')
    expect(cell).toBeTruthy()
    cell!.focus()
    expect(tableUnderCursor(view)?.from).toBe(tableStart(NOTE))

    // Focus leaving for a modal (a palette input) keeps the memory...
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    expect(tableUnderCursor(view)?.from).toBe(tableStart(NOTE))

    // ...until the caret is back in the note text, which is then the authority.
    view.focus()
    view.contentDOM.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    expect(tableUnderCursor(view)).toBeNull()
    view.destroy()
  })
})

describe('defaultDatabaseTitle / headingAbove', () => {
  it('takes the nearest heading above the table', () => {
    const view = mount(NOTE, false)
    expect(headingAbove(view.state, tableStart(NOTE))).toBe('Roadmap')
    expect(defaultDatabaseTitle(view.state, tableStart(NOTE), 'Weekly plan')).toBe('Roadmap')
    view.destroy()
  })

  it('skips a # comment inside a fenced code block', () => {
    const doc = '## Setup\n\n```bash\n# install deps\nnpm i\n```\n\n| A |\n| --- |\n| 1 |'
    const view = mount(doc, false)
    expect(headingAbove(view.state, doc.indexOf('| A |'))).toBe('Setup')
    view.destroy()
  })

  it('falls back to "<note title> table" and strips what a link cannot carry', () => {
    const doc = '| A |\n| --- |\n| 1 |'
    const view = mount(doc, false)
    expect(defaultDatabaseTitle(view.state, 0, 'Meeting notes')).toBe('Meeting notes table')
    expect(defaultDatabaseTitle(view.state, 0, '')).toBe('Table')
    view.destroy()
    const headed = mount('## **Q3** [[Goals]] #work\n\n| A |\n| --- |', false)
    expect(defaultDatabaseTitle(headed.state, headed.state.doc.toString().indexOf('| A'), 'x')).toBe(
      'Q3 Goals work'
    )
    headed.destroy()
  })
})

describe('validateDatabaseTitle', () => {
  it('rejects names the filesystem or a [[wikilink]] cannot carry', () => {
    expect(validateDatabaseTitle('')).toMatch(/Enter a database name/)
    expect(validateDatabaseTitle('.hidden')).toMatch(/dot/)
    expect(validateDatabaseTitle('a/b')).toMatch(/\[\[link\]\]/)
    expect(validateDatabaseTitle('C# notes')).toMatch(/\[\[link\]\]/)
    expect(validateDatabaseTitle('a|b')).toMatch(/\[\[link\]\]/)
    expect(validateDatabaseTitle('Roadmap 2026')).toBeNull()
    expect(validateDatabaseTitle('Q3: goals?')).toBeNull()
  })
})

describe('tableToSeed', () => {
  it('copies headers and rows verbatim and carries column widths when present', () => {
    const table = parseTable('| A | B |\n| --- | :-: |\n| x, y | **b** |')!
    expect(tableToSeed(table)).toEqual({ headers: ['A', 'B'], rows: [['x, y', '**b**']] })
    expect(tableToSeed({ ...table, colWidths: [100, null] })).toEqual({
      headers: ['A', 'B'],
      rows: [['x, y', '**b**']],
      columnWidths: [100, null]
    })
  })
})

describe('convertTableToDatabase', () => {
  const NOTE_PATH = 'inbox/Weekly plan.md'

  function setup(doc: string, withWidgets = false) {
    const view = mount(doc, withWidgets)
    registerNoteEditor(view, () => NOTE_PATH, useStore.getState().activePaneId)
    const created: DatabaseDoc = {
      version: 1,
      path: 'inbox/Roadmap 2.base/data.csv',
      title: 'Roadmap 2',
      idFieldId: 'f-id',
      fields: [{ id: 'f-id', name: 'id', type: 'text', hidden: true }],
      views: [],
      activeViewId: 'v1',
      rows: []
    }
    const createDatabase = vi.fn(async () => created)
    const openDatabase = vi.fn(async () => {})
    useStore.setState({
      activeNote: { path: NOTE_PATH, title: 'Weekly plan', folder: 'inbox' },
      notes: [{ path: NOTE_PATH, title: 'Weekly plan', folder: 'inbox' }],
      createDatabase,
      openDatabase
    } as never)
    return { view, created, createDatabase, openDatabase }
  }

  const flush = () => new Promise((r) => setTimeout(r, 0))

  it('prompts with the heading as the name, creates the seeded database, and leaves a link', async () => {
    const { view, createDatabase, openDatabase } = setup(NOTE)
    view.dispatch({ selection: { anchor: NOTE.indexOf('Ship') } })
    const run = convertTableToDatabase(view)
    await flush()
    const prompt = getPromptRequest()
    expect(prompt).not.toBeNull()
    expect(prompt!.options.initialValue).toBe('Roadmap')
    expect(prompt!.options.description).toContain('3 columns and 2 rows')
    settlePromptRequest(prompt!, 'Roadmap')
    await run

    expect(createDatabase).toHaveBeenCalledWith('inbox', '', 'Roadmap', undefined, {
      seed: {
        headers: ['Item', 'Done', 'Estimate'],
        rows: [
          ['Write spec, v1', 'yes', '3'],
          ['Ship', 'no', '1']
        ]
      },
      open: false
    })
    // The link carries the title the vault actually gave the database.
    const text = view.state.doc.toString()
    expect(text).toBe(NOTE.replace(/\| Item[\s\S]*\| 1 \|/, '[[Roadmap 2]]'))
    expect(view.state.selection.main.head).toBe(tableStart(NOTE))
    // A normal edit: undo brings the table back.
    const { undo } = await import('@codemirror/commands')
    undo(view)
    expect(view.state.doc.toString()).toBe(NOTE)

    const toast = useToastStore.getState().toasts.at(-1)
    expect(toast?.type).toBe('success')
    expect(toast?.message).toContain('Roadmap 2')
    toast?.action?.onClick()
    expect(openDatabase).toHaveBeenCalledWith('inbox/Roadmap 2.base/data.csv')
    view.destroy()
  })

  it('converts the rendered table whose cell was focused (the widget menu and leader paths)', async () => {
    const { view, createDatabase } = setup(NOTE, true)
    const cell = view.dom.querySelector<HTMLElement>('.cm-table-cell[data-row="1"][data-col="1"]')
    cell!.focus()
    const run = convertTableToDatabase(view)
    await flush()
    settlePromptRequest(getPromptRequest()!, 'Roadmap')
    await run
    expect(createDatabase).toHaveBeenCalledTimes(1)
    expect(view.state.doc.toString()).toContain('## Roadmap\n\n[[Roadmap 2]]\n\nClosing text.')
    expect(view.dom.querySelector('.cm-table-widget')).toBeNull()
    view.destroy()
  })

  it('does nothing when the prompt is cancelled', async () => {
    const { view, createDatabase } = setup(NOTE)
    view.dispatch({ selection: { anchor: NOTE.indexOf('Ship') } })
    const run = convertTableToDatabase(view)
    await flush()
    settlePromptRequest(getPromptRequest()!, null)
    await run
    expect(createDatabase).not.toHaveBeenCalled()
    expect(view.state.doc.toString()).toBe(NOTE)
    view.destroy()
  })

  it('says so instead of guessing when the caret is not in a table', async () => {
    const { view, createDatabase } = setup(NOTE)
    view.dispatch({ selection: { anchor: NOTE.indexOf('Closing') } })
    await convertTableToDatabase(view)
    expect(getPromptRequest()).toBeNull()
    expect(createDatabase).not.toHaveBeenCalled()
    expect(useToastStore.getState().toasts.at(-1)?.message).toMatch(/Put the cursor in a table/)
    view.destroy()
  })

  it('leaves the note alone when the table moved while the prompt was up', async () => {
    const { view, createDatabase } = setup(NOTE)
    view.dispatch({ selection: { anchor: NOTE.indexOf('Ship') } })
    const run = convertTableToDatabase(view)
    await flush()
    // An external sync lands a paragraph above the table before the user confirms.
    view.dispatch({ changes: { from: 0, insert: 'Prepended line\n\n' } })
    settlePromptRequest(getPromptRequest()!, 'Roadmap')
    await run
    expect(createDatabase).toHaveBeenCalledTimes(1)
    expect(view.state.doc.toString()).toContain('| Ship | no | 1 |')
    expect(view.state.doc.toString()).not.toContain('[[Roadmap')
    expect(useToastStore.getState().toasts.at(-1)?.message).toMatch(/left in place/)
    view.destroy()
  })

  it('stops quietly when the store refused to create the database', async () => {
    const { view, createDatabase } = setup(NOTE)
    createDatabase.mockResolvedValueOnce(undefined as never)
    view.dispatch({ selection: { anchor: NOTE.indexOf('Ship') } })
    const run = convertTableToDatabase(view)
    await flush()
    settlePromptRequest(getPromptRequest()!, 'Roadmap')
    await run
    expect(view.state.doc.toString()).toBe(NOTE)
    view.destroy()
  })
})

describe('table context menu entry', () => {
  const model = parseTable('| A |\n| --- |\n| 1 |')!

  it('offers Convert to database… only when the widget wires it', () => {
    const convert = vi.fn()
    openTableContextMenu({ x: 0, y: 0, row: 0, col: 0, model, apply: () => {}, convertToDatabase: convert })
    const labels = [...document.querySelectorAll('.cm-table-menu-item')].map((b) => b.textContent)
    expect(labels.at(-1)).toBe('Convert to database…')
    ;(document.querySelectorAll<HTMLButtonElement>('.cm-table-menu-item')[labels.length - 1]).click()
    expect(convert).toHaveBeenCalledTimes(1)
    closeTableContextMenu()

    openTableContextMenu({ x: 0, y: 0, row: 0, col: 0, model, apply: () => {} })
    const plain = [...document.querySelectorAll('.cm-table-menu-item')].map((b) => b.textContent)
    expect(plain).not.toContain('Convert to database…')
  })
})
