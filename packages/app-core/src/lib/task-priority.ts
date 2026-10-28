import type { VaultTask } from '@shared/tasks'

/** How a task's priority reads beside it: the token as it is written on the
 *  line. Shared by the Tasks list and the Timeline panel so a priority looks
 *  the same wherever the task turns up. */
export function priorityLabel(p: VaultTask['priority']): string {
  if (p === 'high') return '!high'
  if (p === 'med') return '!med'
  if (p === 'low') return '!low'
  return ''
}

export function priorityClass(p: VaultTask['priority']): string {
  if (p === 'high') return 'text-rose-400'
  if (p === 'med') return 'text-amber-400'
  if (p === 'low') return 'text-sky-400'
  return 'text-current/50'
}
