// @vitest-environment jsdom

import { history } from '@codemirror/commands'
import { search } from '@codemirror/search'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorCommand } from './editor'

const views: EditorView[] = []

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  Object.defineProperty(window, 'zen', {
    configurable: true,
    value: { getCapabilities: () => ({}) }
  })
})

afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
  document.body.replaceChildren()
})

async function setup(body = 'hello', anchor = 0, head = body.length, readOnly = false) {
  const { useStore } = await import('./store')
  const api = await import('./editor')
  const { registerNoteEditor } = await import('./lib/note-editor-context')
  let path = 'one.md'
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: body,
      selection: EditorSelection.single(anchor, head),
      extensions: [
        history(),
        search({ top: true }),
        EditorState.readOnly.of(readOnly),
        EditorState.allowMultipleSelections.of(true)
      ]
    })
  })
  views.push(view)
  registerNoteEditor(view, () => path, useStore.getState().activePaneId)
  useStore.setState({
    vault: { root: '/test-vault', name: 'Test' },
    selectedPath: path,
    editorViewRef: view,
    activeNote: { path, body } as NonNullable<ReturnType<typeof useStore.getState>['activeNote']>
  })
  return {
    ...api,
    useStore,
    view,
    setViewPath: (next: string) => {
      path = next
    }
  }
}

describe('public editor commands', () => {
  for (const [command, marker] of [
    ['toggle-bold', '**'],
    ['toggle-italic', '*'],
    ['toggle-strikethrough', '~~'],
    ['toggle-highlight', '=='],
    ['toggle-inline-code', '`']
  ] as const) {
    it(`${command} wraps and unwraps the selection`, async () => {
      const s = await setup()
      expect(s.runEditorCommand(command)).toBe(true)
      expect(s.view.state.doc.toString()).toBe(`${marker}hello${marker}`)
      expect(
        s.view.state.sliceDoc(s.view.state.selection.main.from, s.view.state.selection.main.to)
      ).toBe('hello')
      expect(s.view.hasFocus).toBe(true)
      expect(s.runEditorCommand(command)).toBe(true)
      expect(s.view.state.doc.toString()).toBe('hello')
    })
  }

  it('inserts an empty inline pair and exits formatting after text is entered', async () => {
    const s = await setup('', 0, 0)
    s.runEditorCommand('toggle-bold')
    expect(s.view.state.doc.toString()).toBe('****')
    expect(s.view.state.selection.main.head).toBe(2)
    s.view.dispatch({ changes: { from: 2, insert: 'word' }, selection: { anchor: 6 } })
    s.runEditorCommand('toggle-bold')
    expect(s.view.state.doc.toString()).toBe('**word**')
    expect(s.view.state.selection.main.head).toBe(8)
  })

  for (const [command, expected, caret] of [
    ['insert-link', '[hello]()', 8],
    ['insert-wikilink', '[[]]', 2],
    ['insert-tag', '#', 1]
  ] as const) {
    it(`${command} preserves the mobile snippet and caret behavior`, async () => {
      const s = await setup()
      expect(s.runEditorCommand(command)).toBe(true)
      expect(s.view.state.doc.toString()).toBe(expected)
      expect(s.view.state.selection.main.head).toBe(caret)
      expect(s.view.state.selection.main.empty).toBe(true)
    })
  }

  for (const [command, marker] of [
    ['set-bullet-list', '- '],
    ['set-task-list', '- [ ] '],
    ['cycle-heading', '# ']
  ] as const) {
    it(`${command} starts a block on an indented empty line`, async () => {
      const s = await setup('  ', 1, 1)
      s.runEditorCommand(command)
      expect(s.view.state.doc.toString()).toBe('  ' + marker)
      expect(s.view.state.selection.main.head).toBe(2 + marker.length)
    })
  }

  it('replaces existing block markers and preserves blank lines in a selection', async () => {
    const s = await setup('# First\n\n> Second')
    s.runEditorCommand('set-task-list')
    expect(s.view.state.doc.toString()).toBe('- [ ] First\n\n- [ ] Second')
  })

  it('cycles headings through levels one, two, three, then paragraph', async () => {
    const s = await setup('Title', 0, 0)
    for (const expected of ['# Title', '## Title', '### Title', 'Title']) {
      s.runEditorCommand('cycle-heading')
      expect(s.view.state.doc.toString()).toBe(expected)
    }
    const deep = await setup('##### Title', 0, 0)
    deep.runEditorCommand('cycle-heading')
    expect(deep.view.state.doc.toString()).toBe('Title')
    const indented = await setup('  ## Title', 0, 0)
    indented.runEditorCommand('cycle-heading')
    expect(indented.view.state.doc.toString()).toBe('  # Title')
  })

  it('indents and outdents the selected lines using the editor settings', async () => {
    const s = await setup('one\ntwo')
    s.runEditorCommand('indent')
    expect(s.view.state.doc.toString()).toBe('  one\n  two')
    s.runEditorCommand('outdent')
    expect(s.view.state.doc.toString()).toBe('one\ntwo')
  })

  it('uses the normal editor undo and redo history', async () => {
    const s = await setup()
    expect(s.runEditorCommand('undo')).toBe(false)
    expect(s.view.hasFocus).toBe(true)
    s.runEditorCommand('toggle-bold')
    expect(s.runEditorCommand('undo')).toBe(true)
    expect(s.view.state.doc.toString()).toBe('hello')
    expect(s.runEditorCommand('redo')).toBe(true)
    expect(s.view.state.doc.toString()).toBe('**hello**')
  })

  it('seeds Find from the selection and focuses its existing field on reopening', async () => {
    const s = await setup()
    expect(s.runEditorCommand('open-search')).toBe(true)
    const field = document.querySelector<HTMLInputElement>('.cm-search [main-field]')!
    expect(field.value).toBe('hello')
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 5])
    // jsdom's input.select() does not focus on initial mount. The browser smoke
    // covers that native behavior; reopening explicitly focuses the same field.
    s.view.focus()
    expect(s.runEditorCommand('open-search')).toBe(true)
    expect(document.activeElement?.closest('.cm-search')).not.toBeNull()
    expect(s.view.hasFocus).toBe(false)
    expect(s.runEditorCommand('close-search')).toBe(true)
    expect(document.querySelector('.cm-search')).toBeNull()
    expect(s.view.hasFocus).toBe(true)
    expect(s.runEditorCommand('close-search')).toBe(false)
  })

  for (const change of [
    'vault',
    'note',
    'virtual note',
    'content',
    'view',
    'pane',
    'registered path',
    'destroyed'
  ] as const) {
    it(`ignores commands when the active ${change} is unavailable or transitioning`, async () => {
      const s = await setup()
      if (change === 'vault') s.useStore.setState({ vault: null })
      if (change === 'note') s.useStore.setState({ selectedPath: 'two.md' })
      if (change === 'virtual note') {
        s.setViewPath('zen://tasks')
        s.useStore.setState({
          selectedPath: 'zen://tasks',
          activeNote: { ...s.useStore.getState().activeNote!, path: 'zen://tasks' }
        })
      }
      if (change === 'content') s.useStore.setState({ activeNote: null })
      if (change === 'view') s.useStore.setState({ editorViewRef: null })
      if (change === 'pane') s.useStore.setState({ activePaneId: 'other-pane' })
      if (change === 'registered path') s.setViewPath('two.md')
      if (change === 'destroyed') s.view.destroy()
      expect(s.runEditorCommand('toggle-bold')).toBe(false)
      expect(s.runEditorCommand('open-search')).toBe(false)
      expect(s.hasEditorSelection()).toBe(false)
      expect(s.view.state.doc.toString()).toBe('hello')
    })
  }

  it('allows Find and selection inspection in a read-only editor but rejects edits', async () => {
    const s = await setup('hello', 0, 5, true)
    expect(s.runEditorCommand('toggle-bold')).toBe(false)
    expect(s.hasEditorSelection()).toBe(true)
    expect(s.runEditorCommand('open-search')).toBe(true)
    expect(s.view.state.doc.toString()).toBe('hello')
  })

  it('reports selections without returning mutable editor state', async () => {
    const s = await setup()
    expect(s.hasEditorSelection()).toBe(true)
    s.view.dispatch({ selection: { anchor: 2 } })
    expect(s.hasEditorSelection()).toBe(false)
    s.view.dispatch({
      selection: EditorSelection.create([EditorSelection.range(0, 1), EditorSelection.cursor(3)], 1)
    })
    expect(s.hasEditorSelection()).toBe(true)
  })

  it('passes multiple selections through to inline formatting and links', async () => {
    const s = await setup('one two')
    s.view.dispatch({
      selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(4, 7)])
    })
    s.runEditorCommand('toggle-bold')
    expect(s.view.state.doc.toString()).toBe('**one** **two**')
    expect(s.view.state.selection.ranges).toHaveLength(2)
    s.runEditorCommand('insert-link')
    expect(s.view.state.doc.toString()).toBe('**[one]()** **[two]()**')
    expect(s.view.state.selection.ranges).toHaveLength(2)
  })

  it('replaces only the reversed main selection for a wikilink snippet', async () => {
    const s = await setup('one two')
    s.view.dispatch({
      selection: EditorSelection.create(
        [EditorSelection.range(0, 3), EditorSelection.range(7, 4)],
        1
      )
    })
    s.runEditorCommand('insert-wikilink')
    expect(s.view.state.doc.toString()).toBe('one [[]]')
    expect(s.view.state.selection.ranges).toHaveLength(1)
    expect(s.view.state.selection.main.head).toBe(6)
  })

  it('ignores unsupported command names passed by an untyped host', async () => {
    const s = await setup()
    expect(s.runEditorCommand('dispatch' as EditorCommand)).toBe(false)
    expect(s.view.state.doc.toString()).toBe('hello')
    expect(s.view.hasFocus).toBe(false)
  })
})
