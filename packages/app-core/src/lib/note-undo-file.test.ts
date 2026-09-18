import { describe, expect, it } from 'vitest'
import { history, redo, redoDepth, undo, undoDepth } from '@codemirror/commands'
import { Compartment, EditorState, Transaction } from '@codemirror/state'
import {
  noteTextFingerprint,
  noteUndoHistoryFromFile,
  serializeNoteUndoHistory
} from './note-undo-file'

/** An editor session: type, undo, and "quit" into a saved string. */
class Session {
  private readonly compartment = new Compartment()
  state: EditorState
  private clock = 0

  constructor(body: string, saved: string | null = null) {
    const restored = saved ? noteUndoHistoryFromFile(saved, body) : null
    this.state = EditorState.create({
      doc: body,
      extensions: [this.compartment.of(restored ?? history())]
    })
  }

  get text(): string {
    return this.state.doc.toString()
  }

  type(text: string): void {
    this.state = this.state.update({
      changes: { from: this.state.doc.length, insert: text },
      annotations: [Transaction.userEvent.of('input.type'), Transaction.time.of(Date.now() + this.clock)]
    }).state
    this.clock += 10_000
  }

  undo(): boolean {
    return undo({ state: this.state, dispatch: (tr) => (this.state = tr.state) })
  }

  redo(): boolean {
    return redo({ state: this.state, dispatch: (tr) => (this.state = tr.state) })
  }

  quit(maxChars?: number): string | null {
    return serializeNoteUndoHistory(this.state, maxChars)
  }
}

describe('undo history across a restart (#793)', () => {
  it('undoes and redoes in the next session what was typed in this one', () => {
    const first = new Session('alpha')
    first.type(' one')
    first.type(' two')
    first.type(' three')
    first.undo()
    const saved = first.quit()
    expect(saved).not.toBeNull()

    const second = new Session('alpha one two', saved)
    expect(undoDepth(second.state)).toBe(2)
    expect(redoDepth(second.state)).toBe(1)
    second.undo()
    expect(second.text).toBe('alpha one')
    second.redo()
    second.redo()
    expect(second.text).toBe('alpha one two three')
  })

  it('keeps working across more than one restart', () => {
    const first = new Session('alpha')
    first.type(' one')
    const second = new Session('alpha one', first.quit())
    second.type(' two')
    const third = new Session('alpha one two', second.quit())
    third.undo()
    third.undo()
    expect(third.text).toBe('alpha')
  })

  it('saves nothing when there is nothing to undo or redo', () => {
    expect(new Session('alpha').quit()).toBeNull()
    const session = new Session('alpha')
    session.type(' one')
    expect(session.quit()).not.toBeNull()
  })

  // The note can change between two launches without the app seeing it.
  it('starts clean when the note no longer reads as it did when it was saved', () => {
    const first = new Session('alpha')
    first.type(' one')
    const saved = first.quit()!
    expect(noteUndoHistoryFromFile(saved, 'alpha one, edited in another editor')).toBeNull()
    expect(noteUndoHistoryFromFile(saved, 'ALPHA ONE')).toBeNull()
    expect(noteUndoHistoryFromFile(saved, 'alpha one')).not.toBeNull()
  })

  it('reads nothing it does not understand, and never throws', () => {
    for (const junk of ['', 'not json', 'null', '[]', '{"v":99}', '{"v":1,"text":"x","history":7}']) {
      expect(noteUndoHistoryFromFile(junk, 'alpha')).toBeNull()
    }
    const broken = JSON.stringify({
      v: 1,
      text: noteTextFingerprint('alpha'),
      savedAt: 0,
      history: { done: [{ changes: 'garbage' }], undone: [] }
    })
    expect(noteUndoHistoryFromFile(broken, 'alpha')).toBeNull()
  })

  it('drops the oldest steps, not the newest, when the history is too big to save', () => {
    const session = new Session('start')
    for (let n = 0; n < 40; n++) session.type(` word${n}`)
    const full = session.quit()!
    const trimmed = session.quit(Math.floor(full.length / 3))!
    expect(trimmed.length).toBeLessThanOrEqual(Math.floor(full.length / 3))

    const next = new Session(session.text, trimmed)
    const depth = undoDepth(next.state)
    expect(depth).toBeGreaterThan(0)
    expect(depth).toBeLessThan(40)
    next.undo()
    expect(next.text.endsWith(' word38')).toBe(true)
  })

  it('tells two texts of the same length apart', () => {
    expect(noteTextFingerprint('alpha one')).not.toBe(noteTextFingerprint('alpha two'))
    expect(noteTextFingerprint('same')).toBe(noteTextFingerprint('same'))
  })
})
