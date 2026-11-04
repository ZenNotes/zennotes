/**
 * Recurring tasks (#1036): the `@repeat:<rule>` field, the date it gives next,
 * and the edit that checking off a recurring task makes.
 *
 * The rule rides the `@key:value` field grammar (#354), so the four synced
 * task parsers already read it and none of them changed. What is new is only
 * what a check-off WRITES, and that lives here so every surface that checks a
 * task off (the Tasks views, the editor, Preview, MCP) makes the same edit:
 *
 *   - [ ] Water the plants @repeat:weekly due:2026-11-01
 * becomes
 *   - [ ] Water the plants @repeat:weekly due:2026-11-08
 *   - [x] Water the plants due:2026-11-01
 *
 * The next occurrence goes ABOVE, where the task already stood, so the cursor
 * and the list cursor stay on open work. The finished line is a record: it
 * drops `@repeat` and `@remind`, the tokens that only mean something on open
 * work, so unchecking it (or dragging a Done card back) never spawns a copy.
 * A task's subtree repeats with it, every checkbox reset to open, and the
 * record cancels (`[-]`) the subtasks it left open: they were not done, and
 * left open they would stand beside their fresh copies on every Tasks list.
 *
 * Dates are whole days in `YYYY-MM-DD`, computed on UTC calendar fields so a
 * daylight-saving change can never shift a date. The zn CLI mirrors this edit
 * in Go; `task-recurrence.cases.json` holds the cases both test suites run.
 */
import { TASK_LINE_RE, leadingIndentWidth, taskBlockEnd, taskLineNumbers } from './tasklists'
import { noteFrontmatterDue } from './tasks'

export type RepeatUnit = 'day' | 'week' | 'month' | 'year'

export type RepeatRule =
  /** Every N units, counted from the due date, or from the day the task is
   *  finished when `afterDone` (`@repeat:after-3d`). */
  | { kind: 'interval'; unit: RepeatUnit; every: number; afterDone: boolean }
  /** On these weekdays (0 = Sunday, ascending): `mon/thu`, `weekdays`. */
  | { kind: 'days'; days: number[] }

const NAMED: Record<string, { unit: RepeatUnit; every: number }> = {
  daily: { unit: 'day', every: 1 },
  weekly: { unit: 'week', every: 1 },
  monthly: { unit: 'month', every: 1 },
  yearly: { unit: 'year', every: 1 },
  annually: { unit: 'year', every: 1 }
}
const UNIT_LETTERS: Record<string, RepeatUnit> = { d: 'day', w: 'week', m: 'month', y: 'year' }
const INTERVAL_RE = /^(\d{1,3})([dwmy])$/
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/** The rule a `@repeat:` value names, or null when it names none (an unknown
 *  rule leaves the task an ordinary one rather than guessing). */
export function parseRepeatRule(raw: string | null | undefined): RepeatRule | null {
  if (!raw) return null
  let value = raw.trim().toLowerCase()
  if (value === 'weekdays') return { kind: 'days', days: [1, 2, 3, 4, 5] }
  let afterDone = false
  if (value.startsWith('after-')) {
    afterDone = true
    value = value.slice('after-'.length)
  }
  const named = NAMED[value]
  if (named) return { kind: 'interval', ...named, afterDone }
  const interval = INTERVAL_RE.exec(value)
  if (interval) {
    const every = Number(interval[1])
    if (every < 1) return null
    return { kind: 'interval', unit: UNIT_LETTERS[interval[2]], every, afterDone }
  }
  if (afterDone) return null
  const days: number[] = []
  for (const part of value.split('/')) {
    const day = DAY_NAMES.indexOf(part)
    if (day < 0) return null
    if (!days.includes(day)) days.push(day)
  }
  return days.length > 0 ? { kind: 'days', days: days.sort((a, b) => a - b) } : null
}

const UNIT_WORDS: Record<RepeatUnit, [string, string]> = {
  day: ['day', 'days'],
  week: ['week', 'weeks'],
  month: ['month', 'months'],
  year: ['year', 'years']
}
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** A short, human label for a rule: "Weekly", "Every 2 weeks", "Mon, Thu",
 *  "3 days after done". For tooltips, toasts and the Repeat menu. */
export function describeRepeatRule(rule: RepeatRule): string {
  if (rule.kind === 'days') {
    if (rule.days.join() === '1,2,3,4,5') return 'Weekdays'
    return rule.days.map((d) => DAY_LABELS[d]).join(', ')
  }
  const [one, many] = UNIT_WORDS[rule.unit]
  if (rule.afterDone) return `${rule.every} ${rule.every === 1 ? one : many} after done`
  if (rule.every === 1) {
    return { day: 'Daily', week: 'Weekly', month: 'Monthly', year: 'Yearly' }[rule.unit]
  }
  return `Every ${rule.every} ${many}`
}

// ---------------------------------------------------------------------------
// Calendar dates
// ---------------------------------------------------------------------------

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const DAY_MS = 86_400_000

function isoToUtc(iso: string): number | null {
  const m = ISO_RE.exec(iso)
  if (!m) return null
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isFinite(t) ? t : null
}

function utcToIso(t: number): string {
  const d = new Date(t)
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${d.getUTCFullYear()}-${mm}-${dd}`
}

/** `iso` moved by `n` days. */
export function addDaysIso(iso: string, n: number): string {
  const t = isoToUtc(iso)
  return t == null ? iso : utcToIso(t + n * DAY_MS)
}

/** `iso` moved by `n` months, the day clamped to the month's length: Jan 31
 *  plus one month is Feb 28 (or 29). */
function addMonthsIso(iso: string, n: number): string {
  const t = isoToUtc(iso)
  if (t == null) return iso
  const d = new Date(t)
  const month = d.getUTCMonth() + n
  const year = d.getUTCFullYear() + Math.floor(month / 12)
  const m = ((month % 12) + 12) % 12
  const last = new Date(Date.UTC(year, m + 1, 0)).getUTCDate()
  return utcToIso(Date.UTC(year, m, Math.min(d.getUTCDate(), last)))
}

function weekdayOf(iso: string): number {
  const t = isoToUtc(iso)
  return t == null ? 0 : new Date(t).getUTCDay()
}

function addUnits(iso: string, n: number, unit: RepeatUnit): string {
  if (unit === 'day') return addDaysIso(iso, n)
  if (unit === 'week') return addDaysIso(iso, n * 7)
  return addMonthsIso(iso, unit === 'year' ? n * 12 : n)
}

/**
 * The date of the occurrence after the one due on `base`, for a task finished
 * on `today` (both `YYYY-MM-DD`).
 *
 * The answer is the first date of the rule's series after BOTH the due date
 * and today, so a task finished late skips the occurrences it missed: a daily
 * task done five days late comes back tomorrow, not as five overdue copies.
 * (Obsidian Tasks steps one interval and can land in the past; we do not.)
 * Months count from `base` each time, so one completion never compounds a
 * month-end clamp. `afterDone` rules count from today instead.
 */
export function nextRepeatDate(rule: RepeatRule, base: string, today: string): string {
  if (rule.kind === 'days') {
    let date = addDaysIso(base > today ? base : today, 1)
    for (let i = 0; i < 7 && !rule.days.includes(weekdayOf(date)); i++) {
      date = addDaysIso(date, 1)
    }
    return date
  }
  if (rule.afterDone) return addUnits(today, rule.every, rule.unit)
  if (rule.unit === 'day' || rule.unit === 'week') {
    const step = rule.every * (rule.unit === 'week' ? 7 : 1)
    const baseT = isoToUtc(base)
    const todayT = isoToUtc(today)
    if (baseT == null || todayT == null) return addDaysIso(base, step)
    const behind = Math.round((todayT - baseT) / DAY_MS)
    const k = behind < 0 ? 1 : Math.floor(behind / step) + 1
    return addDaysIso(base, k * step)
  }
  const months = rule.every * (rule.unit === 'year' ? 12 : 1)
  for (let k = 1; k < 100_000; k++) {
    const date = addMonthsIso(base, k * months)
    if (date > today) return date
  }
  return addMonthsIso(base, months)
}

// ---------------------------------------------------------------------------
// The check-off edit
// ---------------------------------------------------------------------------

const FIELD_VALUE = '[\\p{L}\\d][\\p{L}\\d/_-]*'
const REPEAT_FIELD_RE = new RegExp(`(?:^|\\s)@repeat:(${FIELD_VALUE})`, 'iu')
const REPEAT_TOKEN_RE = new RegExp(`(^|\\s)@repeat:${FIELD_VALUE}`, 'giu')
const REMIND_TOKEN_RE = new RegExp(`(^|\\s)@remind:${FIELD_VALUE}`, 'giu')
const STATUS_TOKEN_RE = new RegExp(`(^|\\s)@status:${FIELD_VALUE}`, 'giu')
const WAITING_TOKEN_RE = /(^|\s)@waiting\b/gi
// The parser's `due:` token, spaced form included (#343).
const DUE_TOKEN_RE = /(^|\s)due:\s*(\S+)/i

/** The `@repeat:` value written on a task line's text, if any. */
export function repeatFieldOf(text: string): string | undefined {
  return REPEAT_FIELD_RE.exec(text)?.[1]?.toLowerCase()
}

/** The rule a task line repeats on, or null for an ordinary task. */
export function repeatRuleOfLine(line: string): RepeatRule | null {
  return parseRepeatRule(repeatFieldOf(line))
}

function tidy(text: string): string {
  return text.replace(/[ \t]{2,}/g, ' ').replace(/\s+$/u, '')
}

function bare(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

export interface RecurringCompletionOptions {
  /** The day the task is finished, `YYYY-MM-DD` in the user's time zone. */
  today: string
  /** The date a task without a `due:` falls back on: the note's frontmatter
   *  `due:`, else the daily note's own date when tasks take it. */
  fallbackDue?: string
  /** "Skip this time": the record is written cancelled (`[-]`) instead of done. */
  skip?: boolean
}

export interface RecurringLinePlan {
  /** The new occurrence and its reset subtree, to go above the task. */
  next: string[]
  /** The finished task's own line, rewritten as the record. */
  record: string
  /** Its subtree as the record keeps it: the subtasks still open (`[ ]`,
   *  `[/]`) cancelled, everything else as it was. */
  recordChildren: string[]
  /** How many lines the plan replaces: the task's line and its subtree. */
  replaces: number
  nextDue: string
  rule: RepeatRule
}

/**
 * Plan checking off the recurring task on line `at` of `lines` (bare lines,
 * no `\r`): the occurrence that goes above it and what its own block becomes.
 * Null when the line is not an OPEN task (`[ ]` or `[/]`) carrying a rule
 * this module understands; the caller then toggles it like any other task.
 */
export function planRecurringCompletion(
  lines: readonly string[],
  at: number,
  opts: RecurringCompletionOptions
): RecurringLinePlan | null {
  const line = lines[at]
  if (line == null) return null
  const match = bare(line).match(TASK_LINE_RE)
  if (!match || (match[2] !== ' ' && match[2] !== '/')) return null
  if (!match[3].startsWith(']')) return null
  const rest = match[3].slice(1)
  const rule = parseRepeatRule(repeatFieldOf(rest))
  if (!rule) return null

  const written = DUE_TOKEN_RE.exec(rest)?.[2]
  const writtenDue = written && isoToUtc(written) != null ? written : undefined
  const base = writtenDue ?? opts.fallbackDue ?? opts.today
  const nextDue = nextRepeatDate(rule, base, opts.today)

  // The occurrence keeps the text, priority, tags and every other field, in
  // their order; `due:` is replaced where it stood. Its per-occurrence state
  // does not carry: `@waiting` and the board's `@status:` start fresh.
  let nextRest = DUE_TOKEN_RE.test(rest)
    ? rest.replace(DUE_TOKEN_RE, `$1due:${nextDue}`)
    : `${rest.replace(/\s+$/u, '')} due:${nextDue}`
  nextRest = tidy(nextRest.replace(WAITING_TOKEN_RE, '$1').replace(STATUS_TOKEN_RE, '$1'))
  const next = [`${match[1]} ]${nextRest}`]

  // The subtree comes along with every checkbox open again: a weekly review's
  // checklist starts each week unticked. Notes under it copy verbatim.
  // The record cancels the subtasks it left open, so only the fresh copies
  // above read as live work; ticked, cancelled and forwarded ones stay.
  const end = taskBlockEnd(lines.map(bare), at, leadingIndentWidth(bare(line)))
  const recordChildren: string[] = []
  for (let i = at + 1; i < end; i++) {
    const child = bare(lines[i])
    const childMatch = child.match(TASK_LINE_RE)
    next.push(childMatch ? `${childMatch[1]} ${childMatch[3]}` : child)
    const open = childMatch && (childMatch[2] === ' ' || childMatch[2] === '/')
    recordChildren.push(open ? `${childMatch[1]}-${childMatch[3]}` : child)
  }

  const recordRest = tidy(rest.replace(REPEAT_TOKEN_RE, '$1').replace(REMIND_TOKEN_RE, '$1'))
  const record = `${match[1]}${opts.skip ? '-' : 'x'}]${recordRest}`
  return { next, record, recordChildren, replaces: end - at, nextDue, rule }
}

export interface RecurringCompletion {
  body: string
  nextDue: string
  rule: RepeatRule
  /** How many lines went in above the finished task. */
  insertedLines: number
  /** How many of them are tasks: the finished task's own index moves down by
   *  this much. */
  insertedTasks: number
}

/**
 * Check off the recurring task at `taskIndex` (counted like the parser):
 * the next occurrence goes above it and the task becomes its record. Null
 * when that task is not an open recurring one. A Windows note keeps its
 * `\r\n` endings, the inserted lines included.
 */
export function completeRecurringTaskAtIndex(
  markdown: string,
  taskIndex: number,
  opts: RecurringCompletionOptions
): RecurringCompletion | null {
  if (taskIndex < 0) return null
  const at = taskLineNumbers(markdown.split('\n'))[taskIndex]
  if (at == null) return null
  return completeRecurringTaskAtLine(markdown, at, opts)
}

/** The same for the task on a known line, for a caller whose index counts
 *  differently from the parser's. Null when that line is not an open recurring
 *  task. */
export function completeRecurringTaskAtLine(
  markdown: string,
  at: number,
  opts: RecurringCompletionOptions
): RecurringCompletion | null {
  const lines = markdown.split('\n')
  if (at < 0 || at >= lines.length) return null
  const fallbackDue = noteFrontmatterDue(markdown) ?? opts.fallbackDue
  const plan = planRecurringCompletion(lines, at, { ...opts, fallbackDue })
  if (!plan) return null
  const ending = lines[at].endsWith('\r') ? '\r' : ''
  const endingOf = (i: number): string => (lines[i].endsWith('\r') ? '\r' : '')
  lines.splice(
    at,
    plan.replaces,
    ...plan.next.map((l) => l + ending),
    plan.record + ending,
    ...plan.recordChildren.map((l, k) => l + endingOf(at + 1 + k))
  )
  return {
    body: lines.join('\n'),
    nextDue: plan.nextDue,
    rule: plan.rule,
    insertedLines: plan.next.length,
    insertedTasks: plan.next.filter((l) => TASK_LINE_RE.test(l)).length
  }
}

/** Set (or with null, remove) the `@repeat:` rule on a task line's text,
 *  replacing an existing rule where it stands. */
export function setRepeatField(text: string, rule: string | null): string {
  return setNamedField(text, 'repeat', rule)
}

/** Set (or with null, remove) the `@remind:` field on a task line's text. */
export function setRemindField(text: string, when: string | null): string {
  return setNamedField(text, 'remind', when)
}

function setNamedField(text: string, key: 'repeat' | 'remind', value: string | null): string {
  const token = new RegExp(`(^|\\s)@${key}:${FIELD_VALUE}`, 'iu')
  if (value == null) return tidy(text.replace(new RegExp(token.source, 'giu'), '$1'))
  if (token.test(text)) return text.replace(token, `$1@${key}:${value}`)
  return `${text.replace(/\s+$/u, '')} @${key}:${value}`
}
