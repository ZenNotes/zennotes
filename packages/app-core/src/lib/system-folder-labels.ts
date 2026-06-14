import type { NoteFolder } from '@shared/ipc'

/**
 * Built-in areas the user can re-label. The four note folders plus `assets`
 * (the resources library). `assets` is NOT a NoteFolder — it's the attachments
 * dir surfaced as a first-class view — so it gets its own key here.
 */
export type SystemAreaKey = NoteFolder | 'assets'
export type SystemFolderLabels = Partial<Record<SystemAreaKey, string>>

/** Canonical English source strings — these are also the i18n keys, so the
 *  unset default follows the UI language when a translator is supplied. */
export const DEFAULT_SYSTEM_FOLDER_LABELS: Record<SystemAreaKey, string> = {
  inbox: 'Inbox',
  quick: 'Quick Notes',
  archive: 'Archive',
  trash: 'Trash',
  assets: 'Assets'
}

const SYSTEM_AREAS: SystemAreaKey[] = ['inbox', 'quick', 'archive', 'trash', 'assets']

function normalizeSystemFolderLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/\s+/g, ' ')
  if (!trimmed) return null
  return trimmed.slice(0, 48)
}

export function normalizeSystemFolderLabels(value: unknown): SystemFolderLabels {
  if (!value || typeof value !== 'object') return {}
  const raw = value as Partial<Record<SystemAreaKey, unknown>>
  const next: SystemFolderLabels = {}
  for (const area of SYSTEM_AREAS) {
    const label = normalizeSystemFolderLabel(raw[area])
    if (label) next[area] = label
  }
  return next
}

/**
 * Resolve one area's display label. Priority: user override (verbatim) >
 * `translate(default)` (follows UI language) > the English default. The
 * translator is optional so non-React call sites still work (English default).
 */
export function getSystemFolderLabel(
  area: SystemAreaKey,
  overrides?: SystemFolderLabels | null,
  translate?: (source: string) => string
): string {
  const override = overrides?.[area]
  if (override) return override
  const fallback = DEFAULT_SYSTEM_FOLDER_LABELS[area]
  return translate ? translate(fallback) : fallback
}

export function resolveSystemFolderLabels(
  overrides?: SystemFolderLabels | null,
  translate?: (source: string) => string
): Record<SystemAreaKey, string> {
  return {
    inbox: getSystemFolderLabel('inbox', overrides, translate),
    quick: getSystemFolderLabel('quick', overrides, translate),
    archive: getSystemFolderLabel('archive', overrides, translate),
    trash: getSystemFolderLabel('trash', overrides, translate),
    assets: getSystemFolderLabel('assets', overrides, translate)
  }
}
