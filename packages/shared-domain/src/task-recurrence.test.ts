import { describe, expect, it } from 'vitest'
import cases from './task-recurrence.cases.json'
import {
  completeRecurringTaskAtIndex,
  describeRepeatRule,
  nextRepeatDate,
  parseRepeatRule,
  planRecurringCompletion,
  setRemindField,
  setRepeatField,
  completeRecurringTaskAtLine
} from './task-recurrence'
import { parseTasksFromBody } from './tasks'

interface Case {
  name: string
  body: string
  taskIndex: number
  today: string
  fallbackDue?: string
  skip?: boolean
  expected: string | null
}

describe('completeRecurringTaskAtIndex (the shared case table)', () => {
  for (const c of (cases as { cases: Case[] }).cases) {
    it(c.name, () => {
      const result = completeRecurringTaskAtIndex(c.body, c.taskIndex, {
        today: c.today,
        fallbackDue: c.fallbackDue,
        skip: c.skip
      })
      expect(result?.body ?? null).toBe(c.expected)
    })
  }

  it('parses back as one open occurrence above a closed record', () => {
    const result = completeRecurringTaskAtIndex(
      '- [ ] Water @repeat:weekly due:2026-11-01 @remind:9am',
      0,
      { today: '2026-11-01' }
    )!
    const tasks = parseTasksFromBody(result.body, { path: 'a.md', title: 'a', folder: 'inbox' })
    expect(tasks.map((t) => [t.checked, t.due, t.fields?.repeat ?? null, t.fields?.remind ?? null])).toEqual([
      [false, '2026-11-08', 'weekly', '9am'],
      [true, '2026-11-01', null, null]
    ])
    expect(result.insertedLines).toBe(1)
    expect(result.nextDue).toBe('2026-11-08')
  })

  it('leaves only the fresh copies open on the Tasks list', () => {
    const body = '- [ ] Review @repeat:weekly due:2026-11-01\n  - [x] Inbox\n  - [ ] Plan'
    const result = completeRecurringTaskAtIndex(body, 0, { today: '2026-11-01' })!
    const open = parseTasksFromBody(result.body, { path: 'a.md', title: 'a', folder: 'inbox' })
      .filter((t) => !t.checked && !t.cancelled)
      .map((t) => [t.content, t.lineNumber])
    expect(open).toEqual([
      ['Review', 0],
      ['Inbox', 1],
      ['Plan', 2]
    ])
  })
})

describe('parseRepeatRule', () => {
  it('reads the named rules, intervals, day lists and after- rules', () => {
    expect(parseRepeatRule('daily')).toEqual({ kind: 'interval', unit: 'day', every: 1, afterDone: false })
    expect(parseRepeatRule('Weekly')).toEqual({ kind: 'interval', unit: 'week', every: 1, afterDone: false })
    expect(parseRepeatRule('annually')).toEqual({ kind: 'interval', unit: 'year', every: 1, afterDone: false })
    expect(parseRepeatRule('6m')).toEqual({ kind: 'interval', unit: 'month', every: 6, afterDone: false })
    expect(parseRepeatRule('after-2w')).toEqual({ kind: 'interval', unit: 'week', every: 2, afterDone: true })
    expect(parseRepeatRule('weekdays')).toEqual({ kind: 'days', days: [1, 2, 3, 4, 5] })
    expect(parseRepeatRule('thu/mon/thu')).toEqual({ kind: 'days', days: [1, 4] })
  })

  it('names no rule for anything else', () => {
    for (const bad of ['', 'fortnightly', '0d', '2x', 'after-mon', 'mon/funday', '1000d']) {
      expect(parseRepeatRule(bad)).toBeNull()
    }
  })

  it('describes rules in a few words', () => {
    const label = (v: string): string => describeRepeatRule(parseRepeatRule(v)!)
    expect(label('weekly')).toBe('Weekly')
    expect(label('2w')).toBe('Every 2 weeks')
    expect(label('weekdays')).toBe('Weekdays')
    expect(label('mon/thu')).toBe('Mon, Thu')
    expect(label('after-1d')).toBe('1 day after done')
    expect(label('after-3d')).toBe('3 days after done')
  })
})

describe('nextRepeatDate', () => {
  const rule = (v: string) => parseRepeatRule(v)!

  it('counts months from the due date, so a late finish does not compound the clamp', () => {
    expect(nextRepeatDate(rule('monthly'), '2027-01-31', '2027-03-05')).toBe('2027-03-31')
  })

  it('never lands on today or earlier', () => {
    expect(nextRepeatDate(rule('weekly'), '2026-10-26', '2026-11-02')).toBe('2026-11-09')
    expect(nextRepeatDate(rule('daily'), '2026-11-01', '2026-11-01')).toBe('2026-11-02')
    expect(nextRepeatDate(rule('mon'), '2026-10-05', '2026-11-02')).toBe('2026-11-09')
  })

  it('crosses daylight saving without shifting a day', () => {
    expect(nextRepeatDate(rule('daily'), '2026-03-07', '2026-03-07')).toBe('2026-03-08')
    expect(nextRepeatDate(rule('weekly'), '2026-10-24', '2026-10-24')).toBe('2026-10-31')
  })
})

describe('planRecurringCompletion', () => {
  it('reports the next occurrence and the record block for an editor line', () => {
    const plan = planRecurringCompletion(
      ['- [ ] A @repeat:daily', '  - [x] done child', '  - [ ] open child', 'after'],
      0,
      { today: '2026-11-01' }
    )
    expect(plan?.next).toEqual([
      '- [ ] A @repeat:daily due:2026-11-02',
      '  - [ ] done child',
      '  - [ ] open child'
    ])
    expect(plan?.record).toBe('- [x] A')
    expect(plan?.recordChildren).toEqual(['  - [x] done child', '  - [-] open child'])
    expect(plan?.replaces).toBe(3)
  })
})

describe('setRepeatField / setRemindField', () => {
  it('replaces a rule where it stands, adds one at the end, and removes it', () => {
    expect(setRepeatField('Water @repeat:daily due:2026-11-01', 'weekly')).toBe(
      'Water @repeat:weekly due:2026-11-01'
    )
    expect(setRepeatField('Water due:2026-11-01', 'weekly')).toBe('Water due:2026-11-01 @repeat:weekly')
    expect(setRepeatField('Water @repeat:daily due:2026-11-01', null)).toBe('Water due:2026-11-01')
    expect(setRemindField('Pay rent', '1d')).toBe('Pay rent @remind:1d')
    expect(setRemindField('Pay rent @remind:1d', null)).toBe('Pay rent')
  })
})

describe('completeRecurringTaskAtLine', () => {
  const today = '2099-01-01'

  it('finishes the task on that line, whatever the counting above it', () => {
    const body = '    ```\n    - [ ] looks like a task\n    ```\n- [ ] water @repeat:daily due:2099-01-01\n'
    const done = completeRecurringTaskAtLine(body, 3, { today })
    expect(done?.body.split('\n').slice(3, 5)).toEqual([
      '- [ ] water @repeat:daily due:2099-01-02',
      expect.stringMatching(/^- \[x\] water/)
    ])
  })

  it('answers null for a line that is not an open recurring task', () => {
    const body = '- [ ] plain\n- [x] water @repeat:daily due:2099-01-01\n'
    expect(completeRecurringTaskAtLine(body, 0, { today })).toBeNull()
    expect(completeRecurringTaskAtLine(body, 1, { today })).toBeNull()
    expect(completeRecurringTaskAtLine(body, 9, { today })).toBeNull()
  })
})
