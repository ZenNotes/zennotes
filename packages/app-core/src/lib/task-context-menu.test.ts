import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VaultTask } from '@shared/tasks'
import { useStore } from '../store'
import {
  buildTaskMenuItems,
  chooseTaskDueDate,
  chooseTaskPlannedDay,
  planTaskForToday
} from './task-context-menu'

const promptMocks = vi.hoisted(() => ({
  promptDate: vi.fn<(options?: unknown) => Promise<string | null>>()
}))

vi.mock('./date-prompt-requests', () => ({
  DATE_PROMPT_CLEAR: 'clear',
  promptDate: promptMocks.promptDate
}))

const today = new Date(2026, 9, 23)

function task(fields: Partial<VaultTask> = {}): VaultTask {
  return {
    id: 'inbox/Plan.md:3',
    path: 'inbox/Plan.md',
    line: 3,
    content: 'Book museum tickets',
    rawText: '- [ ] Book museum tickets',
    checked: false,
    forwarded: false,
    cancelled: false,
    inProgress: false,
    waiting: false,
    tags: [],
    ...fields
  } as VaultTask
}

describe('Choose a date… in the task menu (#991)', () => {
  let originalState: ReturnType<typeof useStore.getState>
  const applyTaskMutation = vi.fn(async () => {})

  beforeEach(() => {
    originalState = useStore.getState()
    useStore.setState({ applyTaskMutation } as Partial<ReturnType<typeof useStore.getState>>)
    promptMocks.promptDate.mockReset()
    applyTaskMutation.mockClear()
  })

  afterEach(() => {
    useStore.setState(originalState, true)
  })

  it('follows the due presets, naming @ only where the key works', () => {
    const labels = buildTaskMenuItems(task(), { today }).map((item) => ('label' in item ? item.label : '-'))
    expect(labels.slice(labels.indexOf('Due today'), labels.indexOf('Due today') + 4)).toEqual([
      'Due today',
      'Due tomorrow',
      'Due next week',
      'Choose a date…'
    ])
    const entry = (hints: boolean) =>
      buildTaskMenuItems(task(), { today, showKeyHints: hints }).find(
        (item) => 'label' in item && item.label === 'Choose a date…'
      )
    expect(entry(true)).toMatchObject({ hint: '@' })
    expect(entry(false)).toMatchObject({ hint: undefined })
  })

  it('opens on the task\'s due date and writes the picked day', async () => {
    promptMocks.promptDate.mockResolvedValueOnce('2026-11-04')
    const planned = task({ due: '2026-10-30' })

    await chooseTaskDueDate(planned, today)

    expect(promptMocks.promptDate).toHaveBeenCalledWith({
      title: 'Due date',
      description: 'Book museum tickets',
      initialDate: '2026-10-30',
      okLabel: 'Set due date'
    })
    expect(applyTaskMutation).toHaveBeenCalledWith(planned, { kind: 'set-due', due: '2026-11-04' })
  })

  it('starts on today without a due date, and leaves the line alone when nothing changes', async () => {
    promptMocks.promptDate.mockResolvedValueOnce(null)
    await chooseTaskDueDate(task(), today)
    expect(promptMocks.promptDate).toHaveBeenCalledWith(expect.objectContaining({ initialDate: '2026-10-23' }))

    promptMocks.promptDate.mockResolvedValueOnce('2026-10-30')
    await chooseTaskDueDate(task({ due: '2026-10-30' }), today)
    expect(applyTaskMutation).not.toHaveBeenCalled()
  })

  it('writes the day of a daily-note task even when it matches the inferred date', async () => {
    // The inferred date comes from the note the task sits in; picking it makes
    // it the task's own, so it stays when the task moves.
    promptMocks.promptDate.mockResolvedValueOnce('2026-10-23')
    const daily = task({ due: '2026-10-23', dueInferred: true })

    await chooseTaskDueDate(daily, today)

    expect(applyTaskMutation).toHaveBeenCalledWith(daily, { kind: 'set-due', due: '2026-10-23' })
  })
})

describe('Plan for… in the task menu (#1119)', () => {
  let originalState: ReturnType<typeof useStore.getState>
  const applyTaskMutation = vi.fn(async () => {})
  const planned = (day: string, fields: Partial<VaultTask> = {}): VaultTask =>
    task({ fields: { scheduled: day }, ...fields })

  beforeEach(() => {
    originalState = useStore.getState()
    useStore.setState({ applyTaskMutation } as Partial<ReturnType<typeof useStore.getState>>)
    promptMocks.promptDate.mockReset()
    applyTaskMutation.mockClear()
  })

  afterEach(() => {
    useStore.setState(originalState, true)
  })

  const entry = (t: VaultTask, hints = true) =>
    buildTaskMenuItems(t, { today, showKeyHints: hints }).find(
      (item) => 'label' in item && item.label === 'Plan for…'
    )

  it('sits under the due dates, shows the day planned, and names no key', () => {
    const labels = buildTaskMenuItems(task({ due: '2026-10-30' }), { today }).map((item) =>
      'label' in item ? item.label : '-'
    )
    expect(labels.slice(labels.indexOf('Choose a date…'), labels.indexOf('Choose a date…') + 3)).toEqual([
      'Choose a date…',
      'Clear due date',
      'Plan for…'
    ])
    // `p` plans for today outright, which this entry does not do.
    expect(entry(task())).toMatchObject({ mark: undefined, disabled: false })
    expect(entry(task())).not.toHaveProperty('hint')
    expect(entry(planned('2026-10-28'))).toMatchObject({ mark: '2026-10-28' })
  })

  it('is off for work that is done, cancelled or forwarded', () => {
    for (const closed of [{ checked: true }, { cancelled: true }, { forwarded: true }]) {
      expect(entry(task(closed))).toMatchObject({ disabled: true })
    }
  })

  it('opens on today, offers no Clear without a plan, and writes the picked day as a field', async () => {
    promptMocks.promptDate.mockResolvedValueOnce('2026-10-28')
    const open = task({ due: '2026-10-30' })

    await chooseTaskPlannedDay(open, today)

    expect(promptMocks.promptDate).toHaveBeenCalledWith({
      title: 'Plan for',
      description: 'Book museum tickets',
      initialDate: '2026-10-23',
      okLabel: 'Plan',
      clearLabel: undefined
    })
    expect(applyTaskMutation).toHaveBeenCalledWith(open, {
      kind: 'set-field',
      key: 'scheduled',
      value: '2026-10-28'
    })
  })

  it('opens on the planned day, and Clear takes the plan off', async () => {
    promptMocks.promptDate.mockResolvedValueOnce('clear')
    const t = planned('2026-10-28')

    await chooseTaskPlannedDay(t, today)

    expect(promptMocks.promptDate).toHaveBeenCalledWith(
      expect.objectContaining({ initialDate: '2026-10-28', clearLabel: 'Clear' })
    )
    expect(applyTaskMutation).toHaveBeenCalledWith(t, { kind: 'set-field', key: 'scheduled', value: null })
  })

  it('writes nothing when the picker is dismissed or the day is the one planned', async () => {
    promptMocks.promptDate.mockResolvedValueOnce(null)
    await chooseTaskPlannedDay(task(), today)
    promptMocks.promptDate.mockResolvedValueOnce('2026-10-28')
    await chooseTaskPlannedDay(planned('2026-10-28'), today)
    expect(applyTaskMutation).not.toHaveBeenCalled()
  })

  it('reads and writes a task note\'s plan as its frontmatter key', async () => {
    promptMocks.promptDate.mockResolvedValueOnce('2026-10-29')
    const note = task({ kind: 'file', scheduled: '2026-10-28' })

    await chooseTaskPlannedDay(note, today)

    expect(promptMocks.promptDate).toHaveBeenCalledWith(expect.objectContaining({ initialDate: '2026-10-28' }))
    expect(applyTaskMutation).toHaveBeenCalledWith(note, { kind: 'set-field', key: 'scheduled', value: '2026-10-29' })
  })

  it('`p` plans for today once, and leaves finished work alone', async () => {
    const open = task({ due: '2026-10-30' })
    await planTaskForToday(open, today)
    expect(applyTaskMutation).toHaveBeenCalledWith(open, { kind: 'set-field', key: 'scheduled', value: '2026-10-23' })

    applyTaskMutation.mockClear()
    await planTaskForToday(planned('2026-10-23'), today)
    await planTaskForToday(task({ checked: true }), today)
    expect(applyTaskMutation).not.toHaveBeenCalled()
  })
})
