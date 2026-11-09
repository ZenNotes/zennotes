/**
 * The few settings in a Logseq graph's `logseq/config.edn` that change how its
 * files read: how a page's file name spells its title, and how a journal's file
 * name and page title spell its date.
 *
 * config.edn is EDN, and nothing else in the app reads EDN, so this reads only
 * the three keys it needs and leaves the rest alone. A key that is missing or
 * commented out falls back to Logseq's own default, which is what Logseq does.
 */

export type LogseqFileNameFormat = 'legacy' | 'triple-lowbar'

export interface LogseqConfig {
  /** `:file/name-format`. Graphs made since Logseq 0.8.9 write `:triple-lowbar`. */
  fileNameFormat: LogseqFileNameFormat
  /** `:journal/file-name-format`, a date pattern: `yyyy_MM_dd` by default. */
  journalFileFormat: string
  /** `:journal/page-title-format`: what a link to a journal is spelled as. */
  journalTitleFormat: string
}

export const DEFAULT_LOGSEQ_CONFIG: LogseqConfig = {
  fileNameFormat: 'legacy',
  journalFileFormat: 'yyyy_MM_dd',
  journalTitleFormat: 'MMM do, yyyy'
}

/** The file with `;` comments blanked, except inside strings. */
function stripEdnComments(text: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (ch === '\\' && i + 1 < text.length) {
        out += text[++i]
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === ';') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
      continue
    }
    out += ch
  }
  return out
}

function stringValue(text: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  const match = new RegExp(`${escaped}\\s+"((?:[^"\\\\]|\\\\.)*)"`).exec(text)
  if (!match) return null
  const value = match[1].replace(/\\(.)/g, '$1').trim()
  return value || null
}

export function parseLogseqConfig(text: string | null | undefined): LogseqConfig {
  if (!text) return { ...DEFAULT_LOGSEQ_CONFIG }
  const clean = stripEdnComments(text)
  const format = /:file\/name-format\s+:([\w-]+)/.exec(clean)?.[1]
  return {
    fileNameFormat: format === 'triple-lowbar' ? 'triple-lowbar' : 'legacy',
    journalFileFormat: stringValue(clean, ':journal/file-name-format') ?? DEFAULT_LOGSEQ_CONFIG.journalFileFormat,
    journalTitleFormat: stringValue(clean, ':journal/page-title-format') ?? DEFAULT_LOGSEQ_CONFIG.journalTitleFormat
  }
}

// ---------------------------------------------------------------------------
// Date patterns. Logseq takes these from date-fns, so these are date-fns tokens.
// ---------------------------------------------------------------------------

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Longest first, so `MMMM` is not read as `MM` twice. */
const TOKENS = ['yyyy', 'yy', 'MMMM', 'MMM', 'MM', 'M', 'do', 'dd', 'd', 'EEEE', 'EEE', 'EE', 'E']

type Token = { token: string } | { literal: string }

function tokenize(format: string): Token[] {
  const out: Token[] = []
  let literal = ''
  for (let i = 0; i < format.length; ) {
    // date-fns quotes literal text with single quotes; '' is a quote.
    if (format[i] === "'") {
      const end = format.indexOf("'", i + 1)
      if (end === i + 1) {
        literal += "'"
        i += 2
        continue
      }
      literal += format.slice(i + 1, end < 0 ? format.length : end)
      i = end < 0 ? format.length : end + 1
      continue
    }
    const token = TOKENS.find((t) => format.startsWith(t, i))
    if (token) {
      if (literal) out.push({ literal })
      literal = ''
      out.push({ token })
      i += token.length
      continue
    }
    literal += format[i]
    i += 1
  }
  if (literal) out.push({ literal })
  return out
}

function ordinal(day: number): string {
  const tens = day % 100
  if (tens >= 11 && tens <= 13) return `${day}th`
  const suffix = ['th', 'st', 'nd', 'rd'][day % 10] ?? 'th'
  return `${day}${day % 10 > 3 ? 'th' : suffix}`
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0')

function isoParts(iso: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return { year, month, day }
}

/** `iso` (YYYY-MM-DD) written in a date-fns pattern, in English as Logseq does. */
export function formatLogseqDate(iso: string, format: string): string {
  const parts = isoParts(iso)
  if (!parts) return iso
  const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()
  return tokenize(format)
    .map((part) => {
      if ('literal' in part) return part.literal
      switch (part.token) {
        case 'yyyy':
          return pad(parts.year, 4)
        case 'yy':
          return pad(parts.year % 100)
        case 'MMMM':
          return MONTHS[parts.month - 1]
        case 'MMM':
          return MONTHS[parts.month - 1].slice(0, 3)
        case 'MM':
          return pad(parts.month)
        case 'M':
          return String(parts.month)
        case 'do':
          return ordinal(parts.day)
        case 'dd':
          return pad(parts.day)
        case 'd':
          return String(parts.day)
        case 'EEEE':
          return WEEKDAYS[weekday]
        default:
          return WEEKDAYS[weekday].slice(0, 3)
      }
    })
    .join('')
}

const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The date a name spells in `format`, as YYYY-MM-DD, or null when it spells none. */
export function parseLogseqDate(name: string, format: string): string | null {
  const groups: string[] = []
  let source = '^'
  for (const part of tokenize(format)) {
    if ('literal' in part) {
      source += escapeRe(part.literal)
      continue
    }
    groups.push(part.token)
    switch (part.token) {
      case 'yyyy':
        source += '(\\d{4})'
        break
      case 'yy':
      case 'MM':
      case 'dd':
        source += '(\\d{2})'
        break
      case 'M':
      case 'd':
        source += '(\\d{1,2})'
        break
      case 'do':
        source += '(\\d{1,2})(?:st|nd|rd|th)'
        break
      case 'MMMM':
      case 'MMM':
        source += '([A-Za-z]+)'
        break
      default:
        source += '[A-Za-z]+'
        groups.pop()
    }
  }
  const match = new RegExp(`${source}$`, 'i').exec(name.trim())
  if (!match) return null
  let year: number | null = null
  let month: number | null = null
  let day: number | null = null
  for (const [index, token] of groups.entries()) {
    const raw = match[index + 1]
    if (token === 'yyyy') year = Number(raw)
    else if (token === 'yy') year = 2000 + Number(raw)
    else if (token === 'MM' || token === 'M') month = Number(raw)
    else if (token === 'MMMM' || token === 'MMM') {
      const found = MONTHS.findIndex((m) => (token === 'MMMM' ? m : m.slice(0, 3)).toLowerCase() === raw.toLowerCase())
      month = found < 0 ? null : found + 1
    } else day = Number(raw)
  }
  if (year === null || month === null || day === null) return null
  const iso = `${pad(year, 4)}-${pad(month)}-${pad(day)}`
  return isoParts(iso) ? iso : null
}
