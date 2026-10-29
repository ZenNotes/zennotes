// @vitest-environment jsdom

import { history, undo } from '@codemirror/commands'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import { removeCalloutAtCursor, removeCalloutIn, setCalloutType } from './callout-menu'
import { useToastStore } from './toast'

let views: EditorView[] = []
afterEach(() => {
  for (const view of views) view.destroy()
  views = []
  useToastStore.setState({ toasts: [] })
})

function mount(doc: string, anchor: number, head = anchor): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(anchor, head),
      extensions: [history()]
    }),
    parent: document.body.appendChild(document.createElement('div'))
  })
  views.push(view)
  return view
}

/** Type a character the way the keyboard does, so history sees typing. */
function type(view: EditorView, text: string): void {
  const at = view.state.selection.main.head
  view.dispatch({
    changes: { from: at, insert: text },
    selection: { anchor: at + text.length },
    userEvent: 'input.type'
  })
}

describe('callout actions in the editor (#1016)', () => {
  it('turns two selected lines into a warning callout, undone in one step', () => {
    const doc = 'Intro\n\nfirst line\nsecond line\n\nEnd'
    const view = mount(doc, doc.indexOf('first'), doc.indexOf('second') + 3)
    expect(setCalloutType(view, view.state.selection.main, 'warning')).toBe(true)
    expect(view.state.doc.toString()).toBe('Intro\n\n> [!warning]\n> first line\n> second line\n\nEnd')
    const { from, to } = view.state.selection.main
    expect(view.state.sliceDoc(from, to)).toBe('first line\n> sec')
    undo(view)
    expect(view.state.doc.toString()).toBe(doc)
  })

  it('keeps the change apart from typing just before it, for Undo', () => {
    const view = mount('word', 4)
    type(view, 's')
    setCalloutType(view, view.state.selection.main, 'tip')
    expect(view.state.doc.toString()).toBe('> [!tip]\n> words')
    undo(view)
    expect(view.state.doc.toString()).toBe('words')
  })

  it('changes the type of the callout at the caret, keeping its title', () => {
    const doc = '> [!warning]- Careful\n> body'
    const view = mount(doc, doc.indexOf('body'))
    setCalloutType(view, view.state.selection.main, 'tip')
    expect(view.state.doc.toString()).toBe('> [!tip]- Careful\n> body')
    expect(view.state.sliceDoc(view.state.selection.main.head)).toBe('body')
  })

  it('changes the callout a range names, wherever the caret is', () => {
    const doc = 'top line\n\n> [!note]\n> body'
    const view = mount(doc, 0)
    const at = doc.indexOf('body')
    setCalloutType(view, { from: at, to: at }, 'bug')
    expect(view.state.doc.toString()).toBe('top line\n\n> [!bug]\n> body')
    expect(view.state.selection.main.head).toBe(0)
  })

  it('refuses a caret in a code block and leaves the note alone', () => {
    const doc = '```\ncode\n```'
    const view = mount(doc, doc.indexOf('code'))
    expect(setCalloutType(view, view.state.selection.main, 'note')).toBe(false)
    expect(view.state.doc.toString()).toBe(doc)
  })

  it('removes the callout, undone in one step', () => {
    const doc = '> [!tip] Title\n> body'
    const view = mount(doc, doc.indexOf('body'))
    expect(removeCalloutIn(view, view.state.selection.main)).toBe(true)
    expect(view.state.doc.toString()).toBe('Title\nbody')
    undo(view)
    expect(view.state.doc.toString()).toBe(doc)
  })

  it('says so when Remove Callout runs outside a callout', () => {
    const view = mount('plain', 1)
    removeCalloutAtCursor(view)
    expect(view.state.doc.toString()).toBe('plain')
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
      'The cursor is not in a callout.'
    ])
  })
})
