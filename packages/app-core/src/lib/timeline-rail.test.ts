import { describe, expect, it } from 'vitest'
import { inferDailyTaskDueDates, type VaultTask } from '@shared/tasks'
import {
  buildTimelineRail,
  daysBetween,
  isMilestoneTask,
  normalizeTimelineRange,
  timelineDayLabel,
  timelineRangeEnd,
  type TimelineEntry
} from './timeline-rail'
import { filterTasks, noteTagsByPath } from './tasks-filter'

// Wednesday 28 October 2026, local time.
const TODAY = new Date(2026, 9, 28, 15, 30)

function task(id: string, overrides?: Partial<VaultTask>): VaultTask {
  return {
    id,
    sourcePath: `${id}.md`,
    noteTitle: id,
    noteFolder: 'inbox',
    lineNumber: 0,
    taskIndex: 0,
    rawText: `- [ ] ${id}`,
    content: id,
    checked: false,
    forwarded: false,
    cancelled: false,
    inProgress: false,
    waiting: false,
    tags: [],
    ...overrides
  }
}

/** The rail as a list of short strings, which reads like the panel does. */
function shape(entries: TimelineEntry[]): string[] {
  return entries.map((entry) => {
    if (entry.kind === 'quiet') return `quiet ${entry.days}`
    const rows = entry.rows.map((r) => r.task.id).join(',')
    if (entry.kind === 'overdue') return `overdue ${rows}`
    return `${entry.today ? 'today ' : ''}${entry.milestone ? 'milestone ' : ''}${entry.iso} ${rows}`.trim()
  })
}

describe('buildTimelineRail', () => {
  it('lays out overdue, today, and each later day with work, folding quiet days', () => {
    const rail = buildTimelineRail(
      [
        task('later', { due: '2026-11-02' }),
        task('old', { due: '2026-10-20' }),
        task('yesterday', { due: '2026-10-27' }),
        task('today', { due: '2026-10-28' }),
        task('tomorrow', { due: '2026-10-29' }),
        task('undated')
      ],
      { today: TODAY, range: 'two-weeks' }
    )
    expect(shape(rail.entries)).toEqual([
      'overdue old,yesterday',
      'today 2026-10-28 today',
      '2026-10-29 tomorrow',
      'quiet 3',
      '2026-11-02 later'
    ])
    expect(rail.openCount).toBe(5)
    expect(rail.overdueCount).toBe(2)
    expect(rail.undatedCount).toBe(1)
    expect(rail.rows.map((r) => r.task.id)).toEqual(['old', 'yesterday', 'today', 'tomorrow', 'later'])
  })

  it('marks how late each overdue task is, in whole days', () => {
    const rail = buildTimelineRail(
      [task('a', { due: '2026-10-27' }), task('b', { due: '2026-09-28' }), task('c', { due: '2026-10-28' })],
      { today: TODAY, range: 'two-weeks' }
    )
    const late = Object.fromEntries(rail.rows.map((r) => [r.task.id, r.lateDays]))
    expect(late).toEqual({ b: 30, a: 1, c: 0 })
  })

  it('always draws today, empty or not, and no quiet line before the first later day when it is tomorrow', () => {
    const empty = buildTimelineRail([], { today: TODAY, range: 'two-weeks' })
    expect(shape(empty.entries)).toEqual(['today 2026-10-28'])
    expect(empty.openCount).toBe(0)

    const next = buildTimelineRail([task('t', { due: '2026-10-29' })], { today: TODAY, range: 'two-weeks' })
    expect(shape(next.entries)).toEqual(['today 2026-10-28', '2026-10-29 t'])
  })

  it('folds a single empty day too, and counts it', () => {
    const rail = buildTimelineRail([task('t', { due: '2026-10-30' })], { today: TODAY, range: 'two-weeks' })
    expect(shape(rail.entries)).toEqual(['today 2026-10-28', 'quiet 1', '2026-10-30 t'])
  })

  it('takes which tasks count from the Tasks groups: no done, cancelled, waiting or forwarded', () => {
    const rail = buildTimelineRail(
      [
        task('done', { due: '2026-10-29', checked: true }),
        task('cancelled', { due: '2026-10-29', cancelled: true }),
        task('waiting', { due: '2026-10-29', waiting: true }),
        task('forwarded', { due: '2026-10-29', forwarded: true }),
        task('doing', { due: '2026-10-29', inProgress: true, rawText: '- [/] doing' }),
        task('waiting-undated', { waiting: true })
      ],
      { today: TODAY, range: 'two-weeks' }
    )
    expect(rail.rows.map((r) => r.task.id)).toEqual(['doing'])
    // The Tasks list keeps @waiting in its own group, not under No due date.
    expect(rail.undatedCount).toBe(0)
  })

  it('takes a daily note’s inferred date, as the calendar panel does', () => {
    const daily = task('from-daily', { sourcePath: 'Daily/2026-10-30.md' })
    const inferred = inferDailyTaskDueDates([daily], new Map([['Daily/2026-10-30.md', '2026-10-30']]))
    const rail = buildTimelineRail(inferred, { today: TODAY, range: 'two-weeks' })
    expect(shape(rail.entries)).toEqual(['today 2026-10-28', 'quiet 1', '2026-10-30 from-daily'])
    expect(rail.undatedCount).toBe(0)
  })

  it('cuts the range at two weeks, a month, or not at all, and counts what lies past it', () => {
    const tasks = [
      task('in-two-weeks', { due: '2026-11-10' }),
      task('past-two-weeks', { due: '2026-11-11' }),
      task('in-month', { due: '2026-11-28' }),
      task('past-month', { due: '2026-11-29' }),
      task('next-year', { due: '2027-03-01' }),
      task('overdue', { due: '2025-01-01' })
    ]
    const twoWeeks = buildTimelineRail(tasks, { today: TODAY, range: 'two-weeks' })
    expect(twoWeeks.rangeEnd).toBe('2026-11-10')
    expect(twoWeeks.rows.map((r) => r.task.id)).toEqual(['overdue', 'in-two-weeks'])
    expect(twoWeeks.laterCount).toBe(4)

    const month = buildTimelineRail(tasks, { today: TODAY, range: 'month' })
    expect(month.rangeEnd).toBe('2026-11-28')
    expect(month.rows.map((r) => r.task.id)).toEqual([
      'overdue',
      'in-two-weeks',
      'past-two-weeks',
      'in-month'
    ])
    expect(month.laterCount).toBe(2)

    const all = buildTimelineRail(tasks, { today: TODAY, range: 'all' })
    expect(all.rangeEnd).toBeNull()
    expect(all.rows).toHaveLength(6)
    expect(all.laterCount).toBe(0)
  })

  it('draws a #milestone day as a milestone and leads the day with it', () => {
    const rail = buildTimelineRail(
      [
        task('prep', { due: '2026-11-02' }),
        task('launch', { due: '2026-11-02', tags: ['milestone'] }),
        task('plain', { due: '2026-11-03' })
      ],
      { today: TODAY, range: 'two-weeks' }
    )
    expect(shape(rail.entries)).toEqual([
      'today 2026-10-28',
      'quiet 4',
      'milestone 2026-11-02 launch,prep',
      '2026-11-03 plain'
    ])
    expect(rail.rows.find((r) => r.task.id === 'launch')?.milestone).toBe(true)
    expect(rail.rows.find((r) => r.task.id === 'prep')?.milestone).toBe(false)
  })

  it('counts the open tasks before each milestone since the previous one, overdue included for the first', () => {
    const rail = buildTimelineRail(
      [
        task('late', { due: '2026-10-26' }),
        task('today', { due: '2026-10-28' }),
        task('alpha', { due: '2026-10-30', tags: ['milestone'] }),
        task('same-day-as-alpha', { due: '2026-10-30' }),
        task('between', { due: '2026-11-02' }),
        task('beta', { due: '2026-11-05', tags: ['milestone'] }),
        task('gamma', { due: '2026-11-05', tags: ['milestone'] }),
        task('after', { due: '2026-11-06' })
      ],
      { today: TODAY, range: 'two-weeks' }
    )
    const before = Object.fromEntries(
      rail.rows.filter((r) => r.milestone).map((r) => [r.task.id, r.before])
    )
    // alpha: late + today. beta: alpha's day onward, so its same-day task and
    // `between`. gamma shares beta's day: nothing new stands before it.
    expect(before).toEqual({ alpha: 2, beta: 2, gamma: 0 })
    expect(rail.rows.find((r) => r.task.id === 'after')?.before).toBeNull()
  })

  it('counts over what the filter leaves, so the number matches the rows above the diamond', () => {
    const tasks = [
      task('a', { due: '2026-10-29', fields: { project: 'alpha' }, content: 'a' }),
      task('b', { due: '2026-10-29', content: 'b' }),
      task('ship', { due: '2026-10-31', tags: ['milestone'], fields: { project: 'alpha' }, content: 'ship' })
    ]
    const rail = buildTimelineRail(filterTasks(tasks, '@project:alpha'), {
      today: TODAY,
      range: 'two-weeks'
    })
    expect(rail.rows.map((r) => r.task.id)).toEqual(['a', 'ship'])
    expect(rail.rows.find((r) => r.task.id === 'ship')?.before).toBe(1)
  })

  it('counts undated tasks that the filter leaves', () => {
    const rail = buildTimelineRail(
      filterTasks([task('alpha one'), task('beta two'), task('alpha dated', { due: '2026-10-29' })], 'alpha'),
      { today: TODAY, range: 'two-weeks' }
    )
    expect(rail.undatedCount).toBe(1)
    expect(rail.openCount).toBe(1)
  })
})

describe('isMilestoneTask', () => {
  it('reads the tag on a checkbox line, whatever its case', () => {
    expect(isMilestoneTask(task('a', { tags: ['milestone'] }))).toBe(true)
    expect(isMilestoneTask(task('c', { tags: ['MileStone'] }))).toBe(true)
    expect(isMilestoneTask(task('b', { tags: ['milestones', 'milestone-ish'] }))).toBe(false)
  })

  it('reads a whole-note task’s body tags, but not a checkbox task’s note', () => {
    const notes = noteTagsByPath([
      { path: 'file.md', tags: ['task', 'Milestone'] },
      { path: 'inline.md', tags: ['milestone'] }
    ])
    expect(isMilestoneTask(task('file', { kind: 'file' }), notes)).toBe(true)
    expect(isMilestoneTask(task('inline'), notes)).toBe(false)
  })
})

describe('timeline ranges and labels', () => {
  it('ends two weeks after 13 more days and a month on the same date next month', () => {
    expect(timelineRangeEnd(TODAY, 'two-weeks')).toBe('2026-11-10')
    expect(timelineRangeEnd(TODAY, 'month')).toBe('2026-11-28')
    expect(timelineRangeEnd(new Date(2027, 0, 31), 'month')).toBe('2027-02-28')
    expect(timelineRangeEnd(new Date(2028, 0, 31), 'month')).toBe('2028-02-29')
    expect(timelineRangeEnd(TODAY, 'all')).toBeNull()
  })

  it('normalizes a stored range, falling back to two weeks', () => {
    expect(normalizeTimelineRange('month')).toBe('month')
    expect(normalizeTimelineRange('all')).toBe('all')
    expect(normalizeTimelineRange('year')).toBe('two-weeks')
    expect(normalizeTimelineRange(undefined)).toBe('two-weeks')
  })

  it('counts days across a daylight-saving change as whole days', () => {
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2)
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2)
    expect(daysBetween('2026-10-31', '2026-11-02')).toBe(2)
  })

  it('labels a day by weekday and date, adding the month and year only when they differ', () => {
    const weekday = (d: Date): string => d.toLocaleDateString(undefined, { weekday: 'short' })
    const month = (d: Date): string => d.toLocaleDateString(undefined, { month: 'short' })
    expect(timelineDayLabel('2026-10-28', TODAY)).toBe(`${weekday(TODAY)} 28`)
    const nov2 = new Date(2026, 10, 2)
    expect(timelineDayLabel('2026-11-02', TODAY)).toBe(`${weekday(nov2)} 2 ${month(nov2)}`)
    const jan4 = new Date(2027, 0, 4)
    expect(timelineDayLabel('2027-01-04', TODAY)).toBe(`${weekday(jan4)} 4 ${month(jan4)} 2027`)
  })
})
