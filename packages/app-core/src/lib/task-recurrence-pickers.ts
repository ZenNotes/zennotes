/**
 * The Repeat… and Remind… pickers (#1036): `r` / `R` on every Tasks surface,
 * the task menu, and the command palette all open these. Each is the app's
 * prompt with a short list of presets, so the common choices are one Enter
 * away and anything else (`2w`, `mon/thu`, `2d-6pm`) is typed in place.
 *
 * Both write a plain `@repeat:` / `@remind:` field through the queued task
 * writer, like every other task edit from a list.
 */
import type { VaultTask } from '@shared/tasks'
import { parseRepeatRule } from '@shared/task-recurrence'
import { formatClock, parseHhMm, parseRemindSpec } from '@shared/task-reminders'
import type { PromptSuggestion } from '../components/PromptModal'
import { useStore } from '../store'
import { promptApp } from './prompt-requests'
import { useToastStore } from './toast'

const REPEAT_SUGGESTIONS: PromptSuggestion[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekdays', label: 'Weekdays', detail: 'Mon to Fri' },
  { value: 'weekly', label: 'Weekly' },
  { value: '2w', label: 'Every 2 weeks' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' }
]

const OFF = 'off'

function fileTaskNotice(): void {
  useToastStore.getState().addToast('Repeat and reminders work on checkbox tasks.', 'info')
}

/** Ask how a task repeats. Resolves to a rule, `null` to stop repeating, or
 *  `undefined` when the prompt was dismissed or nothing changed. */
export async function promptRepeatRule(
  description: string,
  current: string | undefined
): Promise<string | null | undefined> {
  const value = await promptApp({
    title: 'Repeat',
    description,
    placeholder: 'weekly, 2w, mon/thu, after-3d',
    okLabel: 'Repeat',
    plainInput: true,
    autoHighlightFirst: true,
    suggestions: [
      ...REPEAT_SUGGESTIONS.map((s) => (s.value === current ? { ...s, detail: 'current' } : s)),
      ...(current ? [{ value: OFF, label: 'Stop repeating' }] : [])
    ],
    validate: (raw) => {
      const v = raw.trim().toLowerCase()
      return !v || v === OFF || parseRepeatRule(v) ? null : 'Try weekly, 2w, mon/thu or after-3d'
    }
  })
  const rule = value?.trim().toLowerCase()
  if (!rule || rule === current) return undefined
  return rule === OFF ? null : rule
}

/** Ask when a task reminds. Resolves like {@link promptRepeatRule}. */
export async function promptRemindWhen(
  description: string,
  current: string | undefined
): Promise<string | null | undefined> {
  const state = useStore.getState()
  const at = formatClock(parseHhMm(state.taskReminderTime), state.timeFormat)
  const presets: PromptSuggestion[] = [
    { value: '0d', label: 'Morning of', detail: at },
    { value: '1d', label: 'Day before', detail: at },
    { value: '9am', label: '9:00 AM' },
    { value: '6pm', label: '6:00 PM' }
  ]
  const value = await promptApp({
    title: 'Remind',
    description,
    placeholder: '9am, 1730, 1d, 2d-6pm',
    okLabel: 'Remind',
    plainInput: true,
    autoHighlightFirst: true,
    suggestions: [
      ...presets.map((s) => (s.value === current ? { ...s, detail: 'current' } : s)),
      ...(current ? [{ value: OFF, label: 'No reminder' }] : [])
    ],
    validate: (raw) => {
      const v = raw.trim().toLowerCase()
      return !v || v === OFF || parseRemindSpec(v) ? null : 'Try 9am, 1730, 1d or 2d-6pm'
    }
  })
  const when = value?.trim().toLowerCase()
  if (!when || when === current) return undefined
  return when === OFF ? null : when
}

/** Pick how `task` repeats, or stop it repeating. */
export async function chooseTaskRepeat(task: VaultTask): Promise<void> {
  if (task.kind === 'file') return fileTaskNotice()
  const rule = await promptRepeatRule(task.content, task.fields?.repeat)
  if (rule === undefined) return
  await useStore.getState().applyTaskMutation(task, { kind: 'set-field', key: 'repeat', value: rule })
}

/** Pick when `task` reminds, or take its reminder off. */
export async function chooseTaskRemind(task: VaultTask): Promise<void> {
  if (task.kind === 'file') return fileTaskNotice()
  const when = await promptRemindWhen(task.content, task.fields?.remind)
  if (when === undefined) return
  await useStore.getState().applyTaskMutation(task, { kind: 'set-field', key: 'remind', value: when })
  if (when && !task.due) noDueNotice()
}

/** Said when a reminder lands on a task with no date to be reminded of. */
export function noDueNotice(): void {
  useToastStore.getState().addToast('A reminder needs a due date.', 'info')
}
