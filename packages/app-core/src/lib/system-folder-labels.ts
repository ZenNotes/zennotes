import type { NoteFolder } from '@shared/ipc'

/** Customizable UI labels: the four system folders plus the Tasks view (#225).
 *  `tasks` isn't a folder, but it's renamed the same way and lives in the same
 *  Settings section. */
export type LabelKey = NoteFolder | 'tasks'

export type SystemFolderLabels = Partial<Record<LabelKey, string>>

export const DEFAULT_SYSTEM_FOLDER_LABELS: Record<LabelKey, string> = {
  inbox: 'Inbox',
  quick: 'Quick Notes',
  archive: 'Archive',
  trash: 'Trash',
  tasks: 'Tasks'
}

const LABEL_KEYS: LabelKey[] = ['inbox', 'quick', 'archive', 'trash', 'tasks']

function normalizeSystemFolderLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/\s+/g, ' ')
  if (!trimmed) return null
  return trimmed.slice(0, 48)
}

export function normalizeSystemFolderLabels(value: unknown): SystemFolderLabels {
  if (!value || typeof value !== 'object') return {}
  const raw = value as Partial<Record<LabelKey, unknown>>
  const next: SystemFolderLabels = {}
  for (const key of LABEL_KEYS) {
    const label = normalizeSystemFolderLabel(raw[key])
    if (label) next[key] = label
  }
  return next
}

export function getSystemFolderLabel(
  key: LabelKey,
  overrides?: SystemFolderLabels | null
): string {
  return overrides?.[key] ?? DEFAULT_SYSTEM_FOLDER_LABELS[key]
}

export function resolveSystemFolderLabels(
  overrides?: SystemFolderLabels | null
): Record<LabelKey, string> {
  return {
    inbox: getSystemFolderLabel('inbox', overrides),
    quick: getSystemFolderLabel('quick', overrides),
    archive: getSystemFolderLabel('archive', overrides),
    trash: getSystemFolderLabel('trash', overrides),
    tasks: getSystemFolderLabel('tasks', overrides)
  }
}
