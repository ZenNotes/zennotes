import { describe, expect, it } from 'vitest'
import {
  bucketTasksByDay,
  inferDailyTaskDueDates,
  parseTasksFromBody,
  tasksOnDay,
  toIsoDateLocal,
  type ParseTasksContext
} from '@shared/tasks'

// These tasks have no planned day, so the day they sit on does not depend on
// today; any date serves.
const TODAY = '2026-01-01'

const ctx: ParseTasksContext = {
  path: 'inbox/test.md',
  title: 'test',
  folder: 'inbox'
}

function tasks(body: string): ReturnType<typeof parseTasksFromBody> {
  return parseTasksFromBody(body, ctx)
}

describe('toIsoDateLocal', () => {
  it('formats local Y-M-D with zero padding', () => {
    expect(toIsoDateLocal(new Date(2026, 0, 5))).toBe('2026-01-05')
  })
})

describe('tasksOnDay', () => {
  it('returns unchecked tasks — including @waiting — matching the iso, dropping done (#311)', () => {
    const all = tasks(
      [
        '- [ ] today  due:2026-04-30',
        '- [ ] tomorrow  due:2026-05-01',
        '- [x] done  due:2026-04-30',
        '- [ ] waiting  due:2026-04-30 @waiting'
      ].join('\n')
    )
    const due = tasksOnDay(all, '2026-04-30', TODAY)
    // #311: a @waiting task with a due date must appear here too (the sidepanel
    // calendar was under-counting them vs the Tasks calendar). Only done
    // (checked) and other-date tasks are excluded.
    expect(due.map((t) => t.content).sort()).toEqual(['today', 'waiting'])
  })

  it('drops cancelled tasks (#476)', () => {
    const all = tasks(['- [ ] live  due:2026-04-30', '- [-] scrapped  due:2026-04-30'].join('\n'))
    expect(tasksOnDay(all, '2026-04-30', TODAY).map((t) => t.content)).toEqual(['live'])
  })
})

describe('bucketTasksByDay', () => {
  it('groups by due date and surfaces unscheduled separately', () => {
    const all = tasks(
      [
        '- [ ] a  due:2026-04-30',
        '- [ ] b  due:2026-04-30',
        '- [ ] c  due:2026-05-01',
        '- [ ] d nodate'
      ].join('\n')
    )
    const buckets = bucketTasksByDay(all, TODAY)
    expect(buckets.get('2026-04-30')?.length).toBe(2)
    expect(buckets.get('2026-05-01')?.length).toBe(1)
    expect(buckets.get('unscheduled')?.length).toBe(1)
  })

  it('drops checked (done) tasks but keeps waiting tasks on their due date (#236)', () => {
    const all = tasks(
      [
        '- [x] done  due:2026-04-30',
        '- [ ] waiting  due:2026-04-30 @waiting',
        '- [ ] live  due:2026-04-30'
      ].join('\n')
    )
    const buckets = bucketTasksByDay(all, TODAY)
    const bucket = buckets.get('2026-04-30') ?? []
    // The done task is dropped; the waiting-with-due task now shows alongside live.
    expect(bucket.length).toBe(2)
    expect(bucket.map((t) => t.content)).toEqual(expect.arrayContaining(['waiting', 'live']))
  })

  it('drops cancelled tasks from both the day buckets and "unscheduled" (#476)', () => {
    const all = tasks(
      [
        '- [ ] live  due:2026-04-30',
        '- [-] scrapped  due:2026-04-30',
        '- [-] scrapped undated'
      ].join('\n')
    )
    const buckets = bucketTasksByDay(all, TODAY)
    expect(buckets.get('2026-04-30')?.map((t) => t.content)).toEqual(['live'])
    expect(buckets.get('unscheduled')).toBeUndefined()
  })

  it('shows a @waiting + due task on the calendar regardless of token order (#236)', () => {
    const all = tasks(
      [
        '- [ ] Task with wait @waiting',
        '- [ ] Task with due due:2026-06-27',
        '- [ ] Task with both @waiting due:2026-06-27',
        '- [ ] Other layout due:2026-06-27 @waiting'
      ].join('\n')
    )
    const buckets = bucketTasksByDay(all, TODAY)
    // The three due:2026-06-27 tasks all land on the date (two of them waiting);
    // the bare @waiting task with no due date is unscheduled.
    expect(buckets.get('2026-06-27')?.length).toBe(3)
    expect(buckets.get('unscheduled')?.length).toBe(1)
  })
})

describe('inferDailyTaskDueDates', () => {
  const dailyA = parseTasksFromBody('- [ ] a\n- [ ] b due:2026-07-01', {
    path: 'inbox/Daily Notes/2026-06-17.md',
    title: '2026-06-17',
    folder: 'inbox'
  })
  const dueByPath = new Map([['inbox/Daily Notes/2026-06-17.md', '2026-06-17']])

  it('gives undated daily-note tasks the note date, flagged inferred', () => {
    const out = inferDailyTaskDueDates(dailyA, dueByPath)
    expect(out[0].due).toBe('2026-06-17')
    expect(out[0].dueInferred).toBe(true)
  })

  it('never overrides an explicit due token', () => {
    const out = inferDailyTaskDueDates(dailyA, dueByPath)
    expect(out[1].due).toBe('2026-07-01')
    expect(out[1].dueInferred).toBeUndefined()
  })

  it('leaves tasks outside any daily note untouched', () => {
    const other = parseTasksFromBody('- [ ] loose', {
      path: 'inbox/Loose.md',
      title: 'Loose',
      folder: 'inbox'
    })
    const out = inferDailyTaskDueDates(other, dueByPath)
    expect(out[0].due).toBeUndefined()
  })

  it('returns the same array instance when nothing changes', () => {
    const out = inferDailyTaskDueDates(dailyA, new Map())
    expect(out).toBe(dailyA)
  })

  it('makes inferred tasks show up in their day bucket', () => {
    const out = inferDailyTaskDueDates(dailyA, dueByPath)
    expect(tasksOnDay(out, '2026-06-17', TODAY).length).toBe(1)
  })
})
