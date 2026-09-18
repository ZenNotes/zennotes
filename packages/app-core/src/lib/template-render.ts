/**
 * Pure variable-substitution engine for note templates.
 *
 * Templates may contain `{{...}}` tokens that are expanded when a note is
 * created from the template:
 *
 *   {{title}}         the note's title
 *   {{date}}          today's date, ISO `YYYY-MM-DD`
 *   {{date:FORMAT}}   today's date in a custom format (see formatDate)
 *   {{time}}          current time, `HH:mm`
 *   {{week}}          ISO 8601 week number, zero-padded
 *   {{cursor}}        removed from output; marks where the caret should land
 *
 * Unknown `{{tokens}}` are passed through unchanged so user braces survive.
 * That is also how the live tokens work: `{{modified_date}}`,
 * `{{modified_time}}` and `{{modified_datetime}}` stay in the note on purpose
 * and are rendered from its modification time by the editor and reading view
 * (see live-template-tokens.ts, #784).
 */

export interface TemplateContext {
  title: string
  /** Defaults to `new Date()`. Injectable for deterministic tests. */
  now?: Date
}

export interface RenderedTemplate {
  body: string
  /** Offset of `{{cursor}}` in the rendered body, or null if absent. */
  cursorOffset: number | null
}

// Canonical cursor marker. During substitution every `{{cursor}}` variant is
// normalized to this exact string; afterwards we record the offset of the
// first one (all other tokens are already expanded, so the offset is final).
const CURSOR_TOKEN = '{{cursor}}'

const TOKEN_RE = /\{\{\s*([^}]+?)\s*\}\}/g

// Month and weekday names follow the host locale so daily-note templates read
// naturally for non-English users (e.g. `{{date:dddd D MMMM}}` →
// "lundi 9 juin"). Numeric tokens stay locale-neutral, and the daily-note title
// itself remains ISO `YYYY-MM-DD` for file-friendly sorting and searching.
function localeName(
  date: Date,
  field: 'month' | 'weekday',
  width: 'long' | 'short'
): string {
  return date.toLocaleDateString(undefined, { [field]: width })
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** ISO `YYYY-MM-DD` for the given date (local time). */
export function formatISODate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

export function formatTime(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

// Longest tokens must come first in the alternation so `MMMM` wins over `MM`,
// `dddd` over `dd`, etc. `[...]` escapes emit their contents literally. Accepts
// both the moment-style tokens this macro shipped with (YYYY/DD/dddd) and the
// date-fns-style tokens the daily/weekly/monthly note directory + title patterns
// use (yyyy/dd/EEEE/ww), so the same variables work in both places. (#411)
const DATE_FORMAT_RE =
  /\[([^\]]*)\]|YYYY|YY|yyyy|yy|MMMM|MMM|MM|M|EEEE|EEE|dddd|ddd|dd|d|DD|D|ww|w|HH|mm|ss/g

/**
 * Format a date with a token string. Supported tokens (both vocabularies work,
 * so directory/title-pattern variables can be reused verbatim in templates):
 *   year     YYYY / yyyy, YY / yy
 *   month    MMMM (name), MMM (short), MM, M
 *   day      DD / dd, D / d
 *   weekday  dddd / EEEE (name), ddd / EEE (short)
 *   week     ww (ISO, padded), w (ISO)
 *   time     HH, mm, ss
 * Wrap literal text in `[brackets]` to protect letters that are tokens.
 */
export function formatDate(date: Date, format: string): string {
  const year = date.getFullYear()
  const month = date.getMonth()
  const day = date.getDate()
  const hours = date.getHours()
  const minutes = date.getMinutes()
  const seconds = date.getSeconds()
  const week = getISOWeek(date)
  return format.replace(DATE_FORMAT_RE, (match, escaped: string | undefined) => {
    if (escaped !== undefined) return escaped
    switch (match) {
      case 'YYYY':
      case 'yyyy':
        return String(year)
      case 'YY':
      case 'yy':
        return pad2(year % 100)
      case 'MMMM':
        return localeName(date, 'month', 'long')
      case 'MMM':
        return localeName(date, 'month', 'short')
      case 'MM':
        return pad2(month + 1)
      case 'M':
        return String(month + 1)
      case 'DD':
      case 'dd':
        return pad2(day)
      case 'D':
      case 'd':
        return String(day)
      case 'dddd':
      case 'EEEE':
        return localeName(date, 'weekday', 'long')
      case 'ddd':
      case 'EEE':
        return localeName(date, 'weekday', 'short')
      case 'ww':
        return pad2(week)
      case 'w':
        return String(week)
      case 'HH':
        return pad2(hours)
      case 'mm':
        return pad2(minutes)
      case 'ss':
        return pad2(seconds)
      default:
        return match
    }
  })
}

function isoWeekParts(date: Date): { week: number; year: number } {
  // Shift to the Thursday of the current ISO week, working in UTC to avoid DST.
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7 // Sunday -> 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return { week, year: d.getUTCFullYear() }
}

/** ISO 8601 week number (1-53) for the given date. */
export function getISOWeek(date: Date): number {
  return isoWeekParts(date).week
}

/** ISO 8601 week-year (may differ from the calendar year at year boundaries). */
export function getISOWeekYear(date: Date): number {
  return isoWeekParts(date).year
}

/**
 * Inverse of {@link getISOWeek}: the Monday (local midnight) of the given ISO
 * week-year and week number. Jan 4th is always in ISO week 1, so we anchor to
 * its Monday and step forward whole weeks.
 */
export function mondayOfISOWeek(weekYear: number, week: number): Date {
  const jan4 = new Date(Date.UTC(weekYear, 0, 4))
  const dayNum = jan4.getUTCDay() || 7 // Sunday -> 7
  const monday = new Date(jan4)
  monday.setUTCDate(jan4.getUTCDate() - (dayNum - 1) + (week - 1) * 7)
  return new Date(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate())
}

function substituteTokens(input: string, title: string, now: Date): string {
  return input.replace(TOKEN_RE, (full, rawToken: string) => {
    const token = rawToken.trim()
    if (token === 'cursor') return CURSOR_TOKEN
    if (token === 'title') return title
    if (token === 'date') return formatISODate(now)
    if (token === 'time') return formatTime(now)
    if (token === 'week') return pad2(getISOWeek(now))
    if (token.startsWith('date:')) return formatDate(now, token.slice('date:'.length))
    return full // unknown token -> leave untouched
  })
}

/** Render a template body, resolving tokens and extracting the cursor offset. */
export function renderTemplate(body: string, ctx: TemplateContext): RenderedTemplate {
  const now = ctx.now ?? new Date()
  const substituted = substituteTokens(body, ctx.title, now)
  const cursorOffset = substituted.indexOf(CURSOR_TOKEN)
  const finalBody = substituted.split(CURSOR_TOKEN).join('')
  return { body: finalBody, cursorOffset: cursorOffset === -1 ? null : cursorOffset }
}

/** Render a title pattern (e.g. `{{date:YYYY-MM-DD}} -- `). Cursor tokens drop. */
export function renderTitle(titleTemplate: string, ctx: TemplateContext): string {
  const now = ctx.now ?? new Date()
  return substituteTokens(titleTemplate, ctx.title, now).split(CURSOR_TOKEN).join('').trim()
}
