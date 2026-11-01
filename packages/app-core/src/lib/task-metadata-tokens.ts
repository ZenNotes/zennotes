/**
 * The task-metadata tokens both renderers highlight: priority (`!high`), due
 * date (`due:YYYY-MM-DD`) and `@fields` (`@waiting`, `@key:value`).
 *
 * One scanner, two renderers — the CodeMirror decorations in
 * `cm-task-metadata.ts` and the remark plugin behind the reading preview — so
 * a token can never be a chip in the editor and plain text in preview (#479).
 * Token shapes mirror the parser in `@shared/tasks`.
 */

import { describeRepeatRule, parseRepeatRule } from '@shared/task-recurrence'
import { describeRemindSpec, parseRemindSpec } from '@shared/task-reminders'

export type TaskMetaKind = 'priority' | 'due' | 'field'

export interface TaskMetaToken {
  kind: TaskMetaKind
  /** Offset of the token within the scanned text. */
  start: number
  end: number
  /** The matched token text, e.g. `!high` or `due:2026-07-20`. */
  text: string
  /** Only for `priority`. */
  level?: 'high' | 'med' | 'low'
  /** Only for `due` — the ISO date, without the `due:` prefix. */
  date?: string
  /** Only for `field`: its key, lower-cased (`repeat` for `@repeat:weekly`). */
  field?: string
}

// Anchored on `(^|\s)` so `!`, `due:` or `@` glued to a preceding word don't match.
const PRIORITY_RE = /(^|\s)(!(?:high|medium|med|low|h|m|l))\b/gi
// Only a valid ISO date is treated as a due date (matching `isValidIsoDate`).
const DUE_RE = /(^|\s)(due:\s*(\d{4}-\d{2}-\d{2}))\b/gi
const FIELD_RE = /(^|\s)(@waiting\b|@[a-z][a-z0-9_-]*:[\p{L}\d][\p{L}\d/_-]*)/giu

export function priorityLevel(token: string): 'high' | 'med' | 'low' {
  const word = token.slice(1).toLowerCase() // drop the leading `!`
  if (word === 'high' || word === 'h') return 'high'
  if (word === 'low' || word === 'l') return 'low'
  return 'med'
}

/** Every metadata token in `text`, ordered by position. The token types never
 *  overlap on a line, so sorting by start is enough to keep them in sequence. */
export function scanTaskMetadata(text: string): TaskMetaToken[] {
  const tokens: TaskMetaToken[] = []
  let m: RegExpExecArray | null

  PRIORITY_RE.lastIndex = 0
  while ((m = PRIORITY_RE.exec(text)) !== null) {
    const start = m.index + m[1].length
    tokens.push({
      kind: 'priority',
      start,
      end: start + m[2].length,
      text: m[2],
      level: priorityLevel(m[2])
    })
  }
  DUE_RE.lastIndex = 0
  while ((m = DUE_RE.exec(text)) !== null) {
    const start = m.index + m[1].length
    tokens.push({ kind: 'due', start, end: start + m[2].length, text: m[2], date: m[3] })
  }
  FIELD_RE.lastIndex = 0
  while ((m = FIELD_RE.exec(text)) !== null) {
    const start = m.index + m[1].length
    const colon = m[2].indexOf(':')
    const field = (colon > 0 ? m[2].slice(1, colon) : m[2].slice(1)).toLowerCase()
    tokens.push({ kind: 'field', start, end: start + m[2].length, text: m[2], field })
  }

  tokens.sort((a, b) => a.start - b.start)
  return tokens
}

/** Local `YYYY-MM-DD` for today, matching how the parser compares due dates. */
export function todayIso(): string {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

export interface FieldChip {
  /** The chip's own class suffix: `repeat`, `remind`, or null for a plain field. */
  variant: 'repeat' | 'remind' | null
  /** A value the field cannot mean anything with draws dimmed. */
  invalid: boolean
  /** What the chip means, for its tooltip. */
  title?: string
}

/** How a field token draws. The recurring-task fields (#1036) get their own
 *  colors and say what they mean on hover; every other field is plain. */
export function fieldChip(token: TaskMetaToken): FieldChip {
  if (token.kind !== 'field') return { variant: null, invalid: false }
  const value = token.text.slice(token.text.indexOf(':') + 1)
  if (token.field === 'repeat') {
    const rule = parseRepeatRule(value)
    return rule
      ? { variant: 'repeat', invalid: false, title: `Repeats: ${describeRepeatRule(rule)}` }
      : { variant: 'repeat', invalid: true, title: 'Unknown repeat rule' }
  }
  if (token.field === 'remind') {
    const spec = parseRemindSpec(value)
    return spec
      ? { variant: 'remind', invalid: false, title: `Reminder: ${describeRemindSpec(spec)}` }
      : { variant: 'remind', invalid: true, title: 'Unknown reminder time' }
  }
  return { variant: null, invalid: false }
}
