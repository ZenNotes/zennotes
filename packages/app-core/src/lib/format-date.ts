/**
 * Single source of truth for how calendar dates render across the renderer UI.
 *
 * These are deliberately **language-aware** and ignore the OS locale: they
 * follow the app's `language` setting (read from the store by callers and
 * passed in), so a Chinese UI never shows an English "Jun 15". Before this
 * module every view had its own `formatDate` calling `toLocaleDateString(undefined, …)`,
 * which silently used the system locale — the source of the mismatch.
 *
 * Date format by language:
 *   - `zh`        → locale-neutral, sortable dash form: `2026-06-15` (or
 *                   `06-15` when the year is dropped). Same convention the
 *                   database/base table established; chosen by the user to be
 *                   the global standard.
 *   - en / others → friendly localized short form: `Jun 15, 2026`.
 *
 * Weekday and month-name *labels* (not full dates) use the native locale form
 * (星期一 / 6月 / 2026年6月), since a dash form reads broken in those spots.
 */

export type YearMode = 'auto' | 'always' | 'never'

const pad = (n: number): string => String(n).padStart(2, '0')

/** Accept a ms timestamp, a `Date`, or an ISO/`YYYY-MM-DD` string. */
function toDate(value: number | string | Date): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === 'number') {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? null : d
  }
  if (!value) return null
  // A bare calendar date (`2026-06-15`) is parsed as local midnight so it
  // doesn't drift across the UTC boundary the way `new Date('2026-06-15')` does.
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

function showYear(d: Date, mode: YearMode): boolean {
  if (mode === 'always') return true
  if (mode === 'never') return false
  return d.getFullYear() !== new Date().getFullYear() // 'auto'
}

/**
 * A calendar date. `opts.year`: `'auto'` (default — omit when it's the current
 * year), `'always'`, or `'never'`. `opts.month` ('short' | 'long') only affects
 * the English form; the zh dash form is always numeric.
 */
export function formatDate(
  value: number | string | Date,
  language?: string,
  opts: { year?: YearMode; month?: 'short' | 'long' } = {}
): string {
  const d = toDate(value)
  if (!d) return typeof value === 'string' ? value : ''
  const withYear = showYear(d, opts.year ?? 'auto')
  if (language === 'zh') {
    const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    return withYear ? `${d.getFullYear()}-${md}` : md
  }
  return d.toLocaleDateString(undefined, {
    month: opts.month ?? 'short',
    day: 'numeric',
    year: withYear ? 'numeric' : undefined
  })
}

/** A date plus hour:minute, for timestamps (e.g. comments). Year is dropped. */
export function formatDateTime(value: number | string | Date, language?: string): string {
  const d = toDate(value)
  if (!d) return typeof value === 'string' ? value : ''
  if (language === 'zh') {
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

/** A month/year header (e.g. a calendar's title): "June 2026" / "2026年6月". */
export function formatMonthYear(value: number | string | Date, language?: string): string {
  const d = toDate(value)
  if (!d) return ''
  return d.toLocaleDateString(language === 'zh' ? 'zh-CN' : undefined, {
    month: 'long',
    year: 'numeric'
  })
}

/** A month name alone (e.g. a sidebar group heading): "June" / "6月". */
export function formatMonthName(value: number | string | Date, language?: string): string {
  const d = toDate(value)
  if (!d) return ''
  return d.toLocaleDateString(language === 'zh' ? 'zh-CN' : undefined, { month: 'long' })
}

/** Weekday + date, no year: "Monday, Jun 15" / "06-15 星期一". */
export function formatWeekdayDate(value: number | string | Date, language?: string): string {
  const d = toDate(value)
  if (!d) return ''
  if (language === 'zh') {
    const weekday = d.toLocaleDateString('zh-CN', { weekday: 'long' }) // 星期一
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${weekday}`
  }
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
}
