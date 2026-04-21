import type { NoteFolder } from '@shared/ipc'

export type SystemFolderLabels = Partial<Record<NoteFolder, string>>

export const DEFAULT_SYSTEM_FOLDER_LABELS: Record<NoteFolder, string> = {
  inbox: 'Inbox',
  quick: 'Quick Notes',
  archive: 'Archive',
  trash: 'Trash'
}

const SYSTEM_FOLDERS: NoteFolder[] = ['inbox', 'quick', 'archive', 'trash']

function normalizeSystemFolderLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/\s+/g, ' ')
  if (!trimmed) return null
  return trimmed.slice(0, 48)
}

export function normalizeSystemFolderLabels(value: unknown): SystemFolderLabels {
  if (!value || typeof value !== 'object') return {}
  const raw = value as Partial<Record<NoteFolder, unknown>>
  const next: SystemFolderLabels = {}
  for (const folder of SYSTEM_FOLDERS) {
    const label = normalizeSystemFolderLabel(raw[folder])
    if (label) next[folder] = label
  }
  return next
}

export function getSystemFolderLabel(
  folder: NoteFolder,
  overrides?: SystemFolderLabels | null
): string {
  return overrides?.[folder] ?? DEFAULT_SYSTEM_FOLDER_LABELS[folder]
}

export function resolveSystemFolderLabels(
  overrides?: SystemFolderLabels | null
): Record<NoteFolder, string> {
  return {
    inbox: getSystemFolderLabel('inbox', overrides),
    quick: getSystemFolderLabel('quick', overrides),
    archive: getSystemFolderLabel('archive', overrides),
    trash: getSystemFolderLabel('trash', overrides)
  }
}
