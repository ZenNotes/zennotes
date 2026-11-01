import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { TASK_LINE_RE } from '@shared/tasklists'

/**
 * Values for the recurring-task fields (#1036) as you type them on a task
 * line: `@repeat:` offers the rules, `@remind:` the times. Anything else the
 * grammar takes (`3w`, `tue/fri`, `2d-7pm`) still types through; these are
 * the common ones and a reminder of the shapes.
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

const FIELD_AT_CURSOR_RE = /(?:^|\s)@(repeat|remind):([\p{L}\d/_-]*)$/iu

export function taskFieldSource(context: CompletionContext): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos)
  if (!TASK_LINE_RE.test(line.text)) return null
  const match = FIELD_AT_CURSOR_RE.exec(line.text.slice(0, context.pos - line.from))
  if (!match) return null
  const key = match[1].toLowerCase() as 'repeat' | 'remind'
  return {
    from: context.pos - match[2].length,
    options: OPTIONS[key].map((o) => ({ ...o, type: 'text' })),
    validFor: /^[\p{L}\d/_-]*$/u
  }
}
