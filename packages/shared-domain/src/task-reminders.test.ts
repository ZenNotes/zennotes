import { describe, expect, it } from 'vitest'
import {
  computeTaskReminders,
  describeRemindSpec,
  parseClockToken,
  parseRemindSpec,
  plainTaskTitle
} from './task-reminders'
import { inferDailyTaskDueDates, parseTasksFromBody } from './tasks'

const ctx = { path: 'Home.md', title: 'Home', folder: 'inbox' as const }

describe('parseClockToken', () => {
  it('reads every written form', () => {
    expect(parseClockToken('9am')).toEqual({ hour: 9, minute: 0 })
    expect(parseClockToken('930am')).toEqual({ hour: 9, minute: 30 })
    expect(parseClockToken('12am')).toEqual({ hour: 0, minute: 0 })
    expect(parseClockToken('12pm')).toEqual({ hour: 12, minute: 0 })
    expect(parseClockToken('1230pm')).toEqual({ hour: 12, minute: 30 })
    expect(parseClockToken('0930')).toEqual({ hour: 9, minute: 30 })
    expect(parseClockToken('1730')).toEqual({ hour: 17, minute: 30 })
    expect(parseClockToken('17h')).toEqual({ hour: 17, minute: 0 })
    expect(parseClockToken('17h30')).toEqual({ hour: 17, minute: 30 })
  })

  it('refuses times that are not', () => {
    for (const bad of ['13pm', '0am', '2460', '930', '9', '25h', '9:30am', 'noon']) {
      expect(parseClockToken(bad)).toBeNull()
    }
  })
})

describe('parseRemindSpec', () => {
  it('reads a time, a day offset, and both', () => {
    expect(parseRemindSpec('9am')).toEqual({ daysBefore: 0, time: { hour: 9, minute: 0 } })
    expect(parseRemindSpec('1d')).toEqual({ daysBefore: 1, time: null })
    expect(parseRemindSpec('2d-6pm')).toEqual({ daysBefore: 2, time: { hour: 18, minute: 0 } })
    expect(parseRemindSpec('2d-later')).toBeNull()
    expect(parseRemindSpec('soon')).toBeNull()
  })

  it('describes them briefly', () => {
    expect(describeRemindSpec(parseRemindSpec('9am')!)).toBe('9:00 AM')
    expect(describeRemindSpec(parseRemindSpec('1730')!, '24h')).toBe('17:30')
    expect(describeRemindSpec(parseRemindSpec('1d')!)).toBe('Day before')
    expect(describeRemindSpec(parseRemindSpec('2d-6pm')!)).toBe('2 days before, 6:00 PM')
  })
})

describe('computeTaskReminders', () => {
  const now = new Date(2026, 10, 1, 8, 0)

  it('schedules open tasks with a due date, in local time, earliest first', () => {
    const tasks = parseTasksFromBody(
      [
        '- [ ] Pay rent @remind:1d due:2026-11-03',
        '- [ ] Water the [[Plants|plants]] @remind:9am due:2026-11-01',
        '- [x] Done @remind:9am due:2026-11-01',
        '- [-] Cancelled @remind:9am due:2026-11-01',
        '- [ ] No date @remind:9am',
        '- [ ] Bad @remind:whenever due:2026-11-01',
        '- [ ] Waiting @waiting @remind:1730 due:2026-11-02'
      ].join('\n'),
      ctx
    )
    const out = computeTaskReminders(tasks, { now, defaultTime: '08:30' })
    expect(out.map((r) => [r.title, new Date(r.fireAt).toString(), r.body])).toEqual([
      ['Water the plants', new Date(2026, 10, 1, 9, 0).toString(), 'Due today · Home'],
      ['Pay rent', new Date(2026, 10, 2, 8, 30).toString(), 'Due tomorrow · Home'],
      ['Waiting', new Date(2026, 10, 2, 17, 30).toString(), 'Due today · Home']
    ])
    expect(out[0].key).toBe(`Home.md\nWater the plants\n${out[0].fireAt}`)
  })

  it('keeps the last day for a host to catch up on, and drops what is further out', () => {
    const tasks = parseTasksFromBody(
      [
        '- [ ] Yesterday @remind:9am due:2026-10-31',
        '- [ ] Last week @remind:9am due:2026-10-20',
        '- [ ] Next month @remind:9am due:2026-12-20'
      ].join('\n'),
      ctx
    )
    expect(computeTaskReminders(tasks, { now }).map((r) => r.title)).toEqual(['Yesterday'])
  })

  it('reminds a daily-note task on its note date', () => {
    const tasks = inferDailyTaskDueDates(
      parseTasksFromBody('- [ ] Call Mum @remind:6pm', { ...ctx, path: 'daily/2026-11-01.md' }),
      new Map([['daily/2026-11-01.md', '2026-11-01']])
    )
    expect(computeTaskReminders(tasks, { now }).map((r) => new Date(r.fireAt).getHours())).toEqual([18])
  })

  it('names a due date further out by its day', () => {
    const tasks = parseTasksFromBody('- [ ] Trip @remind:3d due:2026-11-06', ctx)
    expect(computeTaskReminders(tasks, { now })[0].body).toBe('Due Fri, Nov 6 · Home')
  })
})

describe('plainTaskTitle', () => {
  it('drops markdown a notification would show literally', () => {
    expect(plainTaskTitle('Read **[[Book|the book]]** and `code` [site](https://x.y)')).toBe(
      'Read the book and code site'
    )
  })
})
