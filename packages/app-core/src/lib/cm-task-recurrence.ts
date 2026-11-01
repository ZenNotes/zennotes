/**
 * Checking off a recurring task inside the editor (#1036).
 *
 * `Mod+L`, the live-preview checkbox and the in-progress marker all check a
 * task off from inside CodeMirror. For a `@repeat:` task they make the same
 * edit the Tasks views make (`@shared/task-recurrence`): the next occurrence
 * goes above, the task's own line becomes the record. It is one change in one
 * transaction, so one undo takes it all back.
 *
 * Typing an `x` into the brackets by hand is a text edit, not a command, and
 * stays one: only these commands repeat a task.
 */
import { Facet, type ChangeSpec, type EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { planRecurringCompletion } from '@shared/task-recurrence'
import { noteFrontmatterDue, toIsoDateLocal } from '@shared/tasks'

export interface EditorRecurrenceContext {
  /** The note's own date when it is a daily note whose tasks take that date. */
  dailyDue?: string
}

/** What the note editor knows about the note it shows. Editors without it
 *  (quick capture, table cells) still repeat tasks, counting from the line's
 *  `due:` or the note's frontmatter, else from today. */
export const editorRecurrenceContext = Facet.define<
  () => EditorRecurrenceContext,
  (() => EditorRecurrenceContext) | null
>({
  combine: (providers) => providers[0] ?? null
})

export interface RecurringCheckOff {
  change: ChangeSpec
  /** Length of the new occurrence's line, which starts where the task did. */
  openLineLength: number
}

/**
 * The change that checks off the recurring task on 1-based line `lineNumber`,
 * or null when that line is not an open task with a `@repeat:` rule.
 */
export function recurringCheckOff(
  state: EditorState,
  lineNumber: number,
  opts: { skip?: boolean } = {}
): RecurringCheckOff | null {
  const line = state.doc.line(lineNumber)
  if (!/@repeat:/i.test(line.text)) return null
  const head = state.doc.sliceString(0, Math.min(state.doc.length, 4096))
  const context = state.facet(editorRecurrenceContext)?.() ?? {}
  const plan = planRecurringCompletion(state.doc.toJSON(), lineNumber - 1, {
    today: toIsoDateLocal(new Date()),
    fallbackDue: noteFrontmatterDue(head) ?? context.dailyDue,
    skip: opts.skip
  })
  if (!plan) return null
  return {
    change: { from: line.from, to: line.to, insert: [...plan.next, plan.record].join('\n') },
    openLineLength: plan.next[0].length
  }
}

/**
 * Check off the task whose `[` marker starts at `markerFrom`: a recurring task
 * repeats, anything else gets its state char set to `x`. For the clickable
 * markers, which act on their own line and leave the cursor alone.
 */
export function checkOffTaskAtMarker(view: EditorView, markerFrom: number): void {
  const line = view.state.doc.lineAt(markerFrom)
  const recurring = recurringCheckOff(view.state, line.number)
  if (recurring) {
    view.dispatch({ changes: recurring.change, userEvent: 'input' })
    return
  }
  view.dispatch({ changes: { from: markerFrom + 1, to: markerFrom + 2, insert: 'x' } })
}
