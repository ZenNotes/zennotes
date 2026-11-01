// @vitest-environment jsdom

import { CompletionContext } from '@codemirror/autocomplete'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toggleCheckbox } from './cm-toggle-checkbox'
import { taskFieldSource } from './cm-task-field-complete'
import { checkOffTaskAtMarker, editorRecurrenceContext } from './cm-task-recurrence'

function viewOf(doc: string, cursor: number, dailyDue?: string): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(cursor),
      extensions: dailyDue ? [editorRecurrenceContext.of(() => ({ dailyDue }))] : []
    })
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 10, 1, 9, 0))
})
afterEach(() => vi.useRealTimers())

describe('checking off a recurring task in the editor (#1036)', () => {
  it('Mod+L writes the next occurrence above and keeps the cursor on it', () => {
    const doc = '- [ ] Water the plants @repeat:weekly due:2026-11-01\n- [ ] other'
    const view = viewOf(doc, 10)
    toggleCheckbox(view)
    expect(view.state.doc.toString()).toBe(
      '- [ ] Water the plants @repeat:weekly due:2026-11-08\n- [x] Water the plants due:2026-11-01\n- [ ] other'
    )
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(1)
    expect(view.state.selection.main.head).toBe(10)
  })

  it('the record cancels the subtasks left open, the copy starts them fresh', () => {
    const doc = '- [ ] Review @repeat:weekly due:2026-11-01\n  - [x] Inbox\n  - [ ] Plan\n- [ ] other'
    const view = viewOf(doc, 4)
    toggleCheckbox(view)
    expect(view.state.doc.toString()).toBe(
      '- [ ] Review @repeat:weekly due:2026-11-08\n  - [ ] Inbox\n  - [ ] Plan\n' +
        '- [x] Review due:2026-11-01\n  - [x] Inbox\n  - [-] Plan\n- [ ] other'
    )
  })

  it('subtasks selected with the task are checked off in the record, in one change', () => {
    const doc = '- [ ] Review @repeat:weekly due:2026-11-01\n  - [ ] Inbox\n  - [ ] Plan\n- [ ] other'
    const view = new EditorView({
      state: EditorState.create({ doc, selection: EditorSelection.range(0, doc.indexOf('Inbox') + 2) })
    })
    toggleCheckbox(view)
    expect(view.state.doc.toString()).toBe(
      '- [ ] Review @repeat:weekly due:2026-11-08\n  - [ ] Inbox\n  - [ ] Plan\n' +
        '- [x] Review due:2026-11-01\n  - [x] Inbox\n  - [-] Plan\n- [ ] other'
    )
  })

  it('one undo step: the whole edit is a single transaction', () => {
    const view = viewOf('- [ ] A @repeat:daily due:2026-11-01', 0)
    let transactions = 0
    const counting = new EditorView({
      state: view.state,
      dispatchTransactions: (trs, v) => {
        transactions += trs.length
        v.update(trs)
      }
    })
    toggleCheckbox(counting)
    expect(transactions).toBe(1)
  })

  it('unchecking a record is an ordinary toggle', () => {
    const view = viewOf('- [x] A due:2026-11-01', 0)
    toggleCheckbox(view)
    expect(view.state.doc.toString()).toBe('- [ ] A due:2026-11-01')
  })

  it('a daily note gives a dateless task its date', () => {
    const view = viewOf('- [ ] Journal @repeat:daily', 0, '2026-10-31')
    toggleCheckbox(view)
    expect(view.state.doc.toString()).toBe('- [ ] Journal @repeat:daily due:2026-11-02\n- [x] Journal')
  })

  it('the checkbox widget and the in-progress marker repeat the task too', () => {
    const view = viewOf('text\n  - [/] Review @repeat:mon due:2026-11-02', 0)
    checkOffTaskAtMarker(view, view.state.doc.line(2).from + 4)
    expect(view.state.doc.toString()).toBe(
      'text\n  - [ ] Review @repeat:mon due:2026-11-09\n  - [x] Review due:2026-11-02'
    )
    const plain = viewOf('- [ ] Plain', 0)
    checkOffTaskAtMarker(plain, 2)
    expect(plain.state.doc.toString()).toBe('- [x] Plain')
  })
})

describe('taskFieldSource', () => {
  const complete = (doc: string) =>
    taskFieldSource(new CompletionContext(EditorState.create({ doc }), doc.length, false))

  it('offers rules after @repeat: and times after @remind: on a task line', () => {
    expect(complete('- [ ] Rent @repeat:')?.options.map((o) => o.label)).toContain('monthly')
    expect(complete('- [ ] Rent @remind:1')?.from).toBe('- [ ] Rent @remind:'.length)
    expect(complete('- [ ] Rent @remind:')?.options.map((o) => o.label)).toContain('1d')
  })

  it('stays out of the way elsewhere', () => {
    expect(complete('Rent @repeat:')).toBeNull()
    expect(complete('- [ ] Rent @status:')).toBeNull()
  })
})
