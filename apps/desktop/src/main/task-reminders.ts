// Task reminders on desktop (#1036): the main process times the schedule the
// renderer computes and shows each reminder as a system notification.
//
// The renderer owns WHAT to remind about (it has the task index, local or
// remote, and the daily-note dates); this module owns WHEN, because it is the
// one part of the app alive with the window hidden in the tray. It never
// touches the vault: a clicked reminder hands its path back to the renderer.
//
// Everything that has a clock or a side effect is injected, so the timing
// rules below are unit-tested without Electron.
//
// The rules:
//   - A reminder fires once. A ledger of fired keys survives relaunches, so a
//     renderer re-sending the schedule (it does on every task change) or a
//     restart never repeats one.
//   - "Watched until" is the last moment the app was checking. Anything that
//     came due between it and now, at most 24 hours back, fires on the next
//     check: what the app missed while quit, asleep or busy. Older ones drop,
//     since the task already shows as due or overdue.
//   - A reminder set for a time already past (written at 10:00 for 9:00) is
//     behind "watched until" and never fires.
//   - One timer, for the earliest unfired reminder, capped at an hour so sleep
//     or a clock change cannot strand it; the host also checks on wake.

import type { TaskReminder, TaskReminderTarget } from '@zennotes/bridge-contract/tasks'

export const MAX_REMINDERS = 500
const CATCH_UP_MS = 24 * 3_600_000
const LATE_MS = 2 * 60_000
const FIRED_TTL_MS = 7 * 86_400_000
const MAX_WAIT_MS = 3_600_000
const BOOT_GRACE_MS = 2 * 60_000
const FOLD_OVER = 3

export interface ReminderNotice {
  title: string
  body: string
  target: TaskReminderTarget
}

export interface TaskReminderHost {
  now(): number
  notify(notice: ReminderNotice): void
  readState(): Promise<string | null>
  writeState(text: string): Promise<void>
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

interface PersistedState {
  version: 1
  watchedUntil: number
  fired: Record<string, number>
  items: TaskReminder[]
}

function isSafeRelPath(path: string): boolean {
  if (!path || path.length > 1024 || path.includes('\0')) return false
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) return false
  return !path.split(/[\\/]/).includes('..')
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && !value.includes('\0')
}

/** The reminders in `raw` a renderer may hand over: well-formed, bounded, and
 *  pointing inside the vault. Anything else is dropped, not trusted. */
export function sanitizeReminders(raw: unknown): TaskReminder[] {
  if (!Array.isArray(raw)) return []
  const out: TaskReminder[] = []
  for (const item of raw.slice(0, MAX_REMINDERS)) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    if (
      !boundedString(r.key, 2048) ||
      typeof r.fireAt !== 'number' ||
      !Number.isFinite(r.fireAt) ||
      !boundedString(r.title, 500) ||
      !boundedString(r.body, 500) ||
      typeof r.path !== 'string' ||
      !isSafeRelPath(r.path) ||
      typeof r.taskIndex !== 'number' ||
      !Number.isInteger(r.taskIndex) ||
      r.taskIndex < 0
    ) {
      continue
    }
    out.push({
      key: r.key,
      fireAt: r.fireAt,
      title: r.title,
      body: r.body,
      path: r.path,
      taskIndex: r.taskIndex
    })
  }
  return out
}

function parseState(text: string | null): PersistedState | null {
  if (!text) return null
  try {
    const data = JSON.parse(text) as Partial<PersistedState>
    if (data?.version !== 1 || typeof data.watchedUntil !== 'number') return null
    const fired: Record<string, number> = {}
    if (data.fired && typeof data.fired === 'object') {
      for (const [key, at] of Object.entries(data.fired)) {
        if (typeof at === 'number' && Number.isFinite(at)) fired[key] = at
      }
    }
    return { version: 1, watchedUntil: data.watchedUntil, fired, items: sanitizeReminders(data.items) }
  } catch {
    return null
  }
}

export interface TaskReminderScheduler {
  /** Load the ledger and the last schedule; call once at startup. */
  start(): Promise<void>
  /** A renderer's whole schedule. Each sender keeps its own, merged by key. */
  setSchedule(senderId: number, raw: unknown): void
  /** Fire whatever came due. The host calls it on wake and unlock. */
  check(): void
  /** Settles once the ledger on disk is current (before quitting). */
  flush(): Promise<void>
  stop(): void
}

export function createTaskReminderScheduler(host: TaskReminderHost): TaskReminderScheduler {
  const schedules = new Map<number, TaskReminder[]>()
  // The schedule from the last run stands in until a renderer sends a fresh
  // one, so a launch with no window (tray only) still fires what is due.
  let persisted: TaskReminder[] = []
  let fired: Record<string, number> = {}
  let watchedUntil = host.now()
  let started = false
  let timer: unknown = null
  let bootTimer: unknown = null
  let writing = Promise.resolve()

  const merged = (): TaskReminder[] => {
    const all = schedules.size > 0 ? [...schedules.values()].flat() : persisted
    const byKey = new Map<string, TaskReminder>()
    for (const r of all) if (!byKey.has(r.key)) byKey.set(r.key, r)
    return [...byKey.values()].sort((a, b) => a.fireAt - b.fireAt)
  }

  const persist = (): void => {
    const state: PersistedState = { version: 1, watchedUntil, fired, items: merged() }
    const text = JSON.stringify(state)
    writing = writing.then(() => host.writeState(text)).catch(() => {})
  }

  const notifyAll = (due: TaskReminder[], now: number): void => {
    const late = due.filter((r) => now - r.fireAt > LATE_MS)
    const onTime = due.filter((r) => now - r.fireAt <= LATE_MS)
    const one = (r: TaskReminder): ReminderNotice => ({
      title: r.title,
      body: r.body,
      target: { path: r.path, title: r.title, taskIndex: r.taskIndex }
    })
    const folded = (list: TaskReminder[], title: string): ReminderNotice => {
      const names = list.slice(0, 2).map((r) => r.title)
      const more = list.length - names.length
      return {
        title,
        body: more > 0 ? `${names.join(', ')} and ${more} more` : names.join(', '),
        target: null
      }
    }
    if (late.length === 1) host.notify(one(late[0]))
    else if (late.length > 1) host.notify(folded(late, `${late.length} missed reminders`))
    if (onTime.length > FOLD_OVER) host.notify(folded(onTime, `${onTime.length} task reminders`))
    else for (const r of onTime) host.notify(one(r))
  }

  const arm = (): void => {
    if (timer != null) host.clearTimer(timer)
    timer = null
    const next = merged().find((r) => r.fireAt > watchedUntil && !(r.key in fired))
    if (!next) return
    const wait = Math.min(Math.max(next.fireAt - host.now(), 1000), MAX_WAIT_MS)
    timer = host.setTimer(() => {
      timer = null
      check()
    }, wait)
  }

  const check = (): void => {
    if (!started) return
    const now = host.now()
    const from = Math.max(watchedUntil, now - CATCH_UP_MS)
    const due = merged().filter((r) => r.fireAt > from && r.fireAt <= now && !(r.key in fired))
    watchedUntil = now
    for (const r of due) fired[r.key] = now
    for (const [key, at] of Object.entries(fired)) if (now - at > FIRED_TTL_MS) delete fired[key]
    if (due.length > 0) notifyAll(due, now)
    persist()
    arm()
  }

  return {
    async start() {
      const state = parseState(await host.readState().catch(() => null))
      if (state) {
        watchedUntil = Math.min(state.watchedUntil, host.now())
        fired = state.fired
        persisted = state.items
      }
      started = true
      if (schedules.size > 0) {
        check()
        return
      }
      // Give the window a moment to send a fresh schedule before catching up
      // on the stale one; a fresh schedule checks at once.
      bootTimer = host.setTimer(() => {
        bootTimer = null
        check()
      }, BOOT_GRACE_MS)
    },
    setSchedule(senderId, raw) {
      const items = sanitizeReminders(raw)
      schedules.set(senderId, items)
      // An empty schedule during startup may be a window whose tasks are not
      // indexed yet; checking on it would mark the stale schedule's missed
      // reminders as watched. The boot timer catches up instead.
      if (items.length === 0 && bootTimer != null) {
        schedules.delete(senderId)
        return
      }
      if (bootTimer != null) {
        host.clearTimer(bootTimer)
        bootTimer = null
      }
      check()
    },
    check,
    flush: () => writing,
    stop() {
      if (timer != null) host.clearTimer(timer)
      if (bootTimer != null) host.clearTimer(bootTimer)
      timer = bootTimer = null
      started = false
    }
  }
}
