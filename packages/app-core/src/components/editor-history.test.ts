// @vitest-environment jsdom
//
// Guards #247: undoing after a note switch must not revert to (and then save)
// the previously viewed note. EditorPane keeps history() in a compartment, marks
// the programmatic doc swap non-undoable, and resets history on a path change.
// This exercises that exact CodeMirror sequence in isolation.

import { Compartment, EditorState, Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { history, undo } from '@codemirror/commands'
import { afterEach, describe, expect, it } from 'vitest'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

function makeView(doc: string): { view: EditorView; historyCompartment: Compartment } {
  const historyCompartment = new Compartment()
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc, extensions: [historyCompartment.of(history())] })
  })
  cleanups.push(() => {
    view.destroy()
    parent.remove()
  })
  return { view, historyCompartment }
}

/** The note-switch sequence EditorPane runs: non-undoable swap, then reset history. */
function switchNote(view: EditorView, historyCompartment: Compartment, body: string): void {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: body },
    annotations: [Transaction.addToHistory.of(false)]
  })
  view.dispatch({ effects: historyCompartment.reconfigure([]) })
  view.dispatch({ effects: historyCompartment.reconfigure(history()) })
}

describe('editor undo history is scoped per note (#247)', () => {
  it('does not undo across a note switch', () => {
    const { view, historyCompartment } = makeView('Note A')
    view.dispatch({ changes: { from: view.state.doc.length, insert: ' edited' } })
    expect(view.state.doc.toString()).toBe('Note A edited')

    switchNote(view, historyCompartment, 'Note B')
    expect(view.state.doc.toString()).toBe('Note B')

    // Cmd+Z must be a no-op here, NOT revert to "Note A edited".
    undo(view)
    expect(view.state.doc.toString()).toBe('Note B')
  })

  it('still undoes edits made within the current note', () => {
    const { view, historyCompartment } = makeView('Note A')
    switchNote(view, historyCompartment, 'Note B')

    view.dispatch({ changes: { from: view.state.doc.length, insert: ' typed' } })
    expect(view.state.doc.toString()).toBe('Note B typed')

    undo(view)
    expect(view.state.doc.toString()).toBe('Note B')
  })

  it('control: plain history with an undoable swap DOES cross notes (the bug)', () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc: 'Note A', extensions: [history()] })
    })
    cleanups.push(() => {
      view.destroy()
      parent.remove()
    })
    // No addToHistory:false, no reset — exactly the pre-fix behavior.
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'Note B' } })
    undo(view)
    expect(view.state.doc.toString()).toBe('Note A') // reverts across the swap
  })
})
