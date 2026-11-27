import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { TASK_LINE_RE } from '@shared/tasklists'
import { toIsoDateLocal } from '@shared/tasks'

/**
 * Values for the recurring-task fields (#1036) as you type them on a task
 * line: `@repeat:` offers the rules, `@remind:` the times. Anything else the
 * grammar takes (`3w`, `tue/fri`, `2d-7pm`) still types through; these are
 * the common ones and a reminder of the shapes. `@scheduled:` (#1119) offers
 * the days nearest today, since a planned day is a date and nothing else.
 */
const OPTIONS: Record<'repeat' | 'remind', { label: string; detail: string }[]> = {
  repeat: [
    { label: 'daily', detail: 'every day' },
    { label: 'weekdays', detail: 'Mon to Fri' },
    { label: 'weekly', detail: 'every 7 days' },
    { label: '2w', detail: 'every 2 weeks' },
    { label: 'monthly', detail: 'every month' },
    { label: 'yearly', detail: 'every year' },
    { label: 'mon/thu', detail: 'on those days' },
    { label: 'after-3d', detail: '3 days after done' }
  ],
  remind: [
    { label: '9am', detail: 'on the due date' },
    { label: '6pm', detail: 'on the due date' },
    { label: '0d', detail: 'morning of' },
    { label: '1d', detail: 'day before' },
    { label: '2d-6pm', detail: '2 days before, 6 PM' }
  ]
}

/** Today and the days after it, as the dates `@scheduled:` takes. */
function plannedDayOptions(now: Date): { label: string; detail: string }[] {
  const day = (offset: number): Date =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
  const weekday = (date: Date): string => date.toLocaleDateString(undefined, { weekday: 'long' })
  return [
    { label: toIsoDateLocal(day(0)), detail: 'today' },
    { label: toIsoDateLocal(day(1)), detail: 'tomorrow' },
    ...[2, 3, 4, 5, 6, 7].map((n) => ({ label: toIsoDateLocal(day(n)), detail: weekday(day(n)) }))
  ]
}

const FIELD_AT_CURSOR_RE = /(?:^|\s)@(repeat|remind|scheduled):([\p{L}\d/_-]*)$/iu

export function taskFieldSource(context: CompletionContext): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos)
  if (!TASK_LINE_RE.test(line.text)) return null
  const match = FIELD_AT_CURSOR_RE.exec(line.text.slice(0, context.pos - line.from))
  if (!match) return null
  const key = match[1].toLowerCase() as 'repeat' | 'remind' | 'scheduled'
  const options = key === 'scheduled' ? plannedDayOptions(new Date()) : OPTIONS[key]
  return {
    from: context.pos - match[2].length,
    // Dates keep their order: sorted by match they would still read in date
    // order, but nothing here should depend on that.
    options: options.map((o, i) => ({ ...o, type: 'text', boost: -i })),
    validFor: /^[\p{L}\d/_-]*$/u
  }
}
