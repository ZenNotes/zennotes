// @vitest-environment jsdom

import { CompletionContext, type Completion } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dateShortcutSource, formatClockTime } from './cm-date-shortcuts'

const promptMocks = vi.hoisted(() => ({
  promptDate: vi.fn<(options?: unknown) => Promise<string | null>>()
}))

vi.mock('./date-prompt-requests', () => ({
  promptDate: promptMocks.promptDate
}))

const at = (h: number, m: number) => new Date(2026, 0, 1, h, m)

describe('formatClockTime', () => {
  it('formats 24-hour with zero-padding', () => {
    expect(formatClockTime(at(14, 30), '24h')).toBe('14:30')
    expect(formatClockTime(at(9, 5), '24h')).toBe('09:05')
    expect(formatClockTime(at(0, 0), '24h')).toBe('00:00')
    expect(formatClockTime(at(23, 59), '24h')).toBe('23:59')
  })

  it('formats 12-hour with AM/PM and no leading-zero hour', () => {
    expect(formatClockTime(at(14, 30), '12h')).toBe('2:30 PM')
    expect(formatClockTime(at(9, 5), '12h')).toBe('9:05 AM')
    expect(formatClockTime(at(0, 0), '12h')).toBe('12:00 AM')
    expect(formatClockTime(at(12, 0), '12h')).toBe('12:00 PM')
    expect(formatClockTime(at(23, 59), '12h')).toBe('11:59 PM')
  })
})

function optionsFor(doc: string): readonly Completion[] {
  const state = EditorState.create({ doc, selection: { anchor: doc.length } })
  const result = dateShortcutSource(new CompletionContext(state, doc.length, false))
  return result?.options ?? []
}

function labels(doc: string): string[] {
  return optionsFor(doc).map((o) => o.label)
}

function todayIso(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate()
  ).padStart(2, '0')}`
}

describe('the @ menu', () => {
  it('keeps the quick options and adds Date… at the end', () => {
    expect(labels('meet @')).toEqual(['Today', 'Yesterday', 'Tomorrow', 'Now', 'Date…'])
  })

  it('finds the calendar by date, pick or calendar, and quick options by their names', () => {
    expect(labels('meet @date')).toEqual(['Date…'])
    expect(labels('meet @cal')).toEqual(['Date…'])
    expect(labels('meet @pick')).toEqual(['Date…'])
    expect(labels('meet @tom')).toEqual(['Tomorrow'])
    expect(labels('meet @now')).toEqual(['Now'])
  })
})

describe('picking a date from the @ menu', () => {
  let view: EditorView

  beforeEach(() => {
    promptMocks.promptDate.mockReset()
  })

  afterEach(() => {
    view.destroy()
  })

  function applyDatePick(doc: string): void {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc, selection: { anchor: doc.length } })
    })
    const context = new CompletionContext(view.state, doc.length, false)
    const result = dateShortcutSource(context)!
    const pick = result.options.find((o) => o.label === 'Date…')!
    const apply = pick.apply as (view: EditorView, c: Completion, from: number, to: number) => void
    apply(view, pick, result.from, doc.length)
  }

  it('drops the trigger, opens the calendar on today, and inserts the picked day where @ stood', async () => {
    promptMocks.promptDate.mockResolvedValue('2027-03-14')
    applyDatePick('meet @date')
    // The trigger is gone before the calendar shows, so the note never
    // carries a half-typed `@date` under the modal.
    expect(view.state.doc.toString()).toBe('meet ')
    expect(promptMocks.promptDate).toHaveBeenCalledWith({ initialDate: todayIso() })
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe('meet 2027-03-14'))
    expect(view.state.selection.main.head).toBe('meet 2027-03-14'.length)
  })

  it('leaves clean text when the calendar is dismissed', async () => {
    promptMocks.promptDate.mockResolvedValue(null)
    applyDatePick('meet @da')
    expect(view.state.doc.toString()).toBe('meet ')
    await new Promise((r) => setTimeout(r, 0))
    expect(view.state.doc.toString()).toBe('meet ')
  })
})
