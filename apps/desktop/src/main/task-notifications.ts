/**
 * Daily task digest notification.
 *
 * Schedules a single one-shot timer for the user's next configured
 * digest time. When it fires:
 *   1. Scans the active vault for tasks.
 *   2. Counts how many are due today vs. overdue.
 *   3. If there's anything to surface, shows a native notification.
 *   4. Persists today's ISO date to `taskNotificationsLastFired` so
 *      the same day's digest can't fire twice (e.g. if the user
 *      changes the time-of-day mid-day).
 *   5. Reschedules for tomorrow.
 *
 * On app start we also fire a "missed digest" once if the user's
 * configured time is in the past for today and we haven't notified
 * yet — so a user who launches at 11am still gets their 9am digest.
 *
 * The scheduler is a tiny module-level singleton: there's no
 * per-window state, just a Timeout handle that gets cleared on
 * reschedule and on app quit.
 */
import { app, BrowserWindow, Notification } from 'electron'
import { IPC } from '@shared/ipc'
import type { VaultTask } from '@shared/tasks'
import { buildTaskDigest } from '@shared/tasks'
import {
  DEFAULT_TASK_NOTIFICATIONS,
  loadConfig,
  type PersistedTaskNotifications,
  updateConfig
} from './vault'

let scheduledTimer: ReturnType<typeof setTimeout> | null = null
let cancelled = false

interface SchedulerDeps {
  /** Returns the currently-loaded set of tasks. Wired from the main
   *  process scanner; leaving this injectable keeps the scheduler
   *  testable and avoids an import cycle. */
  getTasks: () => Promise<VaultTask[]>
}

let deps: SchedulerDeps | null = null

export function configureTaskNotifications(d: SchedulerDeps): void {
  deps = d
}

/** Convert `HH:MM` (24-hour) into hours/minutes. Falls back to the
 *  default if the input is malformed (the persisted config layer
 *  already validates, but this guards against direct callers). */
function parseTimeOfDay(timeOfDay: string): { hours: number; minutes: number } {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(timeOfDay.trim())
  if (!m) {
    const [h, mm] = DEFAULT_TASK_NOTIFICATIONS.timeOfDay.split(':').map(Number)
    return { hours: h, minutes: mm }
  }
  return { hours: Number(m[1]), minutes: Number(m[2]) }
}

function localIsoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Compute the next time the digest should fire, anchored on `now`.
 *  Always returns a future Date — if today's slot has already passed,
 *  returns tomorrow's. */
function computeNextTrigger(now: Date, settings: PersistedTaskNotifications): Date {
  const { hours, minutes } = parseTimeOfDay(settings.timeOfDay)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0)
  if (today.getTime() > now.getTime()) return today
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)
  return tomorrow
}

function focusAppAndOpenTasks(): void {
  const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
  const target = BrowserWindow.getFocusedWindow() ?? windows[0] ?? null
  if (!target) return
  if (target.isMinimized()) target.restore()
  if (!target.isVisible()) target.show()
  target.focus()
  // Broadcast — the main app window will handle it; quick-capture / floating
  // windows ignore the channel.
  for (const win of windows) {
    win.webContents.send(IPC.TASKS_OPEN_VIEW)
  }
}

/** Keep a live reference to the most recently shown notification so
 *  macOS doesn't garbage-collect the JS wrapper before the OS gets a
 *  chance to display it. Without this, a notification fired in quick
 *  succession can disappear silently — the test path used to look
 *  "broken after one click" because of exactly this. */
let lastShownNotification: Notification | null = null

function shortTimeStamp(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function fireNotification(title: string, body: string): void {
  if (!Notification.isSupported()) return
  const n = new Notification({
    title,
    // macOS dedupes notifications whose title+body match recent ones.
    // Time-stamping the body avoids the "first one shows, then nothing"
    // experience without changing the user-facing meaning.
    body,
    // `subtitle` shows under the title on macOS — a tiny `· HH:MM:SS`
    // there reads like a timestamp instead of cluttering the body.
    subtitle: shortTimeStamp()
  })
  n.on('click', focusAppAndOpenTasks)
  n.show()
  lastShownNotification = n
}

function showDigestNotification(
  digest: { dueToday: number; overdue: number; total: number }
): void {
  const parts: string[] = []
  if (digest.dueToday > 0) {
    parts.push(`${digest.dueToday} due today`)
  }
  if (digest.overdue > 0) {
    parts.push(`${digest.overdue} overdue`)
  }
  const body = parts.length ? parts.join(' · ') : 'You have tasks waiting.'
  fireNotification('ZenNotes — task digest', body)
}

/** Fire the digest right now (no scheduling, no last-fired guard).
 *  Used by the Settings "Send a test notification" button. */
export async function fireTaskDigestNow(): Promise<{ ok: boolean; reason?: string }> {
  if (!Notification.isSupported()) {
    return { ok: false, reason: 'Native notifications are not available on this system.' }
  }
  if (!deps) return { ok: false, reason: 'Scheduler not configured yet.' }
  const tasks = await deps.getTasks()
  const digest = buildTaskDigest(tasks, new Date())
  if (digest.total === 0) {
    // Still show *something* so the user can see the wiring works.
    fireNotification(
      'ZenNotes — task digest',
      'No tasks due today and nothing overdue. Nice.'
    )
    return { ok: true }
  }
  showDigestNotification(digest)
  return { ok: true }
}

/** Run the digest exactly once for "today" — guarded by
 *  `taskNotificationsLastFired` so the same day can't fire twice. */
async function tryFireDigestForToday(): Promise<void> {
  if (!deps) return
  const cfg = await loadConfig()
  if (!cfg.taskNotifications.enabled) return
  const today = localIsoDate(new Date())
  if (cfg.taskNotificationsLastFired === today) return

  const tasks = await deps.getTasks()
  const digest = buildTaskDigest(tasks, new Date())

  // Always update the last-fired marker so we don't re-attempt on the
  // same day even when there's nothing to surface.
  await updateConfig((c) => ({ ...c, taskNotificationsLastFired: today }))

  if (digest.total === 0) return
  showDigestNotification(digest)
}

async function runScheduledTick(): Promise<void> {
  if (cancelled) return
  try {
    await tryFireDigestForToday()
  } catch (err) {
    // Notifications must never crash the main process — log and keep
    // the schedule alive so tomorrow has another shot.
    console.error('Task digest tick failed', err)
  }
  // After a tick we always reschedule, regardless of whether the
  // digest actually showed.
  await rescheduleTaskDigest()
}

/** (Re)compute and arm the one-shot timer for the next digest.
 *  Cheap to call repeatedly — clears any prior timer first. */
export async function rescheduleTaskDigest(): Promise<void> {
  if (scheduledTimer) {
    clearTimeout(scheduledTimer)
    scheduledTimer = null
  }
  if (cancelled) return
  const cfg = await loadConfig()
  if (!cfg.taskNotifications.enabled) return
  const next = computeNextTrigger(new Date(), cfg.taskNotifications)
  // Cap at ~24h so clock skew or system sleep can't strand us; the
  // rescheduler just runs again when we wake.
  const delay = Math.max(60_000, Math.min(next.getTime() - Date.now(), 26 * 60 * 60 * 1000))
  scheduledTimer = setTimeout(() => {
    scheduledTimer = null
    void runScheduledTick()
  }, delay)
}

/** Boot the scheduler. Calls `rescheduleTaskDigest` and additionally
 *  fires the "catch-up" digest on launch when the user's slot has
 *  already passed for today. */
export async function startTaskNotifications(d: SchedulerDeps): Promise<void> {
  configureTaskNotifications(d)
  cancelled = false
  // Catch-up: if today's slot has already passed and we haven't fired
  // yet, surface the digest now so launching late in the day doesn't
  // skip the user's notification.
  try {
    const cfg = await loadConfig()
    if (cfg.taskNotifications.enabled) {
      const now = new Date()
      const todayIso = localIsoDate(now)
      const { hours, minutes } = parseTimeOfDay(cfg.taskNotifications.timeOfDay)
      const todaySlot = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes)
      if (now.getTime() >= todaySlot.getTime() && cfg.taskNotificationsLastFired !== todayIso) {
        await tryFireDigestForToday()
      }
    }
  } catch (err) {
    console.error('Task digest catch-up failed', err)
  }
  await rescheduleTaskDigest()
}

export function stopTaskNotifications(): void {
  cancelled = true
  if (scheduledTimer) {
    clearTimeout(scheduledTimer)
    scheduledTimer = null
  }
}

// Make sure timers don't keep the process alive past `before-quit`.
app.on('before-quit', () => stopTaskNotifications())

// Test-only export to keep schedule math verifiable without touching
// timers or the filesystem.
export const __test = { computeNextTrigger, parseTimeOfDay, localIsoDate }
