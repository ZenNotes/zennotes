/**
 * Repeat and Remind for the task under the editor's cursor (#1036): the
 * `:repeat` / `:remind` ex commands and the command palette's "Repeat Task…" /
 * "Remind Task…". With an argument (`:repeat weekly`, `:remind off`) the field
 * is written at once; without one the same picker the Tasks views use opens.
 */
import type { EditorView } from '@codemirror/view'
import { TASK_LINE_RE } from '@shared/tasklists'
import { parseRepeatRule, setRemindField, setRepeatField } from '@shared/task-recurrence'
import { parseRemindSpec } from '@shared/task-reminders'
import { noteFrontmatterDue } from '@shared/tasks'
import { editorRecurrenceContext } from './cm-task-recurrence'
import { useToastStore } from './toast'
import { noDueNotice, promptRemindWhen, promptRepeatRule } from './task-recurrence-pickers'

type TaskFieldKey = 'repeat' | 'remind'

function toast(message: string): void {
  useToastStore.getState().addToast(message, 'info')
}

/** The task line under the main cursor: its 1-based number and parts. */
function cursorTask(view: EditorView): { number: number; match: RegExpMatchArray } | null {
  const line = view.state.doc.lineAt(view.state.selection.main.head)
  const match = line.text.match(TASK_LINE_RE)
  return match && match[3].startsWith(']') ? { number: line.number, match } : null
}

function fieldOf(tail: string, key: TaskFieldKey): string | undefined {
  return new RegExp(`(?:^|\\s)@${key}:([\\p{L}\\d][\\p{L}\\d/_-]*)`, 'iu').exec(tail)?.[1]?.toLowerCase()
}

/** Write `value` (null removes it) as the `@key:` field of task line `number`,
 *  keeping the cursor where it was on the line. False when it is no task. */
function writeField(view: EditorView, number: number, key: TaskFieldKey, value: string | null): boolean {
  if (number > view.state.doc.lines) return false
  const line = view.state.doc.line(number)
  const match = line.text.match(TASK_LINE_RE)
  if (!match || !match[3].startsWith(']')) return false
  const tailFrom = line.from + match[1].length + match[2].length + 1
  const tail = line.text.slice(tailFrom - line.from)
  const next = key === 'repeat' ? setRepeatField(tail, value) : setRemindField(tail, value)
  if (next === tail) return true
  const head = view.state.selection.main.head
  const onLine = head >= line.from && head <= line.to
  view.dispatch({
    changes: { from: tailFrom, to: line.to, insert: next },
    ...(onLine ? { selection: { anchor: Math.min(head, tailFrom + next.length) } } : {}),
    userEvent: 'input'
  })
  return true
}

async function setCursorTaskField(view: EditorView, key: TaskFieldKey, arg: string): Promise<void> {
  const task = cursorTask(view)
  if (!task) {
    toast('Put the cursor on a task first.')
    return
  }
  const tail = task.match[3].slice(1)
  const current = fieldOf(tail, key)
  let value: string | null | undefined
  const typed = arg.trim().toLowerCase()
  if (typed) {
    value = typed === 'off' ? null : typed
    const valid = value == null || (key === 'repeat' ? parseRepeatRule(value) : parseRemindSpec(value))
    if (!valid) {
      toast(key === 'repeat' ? 'Try weekly, 2w, mon/thu or after-3d' : 'Try 9am, 1730, 1d or 2d-6pm')
      return
    }
  } else {
    const description = tail.trim()
    value =
      key === 'repeat'
        ? await promptRepeatRule(description, current)
        : await promptRemindWhen(description, current)
    if (value === undefined) return
    view.focus()
  }
  if (!writeField(view, task.number, key, value)) return
  if (key === 'remind' && value && !taskHasDate(view, tail)) noDueNotice()
}

/** Whether a task line has a date to be reminded of: its own `due:`, the
 *  note's frontmatter `due:`, or the daily note's date. */
function taskHasDate(view: EditorView, tail: string): boolean {
  if (/(?:^|\s)due:\s*\d{4}-\d{2}-\d{2}/i.test(tail)) return true
  const head = view.state.doc.sliceString(0, Math.min(view.state.doc.length, 4096))
  return Boolean(noteFrontmatterDue(head) ?? view.state.facet(editorRecurrenceContext)?.().dailyDue)
}

/** `:repeat [rule|off]`: set how the task under the cursor repeats. */
export function repeatTaskAtCursor(view: EditorView, arg = ''): Promise<void> {
  return setCursorTaskField(view, 'repeat', arg)
}

/** `:remind [when|off]`: set when the task under the cursor reminds. */
export function remindTaskAtCursor(view: EditorView, arg = ''): Promise<void> {
  return setCursorTaskField(view, 'remind', arg)
}
