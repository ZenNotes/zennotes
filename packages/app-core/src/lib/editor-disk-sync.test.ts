// @vitest-environment jsdom
//
// #852: the file changing on disk under an open note must not leave the
// user's undo steps mapped onto text nobody in the app wrote. The editor
// applies the disk change as a minimal non-undoable change (so the caret
// stays), then starts the history clean. A peer pane or a rename rewrite,
// which arrive the same way, keep it.

import { Compartment, EditorState, Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { history, redoDepth, undo, undoDepth } from '@codemirror/commands'
import { afterEach, describe, expect, it } from 'vitest'
import { isDiskChange, resetUndoHistory } from './editor-disk-sync'
import { minimalTextChange } from './minimal-text-change'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

function makeView(doc: string): { view: EditorView; compartment: Compartment } {
  const compartment = new Compartment()
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc, extensions: [compartment.of(history())] })
  })
  cleanups.push(() => {
    view.destroy()
    parent.remove()
  })
  return { view, compartment }
}

/** What the user types: an ordinary, undoable edit. */
function type(view: EditorView, text: string): void {
  view.dispatch({ changes: { from: view.state.doc.length, insert: text } })
}

/** How EditorPane applies a body the store handed it: the span between the
 *  common prefix and suffix, not added to the history. */
function applyBodyFromStore(view: EditorView, nextBody: string): void {
  const change = minimalTextChange(view.state.doc.toString(), nextBody)
  if (!change) return
  view.dispatch({ changes: change, annotations: [Transaction.addToHistory.of(false)] })
}

describe('isDiskChange', () => {
  it('is a body change under the same path with a moved disk revision', () => {
    expect(isDiskChange({ pathChanged: false, bodyChanged: true, diskRevision: 1, seenDiskRevision: 0 })).toBe(true)
  })

  it('is not a peer pane or a rename rewrite, whose revision stays put', () => {
    expect(isDiskChange({ pathChanged: false, bodyChanged: true, diskRevision: 2, seenDiskRevision: 2 })).toBe(false)
  })

  it('is not a tab switch or a rename, even when the incoming path has a history of disk changes', () => {
    expect(isDiskChange({ pathChanged: true, bodyChanged: true, diskRevision: 5, seenDiskRevision: 0 })).toBe(false)
  })

  it('needs a body change at all', () => {
    expect(isDiskChange({ pathChanged: false, bodyChanged: false, diskRevision: 1, seenDiskRevision: 0 })).toBe(false)
  })
})

describe('the open note changes on disk (#852)', () => {
  it('undo does nothing after the history is reset, and the disk text stays', () => {
    const { view, compartment } = makeView('')
    type(view, 'Hello')
    expect(undoDepth(view.state)).toBe(1)

    applyBodyFromStore(view, 'Hello, changed outside')
    resetUndoHistory(view, compartment)
    expect(view.state.doc.toString()).toBe('Hello, changed outside')
    expect(undoDepth(view.state)).toBe(0)
    expect(redoDepth(view.state)).toBe(0)

    undo(view)
    expect(view.state.doc.toString()).toBe('Hello, changed outside')
  })

  it('edits made after the disk change undo normally, back to the disk text', () => {
    const { view, compartment } = makeView('Hello')
    applyBodyFromStore(view, 'Hello, changed outside')
    resetUndoHistory(view, compartment)
    type(view, ' and mine')
    expect(view.state.doc.toString()).toBe('Hello, changed outside and mine')
    undo(view)
    expect(view.state.doc.toString()).toBe('Hello, changed outside')
    undo(view)
    expect(view.state.doc.toString()).toBe('Hello, changed outside')
  })

  it('a peer pane edit keeps the history: undo reverts your own step under it', () => {
    // The mapping is the point for in-app changes (renames, other panes):
    // the user's edit still fits the text and comes out cleanly.
    const { view } = makeView('Draft: ')
    type(view, 'hello')
    applyBodyFromStore(view, 'Draft (v2): hello')
    undo(view)
    expect(view.state.doc.toString()).toBe('Draft (v2): ')
  })

  it('control: without the reset, undo produces text nobody wrote (the bug)', () => {
    const { view } = makeView('')
    type(view, 'Hello')
    applyBodyFromStore(view, 'Hello, changed outside')
    undo(view)
    expect(view.state.doc.toString()).toBe(', changed outside')
  })
})
