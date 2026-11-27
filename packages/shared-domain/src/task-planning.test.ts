import { describe, expect, it } from 'vitest'
import {
  bucketTasksByDay,
  groupTasks,
  inferDailyTaskDueDates,
  isOverdue,
  parseTaskFile,
  parseTasksFromBody,
  tasksOnDay,
  type ParseTasksContext,
  type VaultTask
} from './tasks'
import {
  deadlineApartFromDay,
  parsePlannedDay,
  plannedDay,
  setPlannedDayField,
  taskDay,
  taskDeadline
} from './task-planning'
import { updateFrontmatterFields } from './frontmatter'
import { computeTaskReminders } from './task-reminders'
import { setTaskFieldAtIndex } from './tasklists'

const ctx: ParseTasksContext = { path: 'inbox/t.md', title: 't', folder: 'inbox' }
const parse = (line: string): VaultTask => parseTasksFromBody(line, ctx)[0]
const lines = (body: string): VaultTask[] => parseTasksFromBody(body, ctx)

// A Friday. The 25th is the Wednesday before it, the 30th the Monday after.
const TODAY = '2026-11-27'
const today = new Date(2026, 10, 27)

const dailyCtx: ParseTasksContext = { path: 'Daily/2026-11-25.md', title: '2026-11-25', folder: 'inbox' }
const inDailyNote = (line: string, noteIso = '2026-11-25'): VaultTask =>
  inferDailyTaskDueDates(parseTasksFromBody(line, dailyCtx), new Map([[dailyCtx.path, noteIso]]))[0]

const fileTask = (frontmatter: string): VaultTask =>
  parseTaskFile(`---\ntags: [task]\n${frontmatter}\n---\n`, {
    path: 'inbox/Plan.md',
    title: 'Plan',
    folder: 'inbox'
  })!

describe('plannedDay: the field a task carries', () => {
  it('reads @scheduled: on a checkbox task and leaves its due date alone', () => {
    const task = parse('- [ ] report due:2026-12-04 @scheduled:2026-12-02')
    expect(plannedDay(task)).toBe('2026-12-02')
    expect(task.due).toBe('2026-12-04')
    expect(task.content).toBe('report')
  })

  it('reads frontmatter scheduled: on a task note', () => {
    const task = fileTask('due: 2026-12-04\nscheduled: 2026-12-02')
    expect(plannedDay(task)).toBe('2026-12-02')
    expect(task.due).toBe('2026-12-04')
  })

  it('treats anything but a date as inert', () => {
    for (const value of ['friday', '2026-12', '2026-12-02-14h00', '2026-12-02/afternoon', '20261202']) {
      const task = parse(`- [ ] report due:2026-12-04 @scheduled:${value}`)
      expect(plannedDay(task)).toBeUndefined()
      expect(taskDay(task, TODAY)).toBe('2026-12-04')
    }
    expect(parsePlannedDay(undefined)).toBeUndefined()
    expect(parsePlannedDay('')).toBeUndefined()
  })

  it('does not read a task note\'s plan from a field, nor a checkbox task\'s from frontmatter', () => {
    expect(plannedDay({ kind: 'file', fields: { scheduled: '2026-12-02' } })).toBeUndefined()
    expect(plannedDay({ scheduled: '2026-12-02', fields: {} })).toBeUndefined()
  })
})

describe('taskDay: the one day a task sits on', () => {
  it('is the deadline for a task with no planned day', () => {
    expect(taskDay(parse('- [ ] a due:2026-12-04'), TODAY)).toBe('2026-12-04')
    expect(taskDay(parse('- [ ] a due:2026-11-20'), TODAY)).toBe('2026-11-20')
    expect(taskDay(parse('- [ ] a'), TODAY)).toBeUndefined()
  })

  it('is the planned day when it comes before the deadline', () => {
    const task = parse('- [ ] a due:2026-12-04 @scheduled:2026-12-02')
    expect(taskDay(task, TODAY)).toBe('2026-12-02')
    expect(deadlineApartFromDay(task, TODAY)).toBe('2026-12-04')
    expect(isOverdue(task, today)).toBe(false)
  })

  it('is the planned day for a task with no deadline', () => {
    const task = parse('- [ ] a @scheduled:2026-12-02')
    expect(taskDay(task, TODAY)).toBe('2026-12-02')
    expect(deadlineApartFromDay(task, TODAY)).toBeUndefined()
  })

  it('stays on a planned day after the deadline until the deadline arrives', () => {
    const task = parse('- [ ] a due:2026-12-01 @scheduled:2026-12-05')
    expect(taskDay(task, TODAY)).toBe('2026-12-05')
    expect(deadlineApartFromDay(task, TODAY)).toBe('2026-12-01')
    // The day it is due, the deadline takes over, and after it the task is late.
    expect(taskDay(task, '2026-12-01')).toBe('2026-12-01')
    expect(taskDay(task, '2026-12-03')).toBe('2026-12-01')
    expect(isOverdue(task, new Date(2026, 11, 3))).toBe(true)
  })

  it('shows a task due today as due today, whatever day it was planned for', () => {
    expect(taskDay(parse('- [ ] a due:2026-11-27 @scheduled:2026-11-30'), TODAY)).toBe(TODAY)
    expect(taskDay(parse('- [ ] a due:2026-11-27 @scheduled:2026-11-25'), TODAY)).toBe(TODAY)
  })

  it('shows an overdue task on its deadline, whatever day it was planned for', () => {
    for (const planned of ['2026-11-18', '2026-11-27', '2026-11-30']) {
      const task = parse(`- [ ] a due:2026-11-20 @scheduled:${planned}`)
      expect(taskDay(task, TODAY)).toBe('2026-11-20')
      expect(isOverdue(task, today)).toBe(true)
      expect(deadlineApartFromDay(task, TODAY)).toBeUndefined()
    }
  })

  it('moves a missed planned day to today without calling it late', () => {
    const future = parse('- [ ] a due:2026-12-04 @scheduled:2026-11-25')
    expect(taskDay(future, TODAY)).toBe(TODAY)
    expect(isOverdue(future, today)).toBe(false)
    expect(deadlineApartFromDay(future, TODAY)).toBe('2026-12-04')
    const noDeadline = parse('- [ ] a @scheduled:2026-11-25')
    expect(taskDay(noDeadline, TODAY)).toBe(TODAY)
    expect(isOverdue(noDeadline, today)).toBe(false)
  })

  it('keeps a done, cancelled or forwarded line on the day it names', () => {
    for (const box of ['x', '-', '>']) {
      expect(taskDay(parse(`- [${box}] a @scheduled:2026-11-25`), TODAY)).toBe('2026-11-25')
    }
    // Started and waiting work is still live, so it follows to today.
    expect(taskDay(parse('- [/] a @scheduled:2026-11-25'), TODAY)).toBe(TODAY)
    expect(taskDay(parse('- [ ] a @waiting @scheduled:2026-11-25'), TODAY)).toBe(TODAY)
  })

  it('places a task note by its frontmatter the same way', () => {
    expect(taskDay(fileTask('due: 2026-12-04\nscheduled: 2026-12-02'), TODAY)).toBe('2026-12-02')
    expect(taskDay(fileTask('scheduled: 2026-11-20'), TODAY)).toBe(TODAY)
    expect(taskDay(fileTask('due: 2026-11-20\nscheduled: 2026-12-02'), TODAY)).toBe('2026-11-20')
  })
})

describe('a task in a daily note with a planned day', () => {
  it('sits on its note\'s date and is late by it while it has no planned day', () => {
    const task = inDailyNote('- [ ] a')
    expect(taskDay(task, TODAY)).toBe('2026-11-25')
    expect(taskDeadline(task)).toBe('2026-11-25')
    expect(isOverdue(task, today)).toBe(true)
  })

  it('lets the planned day replace the note\'s date', () => {
    const task = inDailyNote('- [ ] a @scheduled:2026-11-30')
    expect(taskDeadline(task)).toBeUndefined()
    expect(taskDay(task, TODAY)).toBe('2026-11-30')
    expect(isOverdue(task, today)).toBe(false)
    expect(deadlineApartFromDay(task, TODAY)).toBeUndefined()
  })

  it('plans a task in today\'s note away from today', () => {
    const task = inDailyNote('- [ ] a @scheduled:2026-11-30', TODAY)
    expect(taskDay(task, TODAY)).toBe('2026-11-30')
  })

  it('waits under today, not late, once that planned day is missed', () => {
    const task = inDailyNote('- [ ] a @scheduled:2026-11-26')
    expect(taskDay(task, TODAY)).toBe(TODAY)
    expect(isOverdue(task, today)).toBe(false)
  })

  it('keeps a written due: as the deadline it is', () => {
    const task = inDailyNote('- [ ] a due:2026-11-26 @scheduled:2026-11-30')
    expect(task.dueInferred).toBeUndefined()
    expect(taskDay(task, TODAY)).toBe('2026-11-26')
    expect(isOverdue(task, today)).toBe(true)
  })

  it('still reminds from the note\'s date', () => {
    const task = inDailyNote('- [ ] a @remind:9am @scheduled:2026-11-30', TODAY)
    const reminders = computeTaskReminders([task], { now: new Date(2026, 10, 27, 8, 0) })
    expect(reminders.map((r) => new Date(r.fireAt).getDate())).toEqual([27])
  })
})

describe('groupTasks places by the planned day', () => {
  const group = (body: string) => groupTasks(lines(body), today)
  const names = (tasks: VaultTask[]) => tasks.map((t) => t.content)

  it('puts a task planned for today under Today and one planned later under Upcoming', () => {
    const g = group(
      [
        '- [ ] planned today due:2026-12-04 @scheduled:2026-11-27',
        '- [ ] planned monday due:2026-12-04 @scheduled:2026-11-30',
        '- [ ] due friday due:2026-12-04',
        '- [ ] planned only @scheduled:2026-12-01',
        '- [ ] nothing'
      ].join('\n')
    )
    expect(names(g.today)).toEqual(['planned today'])
    expect(names(g.upcoming)).toEqual(['planned monday', 'planned only', 'due friday'])
    expect(names(g.undated)).toEqual(['nothing'])
    expect(g.overdueCount).toBe(0)
  })

  it('counts only a passed deadline as overdue', () => {
    const g = group(
      [
        '- [ ] missed plan due:2026-12-04 @scheduled:2026-11-25',
        '- [ ] late due:2026-11-20 @scheduled:2026-11-30',
        '- [ ] plainly late due:2026-11-26'
      ].join('\n')
    )
    expect(names(g.today)).toEqual(['late', 'plainly late', 'missed plan'])
    expect(g.overdueCount).toBe(2)
    expect(g.upcoming).toEqual([])
  })

  it('leaves done, cancelled, forwarded and waiting tasks in their groups', () => {
    const g = group(
      [
        '- [x] done @scheduled:2026-11-27',
        '- [-] cancelled @scheduled:2026-11-27',
        '- [>] forwarded @scheduled:2026-11-27',
        '- [ ] waiting @waiting @scheduled:2026-11-27'
      ].join('\n')
    )
    expect(names(g.done)).toEqual(['done'])
    expect(names(g.cancelled)).toEqual(['cancelled'])
    expect(names(g.forwarded)).toEqual(['forwarded'])
    expect(names(g.waiting)).toEqual(['waiting'])
    expect(g.today).toEqual([])
    expect(g.upcoming).toEqual([])
  })
})

describe('the calendars place by the planned day', () => {
  const tasks = lines(
    [
      '- [ ] planned due:2026-12-04 @scheduled:2026-12-02',
      '- [ ] due only due:2026-12-04',
      '- [ ] missed @scheduled:2026-11-20',
      '- [ ] late due:2026-11-20 @scheduled:2026-12-02',
      '- [x] done @scheduled:2026-12-02',
      '- [-] cancelled @scheduled:2026-12-02',
      '- [ ] waiting @waiting @scheduled:2026-12-02',
      '- [>] forwarded @scheduled:2026-12-02',
      '- [>] forwarded bare',
      '- [ ] nothing'
    ].join('\n')
  )
  const names = (list: VaultTask[] | undefined) => (list ?? []).map((t) => t.content)

  it('buckets every open task on the day taskDay gives it', () => {
    const buckets = bucketTasksByDay(tasks, TODAY)
    expect(names(buckets.get('2026-12-02'))).toEqual(['planned', 'waiting', 'forwarded'])
    expect(names(buckets.get('2026-12-04'))).toEqual(['due only'])
    expect(names(buckets.get(TODAY))).toEqual(['missed'])
    expect(names(buckets.get('2026-11-20'))).toEqual(['late'])
    expect(names(buckets.get('unscheduled'))).toEqual(['nothing'])
  })

  it('agrees with tasksOnDay for every day', () => {
    const buckets = bucketTasksByDay(tasks, TODAY)
    for (const [day, list] of buckets) {
      if (day === 'unscheduled') continue
      expect(names(tasksOnDay(tasks, day, TODAY))).toEqual(names(list))
    }
    expect(tasksOnDay(tasks, '2026-12-03', TODAY)).toEqual([])
  })
})

describe('setPlannedDayField: the editor\'s edit of the line under the cursor', () => {
  it('adds the field at the end, or before a block id, which must end the line', () => {
    expect(setPlannedDayField(' a due:2026-12-04', '2026-12-02')).toBe(' a due:2026-12-04 @scheduled:2026-12-02')
    expect(setPlannedDayField(' a ^gym', '2026-12-02')).toBe(' a @scheduled:2026-12-02 ^gym')
  })

  it('replaces a planned day where it stands', () => {
    expect(setPlannedDayField(' a @scheduled:2026-12-02 due:2026-12-04', '2026-12-03')).toBe(
      ' a @scheduled:2026-12-03 due:2026-12-04'
    )
  })

  it('removes the field and tidies the gap it leaves', () => {
    expect(setPlannedDayField(' a @scheduled:2026-12-02 due:2026-12-04', null)).toBe(' a due:2026-12-04')
    expect(setPlannedDayField(' a due:2026-12-04 @scheduled:2026-12-02', null)).toBe(' a due:2026-12-04')
    expect(setPlannedDayField(' a @Scheduled:2026-12-02 #tag', null)).toBe(' a #tag')
  })

  it('leaves text without the field exactly as it was when there is nothing to remove', () => {
    expect(setPlannedDayField(' a  b  ', null)).toBe(' a  b  ')
    expect(setPlannedDayField(' mail me@scheduled:now', null)).toBe(' mail me@scheduled:now')
  })
})

describe('the set-field edit the Tasks surfaces make', () => {
  it('writes, replaces and clears @scheduled: on a checkbox line', () => {
    const planned = setTaskFieldAtIndex('- [ ] a due:2026-12-04', 0, 'scheduled', '2026-12-02')
    expect(planned).toBe('- [ ] a due:2026-12-04 @scheduled:2026-12-02')
    expect(parse(planned).due).toBe('2026-12-04')
    expect(setTaskFieldAtIndex(planned, 0, 'scheduled', '2026-12-03')).toBe(
      '- [ ] a due:2026-12-04 @scheduled:2026-12-03'
    )
    expect(setTaskFieldAtIndex(planned, 0, 'scheduled', null)).toBe('- [ ] a due:2026-12-04')
  })

  it('keeps a block id at the end of its line, where it has to be', () => {
    const planned = setTaskFieldAtIndex('- [ ] Gym ^gym', 0, 'scheduled', '2026-12-02')
    expect(planned).toBe('- [ ] Gym @scheduled:2026-12-02 ^gym')
    expect(parse(planned).content).toBe('Gym')
    expect(plannedDay(parse(planned))).toBe('2026-12-02')
    expect(setTaskFieldAtIndex(planned, 0, 'scheduled', null)).toBe('- [ ] Gym ^gym')
  })

  it('writes frontmatter scheduled: on a task note and takes it off again', () => {
    const note = '---\ntags: [task]\ndue: 2026-12-04\n---\nBody\n'
    const planned = updateFrontmatterFields(note, { scheduled: '2026-12-02' })
    const task = parseTaskFile(planned, { path: 'inbox/Plan.md', title: 'Plan', folder: 'inbox' })!
    expect(plannedDay(task)).toBe('2026-12-02')
    expect(task.due).toBe('2026-12-04')
    expect(updateFrontmatterFields(planned, { scheduled: null })).toBe(note)
  })
})
