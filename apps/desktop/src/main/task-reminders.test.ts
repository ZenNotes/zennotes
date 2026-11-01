import { describe, expect, it } from 'vitest'
import type { TaskReminder } from '@zennotes/bridge-contract/tasks'
import {
  createTaskReminderScheduler,
  sanitizeReminders,
  type ReminderNotice,
  type TaskReminderHost
} from './task-reminders'

const MIN = 60_000
const HOUR = 60 * MIN

function reminder(title: string, fireAt: number, path = 'Home.md'): TaskReminder {
  return { key: `${path}\n${title}\n${fireAt}`, fireAt, title, body: `Due today · Home`, path, taskIndex: 0 }
}

/** A host with a hand-turned clock and timers, and a file in memory. */
function fakeHost(start: number, file: string | null = null) {
  let now = start
  let stored = file
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const notices: ReminderNotice[] = []
  const host: TaskReminderHost = {
    now: () => now,
    notify: (n) => notices.push(n),
    readState: async () => stored,
    writeState: async (text) => {
      stored = text
    },
    setTimer: (fn, ms) => {
      const id = ++seq
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimer: (id) => {
      timers.delete(id as number)
    }
  }
  /** Move the clock, firing timers in order as their time comes. */
  const advance = (ms: number): void => {
    const until = now + ms
    for (;;) {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (!next || next[1].at > until) break
      timers.delete(next[0])
      now = next[1].at
      next[1].fn()
    }
    now = until
  }
  return { host, notices, advance, stored: () => stored, setNow: (t: number) => (now = t) }
}

const T0 = new Date(2026, 10, 1, 8, 0).getTime()

describe('task reminder scheduler', () => {
  it('fires each reminder once, on time', async () => {
    const h = fakeHost(T0)
    const s = createTaskReminderScheduler(h.host)
    await s.start()
    s.setSchedule(1, [reminder('Water', T0 + HOUR), reminder('Call', T0 + 2 * HOUR)])
    h.advance(HOUR - 1000)
    expect(h.notices).toEqual([])
    h.advance(2000)
    expect(h.notices.map((n) => n.title)).toEqual(['Water'])
    expect(h.notices[0].target).toEqual({ path: 'Home.md', title: 'Water', taskIndex: 0 })
    // The renderer re-sends the schedule on every task change; no repeat.
    s.setSchedule(1, [reminder('Water', T0 + HOUR), reminder('Call', T0 + 2 * HOUR)])
    h.advance(HOUR)
    expect(h.notices.map((n) => n.title)).toEqual(['Water', 'Call'])
  })

  it('never fires a reminder set for a time already past', async () => {
    const h = fakeHost(T0)
    const s = createTaskReminderScheduler(h.host)
    await s.start()
    s.setSchedule(1, [reminder('Late', T0 - 10 * MIN)])
    h.advance(HOUR)
    expect(h.notices).toEqual([])
  })

  it('catches up on what came due while the app was quit, folded, at most a day back', async () => {
    const first = fakeHost(T0)
    const before = createTaskReminderScheduler(first.host)
    await before.start()
    before.setSchedule(1, [reminder('A', T0 + 2 * HOUR), reminder('B', T0 + 3 * HOUR)])
    await before.flush()
    before.stop()

    // Relaunch the next day at 08:00, 24 h later: A and B came due meanwhile.
    const later = T0 + 24 * HOUR
    const second = fakeHost(later, first.stored())
    const after = createTaskReminderScheduler(second.host)
    await after.start()
    after.setSchedule(1, [reminder('A', T0 + 2 * HOUR), reminder('B', T0 + 3 * HOUR)])
    expect(second.notices.map((n) => [n.title, n.body, n.target])).toEqual([
      ['2 missed reminders', 'A, B', null]
    ])
  })

  it('an empty schedule at startup does not swallow the catch-up', async () => {
    const first = fakeHost(T0)
    const before = createTaskReminderScheduler(first.host)
    await before.start()
    before.setSchedule(1, [reminder('A', T0 + 2 * HOUR)])
    await before.flush()
    before.stop()
    const second = fakeHost(T0 + 5 * HOUR, first.stored())
    const after = createTaskReminderScheduler(second.host)
    await after.start()
    after.setSchedule(1, [])
    second.advance(MIN)
    after.setSchedule(1, [reminder('A', T0 + 2 * HOUR)])
    expect(second.notices.map((n) => n.title)).toEqual(['A'])
  })

  it('drops what is more than a day overdue', async () => {
    const first = fakeHost(T0)
    const before = createTaskReminderScheduler(first.host)
    await before.start()
    before.setSchedule(1, [reminder('Ancient', T0 + HOUR)])
    await before.flush()
    before.stop()
    const second = fakeHost(T0 + 3 * 24 * HOUR, first.stored())
    const after = createTaskReminderScheduler(second.host)
    await after.start()
    after.setSchedule(1, [reminder('Ancient', T0 + HOUR)])
    expect(second.notices).toEqual([])
  })

  it('fires the last schedule after a tray-only launch with no window', async () => {
    const first = fakeHost(T0)
    const before = createTaskReminderScheduler(first.host)
    await before.start()
    before.setSchedule(1, [reminder('Water', T0 + 3 * HOUR)])
    await before.flush()
    before.stop()
    const second = fakeHost(T0 + HOUR, first.stored())
    const after = createTaskReminderScheduler(second.host)
    await after.start()
    second.advance(3 * HOUR)
    expect(second.notices.map((n) => n.title)).toEqual(['Water'])
  })

  it('folds more than three on-time reminders into one', async () => {
    const h = fakeHost(T0)
    const s = createTaskReminderScheduler(h.host)
    await s.start()
    s.setSchedule(1, ['A', 'B', 'C', 'D'].map((t) => reminder(t, T0 + HOUR)))
    h.advance(HOUR)
    expect(h.notices.map((n) => [n.title, n.body])).toEqual([['4 task reminders', 'A, B and 2 more']])
  })

  it('merges schedules from several windows and wakes at least hourly', async () => {
    const h = fakeHost(T0)
    const s = createTaskReminderScheduler(h.host)
    await s.start()
    s.setSchedule(1, [reminder('One', T0 + 5 * HOUR, 'a.md')])
    s.setSchedule(2, [reminder('Two', T0 + 6 * HOUR, 'b.md')])
    h.advance(6 * HOUR)
    expect(h.notices.map((n) => n.title)).toEqual(['One', 'Two'])
  })

  it('a woken machine fires what it slept through', async () => {
    const h = fakeHost(T0)
    const s = createTaskReminderScheduler(h.host)
    await s.start()
    s.setSchedule(1, [reminder('Water', T0 + 30 * MIN)])
    // Asleep: no timer runs, the clock jumps, the host calls check on resume.
    h.setNow(T0 + 5 * HOUR)
    s.check()
    expect(h.notices.map((n) => [n.title, n.target?.path])).toEqual([['Water', 'Home.md']])
  })
})

describe('sanitizeReminders', () => {
  it('keeps well-formed items and drops the rest', () => {
    const good = reminder('Ok', T0)
    expect(
      sanitizeReminders([
        good,
        { ...good, path: '../outside.md' },
        { ...good, path: '/abs.md' },
        { ...good, fireAt: Number.NaN },
        { ...good, taskIndex: -1 },
        { ...good, title: 'x'.repeat(600) },
        'nope',
        null
      ])
    ).toEqual([good])
    expect(sanitizeReminders('nope')).toEqual([])
    expect(sanitizeReminders(new Array(600).fill(good))).toHaveLength(500)
  })
})
