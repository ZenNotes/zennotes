import {
  DEFAULT_DAILY_NOTES_DIRECTORY,
  DEFAULT_VAULT_SETTINGS,
  type AssetMeta,
  type FolderIconId,
  type NoteFolder,
  type NoteMeta,
  type VaultSettings
} from '@shared/ipc'

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

function pad(n: number): string {
  return n.toString().padStart(2, '0')
}

export function normalizeDailyNotesDirectory(directory: string | null | undefined): string {
  const trimmed = (directory ?? '').trim().replace(/^\/+|\/+$/g, '')
  return trimmed || DEFAULT_DAILY_NOTES_DIRECTORY
}

export function normalizeVaultSettings(
  settings: VaultSettings | null | undefined
): VaultSettings {
  const folderIcons = settings?.folderIcons
  const normalizedFolderIcons: Record<string, FolderIconId> = {}
  if (folderIcons && typeof folderIcons === 'object') {
    for (const [key, value] of Object.entries(folderIcons)) {
      if (!key || typeof value !== 'string') continue
      if (VALID_FOLDER_ICON_IDS.has(value as FolderIconId)) {
        normalizedFolderIcons[key] = value
      }
    }
  }
  return {
    primaryNotesLocation:
      settings?.primaryNotesLocation === 'root'
        ? 'root'
        : DEFAULT_VAULT_SETTINGS.primaryNotesLocation,
    dailyNotes: {
      enabled: !!settings?.dailyNotes?.enabled,
      directory: normalizeDailyNotesDirectory(settings?.dailyNotes?.directory)
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
