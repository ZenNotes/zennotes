import {
  DEFAULT_DAILY_NOTES_DIRECTORY,
  DEFAULT_WEEKLY_NOTES_DIRECTORY,
  DEFAULT_VAULT_SETTINGS,
  type AssetMeta,
  type FolderIconId,
  type NoteFolder,
  type NoteMeta,
  type VaultSettings
} from '@shared/ipc'
import { getISOWeek, getISOWeekYear, mondayOfISOWeek } from './template-render'

const SYSTEM_FOLDERS = new Set<NoteFolder>(['inbox', 'quick', 'archive', 'trash'])
const RESERVED_ROOT_NAMES = new Set<string>([
  'inbox',
  'quick',
  'archive',
  'trash',
  'attachements',
  '_assets',
  '.zennotes'
])
const VALID_FOLDER_ICON_IDS = new Set<FolderIconId>([
  'folder',
  'bolt',
  'tray',
  'archive',
  'trash',
  'book',
  'bookmark',
  'calendar',
  'briefcase',
  'tag',
  'document',
  'sparkle',
  'code',
  'user',
  'star',
  'heart',
  'link',
  'lightbulb',
  'flask',
  'graduation',
  'music',
  'image',
  'palette',
  'terminal',
  'wrench',
  'globe',
  'map',
  'chart',
  'home'
])

function isFolderIconId(value: unknown): value is FolderIconId {
  return typeof value === 'string' && VALID_FOLDER_ICON_IDS.has(value as FolderIconId)
}

function pad(n: number): string {
  return n.toString().padStart(2, '0')
}

export function normalizeDailyNotesDirectory(directory: string | null | undefined): string {
  const trimmed = (directory ?? '').trim().replace(/^\/+|\/+$/g, '')
  return trimmed || DEFAULT_DAILY_NOTES_DIRECTORY
}

export function normalizeWeeklyNotesDirectory(directory: string | null | undefined): string {
  const trimmed = (directory ?? '').trim().replace(/^\/+|\/+$/g, '')
  return trimmed || DEFAULT_WEEKLY_NOTES_DIRECTORY
}

function normalizeTemplateId(value: string | null | undefined): string | undefined {
  const trimmed = (value ?? '').trim()
  return trimmed || undefined
}

export function normalizeVaultSettings(
  settings: VaultSettings | null | undefined
): VaultSettings {
  const folderIcons = settings?.folderIcons
  const normalizedFolderIcons: Record<string, FolderIconId> = {}
  if (folderIcons && typeof folderIcons === 'object') {
    for (const [key, value] of Object.entries(folderIcons)) {
      if (!key || !isFolderIconId(value)) continue
      normalizedFolderIcons[key] = value
    }
  }
  return {
    primaryNotesLocation:
      settings?.primaryNotesLocation === 'root'
        ? 'root'
        : DEFAULT_VAULT_SETTINGS.primaryNotesLocation,
    dailyNotes: {
      enabled: !!settings?.dailyNotes?.enabled,
      directory: normalizeDailyNotesDirectory(settings?.dailyNotes?.directory),
      templateId: normalizeTemplateId(settings?.dailyNotes?.templateId)
    },
    weeklyNotes: {
      enabled: !!settings?.weeklyNotes?.enabled,
      directory: normalizeWeeklyNotesDirectory(settings?.weeklyNotes?.directory),
      templateId: normalizeTemplateId(settings?.weeklyNotes?.templateId)
    },
    folderIcons: normalizedFolderIcons
  }
}

export function folderIconKey(folder: NoteFolder, subpath: string): string {
  return `${folder}:${subpath}`
}

export function rewriteFolderIconsForRename(
  folderIcons: Record<string, FolderIconId>,
  folder: NoteFolder,
  oldSubpath: string,
  newSubpath: string
): Record<string, FolderIconId> {
  const next: Record<string, FolderIconId> = {}
  const exactKey = folderIconKey(folder, oldSubpath)
  const prefix = `${exactKey}/`
  for (const [key, value] of Object.entries(folderIcons)) {
    if (key === exactKey) {
      next[folderIconKey(folder, newSubpath)] = value
      continue
    }
    if (key.startsWith(prefix)) {
      next[folderIconKey(folder, newSubpath) + key.slice(exactKey.length)] = value
      continue
    }
    next[key] = value
  }
  return next
}

export function removeFolderIcons(
  folderIcons: Record<string, FolderIconId>,
  folder: NoteFolder,
  subpath: string
): Record<string, FolderIconId> {
  const next: Record<string, FolderIconId> = {}
  const exactKey = folderIconKey(folder, subpath)
  const prefix = `${exactKey}/`
  for (const [key, value] of Object.entries(folderIcons)) {
    if (key === exactKey || key.startsWith(prefix)) continue
    next[key] = value
  }
  return next
}

export function duplicateFolderIcons(
  folderIcons: Record<string, FolderIconId>,
  folder: NoteFolder,
  sourceSubpath: string,
  targetSubpath: string
): Record<string, FolderIconId> {
  const next: Record<string, FolderIconId> = { ...folderIcons }
  const exactKey = folderIconKey(folder, sourceSubpath)
  const prefix = `${exactKey}/`
  for (const [key, value] of Object.entries(folderIcons)) {
    if (key === exactKey) {
      next[folderIconKey(folder, targetSubpath)] = value
      continue
    }
    if (key.startsWith(prefix)) {
      next[folderIconKey(folder, targetSubpath) + key.slice(exactKey.length)] = value
    }
  }
  return next
}

export function isPrimaryNotesAtRoot(
  settings: VaultSettings | null | undefined
): boolean {
  return normalizeVaultSettings(settings).primaryNotesLocation === 'root'
}

export function notePathWithinFolder(
  path: string,
  folder: NoteFolder,
  settings: VaultSettings | null | undefined
): string {
  if (folder === 'inbox' && isPrimaryNotesAtRoot(settings)) return path
  const prefix = `${folder}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

export function noteFolderSubpath(
  note: Pick<NoteMeta, 'folder' | 'path'>,
  settings: VaultSettings | null | undefined
): string {
  const within = notePathWithinFolder(note.path, note.folder, settings)
  const parts = within.split('/').filter(Boolean)
  return parts.length > 1 ? parts.slice(0, -1).join('/') : ''
}

export function noteBelongsToFolderView(
  note: Pick<NoteMeta, 'folder' | 'path'>,
  folder: NoteFolder,
  subpath: string,
  settings: VaultSettings | null | undefined
): boolean {
  if (note.folder !== folder) return false
  if (!subpath) return true
  const parent = noteFolderSubpath(note, settings)
  return parent === subpath || parent.startsWith(`${subpath}/`)
}

export function noteTitleForDate(date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function weeklyNoteTitle(date = new Date()): string {
  return `${getISOWeekYear(date)}-W${pad(getISOWeek(date))}`
}

const DAILY_TITLE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const WEEKLY_TITLE_RE = /^(\d{4})-W(\d{2})$/

export interface DateNoteInfo {
  kind: 'daily' | 'weekly'
  /** Daily: that calendar day. Weekly: the Monday of that ISO week. */
  date: Date
}

/**
 * Classify a note as a daily or weekly note, or `null` if it is neither.
 * A note qualifies only when its title matches the date/week format, it lives
 * in the configured daily/weekly directory, and that feature is enabled — so a
 * stray note titled `2026-06-08` outside the daily folder is not treated as one.
 */
export function classifyDateNote(
  note: Pick<NoteMeta, 'folder' | 'path' | 'title'>,
  settings: VaultSettings | null | undefined
): DateNoteInfo | null {
  const normalized = normalizeVaultSettings(settings)
  const subpath = noteFolderSubpath(note, settings)

  if (normalized.dailyNotes.enabled && subpath === normalized.dailyNotes.directory) {
    const m = DAILY_TITLE_RE.exec(note.title)
    if (m) {
      const [, y, mo, d] = m
      return { kind: 'daily', date: new Date(Number(y), Number(mo) - 1, Number(d)) }
    }
  }

  if (normalized.weeklyNotes.enabled && subpath === normalized.weeklyNotes.directory) {
    const m = WEEKLY_TITLE_RE.exec(note.title)
    if (m) {
      const [, y, w] = m
      return { kind: 'weekly', date: mondayOfISOWeek(Number(y), Number(w)) }
    }
  }

  return null
}

export function folderForVaultRelativePath(
  relPath: string,
  settings: VaultSettings | null | undefined
): NoteFolder | null {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  const top = normalized.split('/')[0] ?? ''
  if (!top || top.startsWith('.')) return null
  if (SYSTEM_FOLDERS.has(top as NoteFolder)) return top as NoteFolder
  if (isPrimaryNotesAtRoot(settings) && !RESERVED_ROOT_NAMES.has(top)) return 'inbox'
  return null
}

export function assetPathWithinFolder(
  assetPath: string,
  folder: NoteFolder,
  settings: VaultSettings | null | undefined
): string {
  const normalized = assetPath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (folder === 'inbox' && isPrimaryNotesAtRoot(settings)) return normalized
  const prefix = `${folder}/`
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized
}

export function assetFolderSubpath(
  asset: Pick<AssetMeta, 'path'>,
  settings: VaultSettings | null | undefined
): string {
  const folder = folderForVaultRelativePath(asset.path, settings)
  if (!folder) return ''
  const within = assetPathWithinFolder(asset.path, folder, settings)
  const parts = within.split('/').filter(Boolean)
  return parts.length > 1 ? parts.slice(0, -1).join('/') : ''
}

export function assetBelongsToFolderView(
  asset: Pick<AssetMeta, 'path'>,
  folder: NoteFolder,
  subpath: string,
  settings: VaultSettings | null | undefined
): boolean {
  const assetFolder = folderForVaultRelativePath(asset.path, settings)
  if (assetFolder !== folder) return false
  if (!subpath) return true
  const parent = assetFolderSubpath(asset, settings)
  return parent === subpath || parent.startsWith(`${subpath}/`)
}
