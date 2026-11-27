// @vitest-environment jsdom

import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { planTaskAtCursor } from './editor-task-recurrence'

const promptMocks = vi.hoisted(() => ({
  promptDate: vi.fn<(options?: unknown) => Promise<string | null>>()
}))

vi.mock('./date-prompt-requests', () => ({
  DATE_PROMPT_CLEAR: 'clear',
  promptDate: promptMocks.promptDate
}))

function viewOf(doc: string, cursor: number): EditorView {
  return new EditorView({
    state: EditorState.create({ doc, selection: EditorSelection.cursor(cursor) })
  })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 27, 9, 0))
  promptMocks.promptDate.mockReset()
})
afterEach(() => vi.useRealTimers())

// `:plan` and "Plan Task…" (#1119): the planned day of the task under the
// cursor, its due date never touched.
describe('planning the task under the editor cursor (#1119)', () => {
  const doc = '# Work\n- [ ] Send the report due:2026-12-04\n- [ ] other'
  const onTask = doc.indexOf('Send')

  it('writes the day given, as a date, today or tomorrow, and keeps the cursor', async () => {
    const view = viewOf(doc, onTask)
    await planTaskAtCursor(view, '2026-12-02')
    expect(view.state.doc.line(2).text).toBe('- [ ] Send the report due:2026-12-04 @scheduled:2026-12-02')
    expect(view.state.selection.main.head).toBe(onTask)

    await planTaskAtCursor(view, 'today')
    expect(view.state.doc.line(2).text).toBe('- [ ] Send the report due:2026-12-04 @scheduled:2026-11-27')
    await planTaskAtCursor(view, 'Tomorrow')
    expect(view.state.doc.line(2).text).toBe('- [ ] Send the report due:2026-12-04 @scheduled:2026-11-28')
    expect(view.state.doc.line(3).text).toBe('- [ ] other')
  })

  it('takes the plan off with `off`', async () => {
    const view = viewOf('- [ ] Send the report @scheduled:2026-12-02 due:2026-12-04', 8)
    await planTaskAtCursor(view, 'off')
    expect(view.state.doc.toString()).toBe('- [ ] Send the report due:2026-12-04')
  })

  it('leaves the line alone for a value that is not a day, or off a task line', async () => {
    const view = viewOf(doc, onTask)
    await planTaskAtCursor(view, 'friday')
    await planTaskAtCursor(view, '2026-12')
    expect(view.state.doc.toString()).toBe(doc)

    const heading = viewOf(doc, 2)
    await planTaskAtCursor(heading, 'today')
    expect(heading.state.doc.toString()).toBe(doc)
    expect(promptMocks.promptDate).not.toHaveBeenCalled()
  })

  it('keeps a block id at the end of the line', async () => {
    const view = viewOf('- [ ] Gym ^gym', 7)
    await planTaskAtCursor(view, '2026-12-02')
    expect(view.state.doc.toString()).toBe('- [ ] Gym @scheduled:2026-12-02 ^gym')
  })

  it('bare, opens the calendar on today, or on the planned day with Clear', async () => {
    promptMocks.promptDate.mockResolvedValueOnce('2026-12-01')
    const view = viewOf(doc, onTask)
    await planTaskAtCursor(view)
    expect(promptMocks.promptDate).toHaveBeenCalledWith({
      title: 'Plan for',
      description: 'Send the report due:2026-12-04',
      initialDate: '2026-11-27',
      okLabel: 'Plan',
      clearLabel: undefined
    })
    expect(view.state.doc.line(2).text).toBe('- [ ] Send the report due:2026-12-04 @scheduled:2026-12-01')

    promptMocks.promptDate.mockResolvedValueOnce('clear')
    await planTaskAtCursor(view)
    expect(promptMocks.promptDate).toHaveBeenLastCalledWith(
      expect.objectContaining({ initialDate: '2026-12-01', clearLabel: 'Clear' })
    )
    expect(view.state.doc.line(2).text).toBe('- [ ] Send the report due:2026-12-04')

    promptMocks.promptDate.mockResolvedValueOnce(null)
    await planTaskAtCursor(view)
    expect(view.state.doc.line(2).text).toBe('- [ ] Send the report due:2026-12-04')
  })
})
