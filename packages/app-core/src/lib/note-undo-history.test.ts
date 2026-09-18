import { beforeEach, describe, expect, it } from 'vitest'
import { redo, redoDepth, undo, undoDepth } from '@codemirror/commands'
import { Compartment, EditorState, Transaction } from '@codemirror/state'
import { minimalTextChange } from './minimal-text-change'
import {
  NOTE_UNDO_HISTORY_LIMIT,
  clearNoteUndoHistories,
  followPathRewritesInNoteUndoHistories,
  noteUndoHistoryFor,
  noteUndoHistoryKey,
  setAsideNoteUndoHistory
} from './note-undo-history'
import { appendPathRewrite, type PathRewrite } from './path-rewrites'

const A = noteUndoHistoryKey('/vault', 'inbox/A.md')
const B = noteUndoHistoryKey('/vault', 'inbox/B.md')

/** One pane's editor, driven the way EditorPane drives the real one. */
class Pane {
  private readonly compartment = new Compartment()
  state: EditorState
  key: string

  constructor(key: string, body: string) {
    this.key = key
    this.state = EditorState.create({
      doc: body,
      extensions: [this.compartment.of(noteUndoHistoryFor(key, body))]
    })
  }

  get text(): string {
    return this.state.doc.toString()
  }

  type(text: string): void {
    this.state = this.state.update({
      changes: { from: this.state.doc.length, insert: text },
      // Far enough apart that CodeMirror does not merge them into one step.
      annotations: [Transaction.userEvent.of('input.type'), Transaction.time.of(Date.now() + this.clock)]
    }).state
    this.clock += 10_000
  }
  private clock = 0

  /** Show another note: the #247 swap, with the history set aside first. */
  show(key: string, body: string): void {
    setAsideNoteUndoHistory(this.key, this.state)
    this.key = key
    this.state = this.state.update({
      changes: { from: 0, to: this.state.doc.length, insert: body },
      annotations: Transaction.addToHistory.of(false)
    }).state
    this.state = this.state.update({ effects: this.compartment.reconfigure([]) }).state
    this.state = this.state.update({
      effects: this.compartment.reconfigure(noteUndoHistoryFor(key, body))
    }).state
  }

  /**
   * The note on screen got a new path and maybe new text (a rename that also
   * rewrote its title heading): the editor stays on it and applies only what
   * changed, outside the history.
   */
  renameTo(key: string, body: string, how: 'minimal' | 'whole document' = 'minimal'): void {
    this.key = key
    const before = this.state.doc.toString()
    const changes =
      how === 'minimal'
        ? minimalTextChange(before, body) ?? undefined
        : { from: 0, to: before.length, insert: body }
    if (!changes) return
    this.state = this.state.update({
      changes,
      annotations: Transaction.addToHistory.of(false)
    }).state
  }

  /** The editor goes away, as it does when the pane shows Trash or Tasks. */
  destroy(): void {
    setAsideNoteUndoHistory(this.key, this.state)
  }

  undo(): boolean {
    return undo({ state: this.state, dispatch: (tr) => (this.state = tr.state) })
  }

  redo(): boolean {
    return redo({ state: this.state, dispatch: (tr) => (this.state = tr.state) })
  }
}

beforeEach(() => clearNoteUndoHistories())

describe('undo history across a tab switch (#793)', () => {
  it('is still there when you come back to the note', () => {
    const pane = new Pane(A, 'alpha')
    pane.type(' one')
    pane.type(' two')
    pane.show(B, 'beta')
    pane.show(A, 'alpha one two')

    expect(undoDepth(pane.state)).toBe(2)
    pane.undo()
    expect(pane.text).toBe('alpha one')
    pane.undo()
    expect(pane.text).toBe('alpha')
  })

  // The reason the history is emptied on a swap at all.
  it('never lets undo on the other note bring the previous note back (#247)', () => {
    const pane = new Pane(A, 'alpha')
    pane.type(' one')
    pane.show(B, 'beta')

    expect(undoDepth(pane.state)).toBe(0)
    expect(pane.undo()).toBe(false)
    expect(pane.text).toBe('beta')
  })

  it('keeps each note its own history, redo included', () => {
    const pane = new Pane(A, 'alpha')
    pane.type(' one')
    pane.show(B, 'beta')
    pane.type(' uno')
    pane.type(' dos')
    pane.undo()
    pane.show(A, 'alpha one')
    pane.undo()
    expect(pane.text).toBe('alpha')

    pane.show(B, 'beta uno')
    expect(redoDepth(pane.state)).toBe(1)
    pane.redo()
    expect(pane.text).toBe('beta uno dos')
    pane.show(A, 'alpha')
    pane.redo()
    expect(pane.text).toBe('alpha one')
  })

  it('survives the editor being destroyed and built again', () => {
    const first = new Pane(A, 'alpha')
    first.type(' one')
    first.destroy()

    const second = new Pane(A, 'alpha one')
    second.undo()
    expect(second.text).toBe('alpha')
  })

  // Undo steps are edits at positions. On any other text they would corrupt it.
  it('starts clean when the note no longer reads as it did', () => {
    const pane = new Pane(A, 'alpha')
    pane.type(' one')
    pane.show(B, 'beta')
    pane.show(A, 'alpha one, edited somewhere else')

    expect(undoDepth(pane.state)).toBe(0)
    expect(pane.undo()).toBe(false)
    expect(pane.text).toBe('alpha one, edited somewhere else')

    // Same length, different text: a length check alone would not be enough.
    pane.show(B, 'beta')
    pane.show(A, 'ALPHA ONE, EDITED SOMEWHERE ELSE')
    expect(undoDepth(pane.state)).toBe(0)
  })

  it('forgets a history that stopped matching instead of offering it later', () => {
    const pane = new Pane(A, 'alpha')
    pane.type(' one')
    pane.show(B, 'beta')
    pane.show(A, 'changed elsewhere')
    pane.show(B, 'beta')
    // The text happens to read as it did when the old history was set aside.
    pane.show(A, 'alpha one')
    expect(undoDepth(pane.state)).toBe(0)
  })

  it('keeps the history through a visit that changed nothing', () => {
    const pane = new Pane(A, 'alpha')
    pane.type(' one')
    pane.show(B, 'beta')
    pane.show(A, 'alpha one')
    pane.show(B, 'beta')
    pane.show(A, 'alpha one')
    pane.undo()
    expect(pane.text).toBe('alpha')
  })

  it('does not mix up the same path in two vaults', () => {
    const pane = new Pane(A, 'alpha')
    pane.type(' one')
    pane.show(noteUndoHistoryKey('/other-vault', 'inbox/A.md'), 'alpha one')
    expect(undoDepth(pane.state)).toBe(0)
  })

  it('lets go of the note left longest ago past the limit', () => {
    const pane = new Pane(A, 'alpha')
    pane.type(' one')
    for (let n = 0; n < NOTE_UNDO_HISTORY_LIMIT; n++) {
      pane.show(noteUndoHistoryKey('/vault', `inbox/${n}.md`), `note ${n}`)
      pane.type(' edited')
    }
    pane.show(A, 'alpha one')
    expect(undoDepth(pane.state)).toBe(0)

    // The most recently left ones are all still there.
    pane.show(noteUndoHistoryKey('/vault', 'inbox/10.md'), 'note 10 edited')
    expect(undoDepth(pane.state)).toBe(1)
  })
})

describe('undo history across a rename of the open note', () => {
  const RENAMED = noteUndoHistoryKey('/vault', 'inbox/Roadmap 2027.md')

  it('keeps working when the rename also rewrote the title heading', () => {
    const pane = new Pane(A, '# Roadmap\n\nBody.')
    pane.type(' One.')
    pane.type(' Two.')
    pane.renameTo(RENAMED, '# Roadmap 2027\n\nBody. One. Two.')

    expect(undoDepth(pane.state)).toBe(2)
    pane.undo()
    expect(pane.text).toBe('# Roadmap 2027\n\nBody. One.')
    pane.undo()
    // The user's edits are gone; the rename's heading is not theirs to undo.
    expect(pane.text).toBe('# Roadmap 2027\n\nBody.')
    pane.redo()
    expect(pane.text).toBe('# Roadmap 2027\n\nBody. One.')
  })

  // Why the change has to be minimal: replacing the whole document tells the
  // history that every position it remembers is gone.
  it('would lose the edits if the new text replaced the whole document', () => {
    const pane = new Pane(A, '# Roadmap\n\nBody.')
    pane.type(' One.')
    pane.renameTo(RENAMED, '# Roadmap 2027\n\nBody. One.', 'whole document')
    pane.undo()
    expect(pane.text).not.toBe('# Roadmap 2027\n\nBody.')
  })

  it('still sets the history aside under the new name when the note is left', () => {
    const pane = new Pane(A, '# Roadmap\n\nBody.')
    pane.type(' One.')
    pane.renameTo(RENAMED, '# Roadmap 2027\n\nBody. One.')
    pane.show(B, 'beta')
    expect(undoDepth(pane.state)).toBe(0)
    pane.show(RENAMED, '# Roadmap 2027\n\nBody. One.')
    pane.undo()
    expect(pane.text).toBe('# Roadmap 2027\n\nBody.')
  })
})

describe('set-aside histories follow notes that move while off screen', () => {
  const rewrites = (...entries: Array<[string, string | null]>): PathRewrite[] =>
    entries.reduce<PathRewrite[]>((log, [from, to]) => appendPathRewrite(log, '/vault', from, to), [])

  it('finds the history under the new path after a move or a folder rename', () => {
    const pane = new Pane(noteUndoHistoryKey('/vault', 'inbox/Work/Standup.md'), 'standup')
    pane.type(' notes')
    pane.show(B, 'beta')

    followPathRewritesInNoteUndoHistories(rewrites(['inbox/Work/', 'inbox/Team/']))
    pane.show(noteUndoHistoryKey('/vault', 'inbox/Team/Standup.md'), 'standup notes')
    pane.undo()
    expect(pane.text).toBe('standup')
  })

  it('drops the history of a deleted note, even if its path comes back', () => {
    const pane = new Pane(A, 'alpha')
    pane.type(' one')
    pane.show(B, 'beta')

    followPathRewritesInNoteUndoHistories(rewrites(['inbox/A.md', null]))
    pane.show(A, 'alpha one')
    expect(undoDepth(pane.state)).toBe(0)
  })

  it('applies each rewrite once, however often it is asked', () => {
    const pane = new Pane(A, 'alpha')
    pane.type(' one')
    pane.show(B, 'beta')

    // A -> C, and only later C -> A again: asking twice must not replay A -> C.
    let log = rewrites(['inbox/A.md', 'inbox/C.md'])
    followPathRewritesInNoteUndoHistories(log)
    followPathRewritesInNoteUndoHistories(log)
    log = appendPathRewrite(log, '/vault', 'inbox/C.md', 'inbox/A.md')
    followPathRewritesInNoteUndoHistories(log)
    pane.show(A, 'alpha one')
    expect(undoDepth(pane.state)).toBe(1)
  })
})
