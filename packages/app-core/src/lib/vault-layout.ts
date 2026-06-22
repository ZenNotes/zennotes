import {
  DEFAULT_DAILY_NOTE_LOCALE,
  DEFAULT_DAILY_NOTE_TITLE_PATTERN,
  DEFAULT_DAILY_NOTES_DIRECTORY,
  DEFAULT_WEEKLY_NOTE_LOCALE,
  DEFAULT_WEEKLY_NOTE_TITLE_PATTERN,
  DEFAULT_WEEKLY_NOTES_DIRECTORY,
  DEFAULT_VAULT_SETTINGS,
  type AssetMeta,
  type DateNotePatternSettings,
  type FolderIconId,
  type FolderColorId,
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
  'assets',
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

const VALID_FOLDER_COLOR_IDS = new Set<FolderColorId>([
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'sky',
  'blue',
  'indigo',
  'violet',
  'pink'
])

export function isFolderColorId(value: unknown): value is FolderColorId {
  return typeof value === 'string' && VALID_FOLDER_COLOR_IDS.has(value as FolderColorId)
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

export function normalizeDailyNoteTitlePattern(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim().replace(/[\\/]+/g, '-')
  return trimmed || DEFAULT_DAILY_NOTE_TITLE_PATTERN
}

export function normalizeDailyNoteLocale(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim()
  return trimmed || DEFAULT_DAILY_NOTE_LOCALE
}

export function normalizeWeeklyNoteTitlePattern(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim().replace(/[\\/]+/g, '-')
  return trimmed || DEFAULT_WEEKLY_NOTE_TITLE_PATTERN
}

export function normalizeWeeklyNoteLocale(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim()
  return trimmed || DEFAULT_WEEKLY_NOTE_LOCALE
}

function dateNotePatternKey(pattern: DateNotePatternSettings): string {
  return `${pattern.directory}\0${pattern.titlePattern ?? ''}\0${pattern.locale ?? ''}`
}

function normalizeDailyNotePatternHistory(
  value: readonly DateNotePatternSettings[] | null | undefined,
  primaryNotesLocation: VaultSettings['primaryNotesLocation']
): DateNotePatternSettings[] {
  if (!Array.isArray(value)) return []
  const out: DateNotePatternSettings[] = []
  const seen = new Set<string>()
  for (const pattern of value) {
    const next = {
      directory: normalizePrimaryRelativeSubpath(
        normalizeDailyNotesDirectory(pattern?.directory),
        { primaryNotesLocation }
      ),
      titlePattern: normalizeDailyNoteTitlePattern(pattern?.titlePattern),
      locale: normalizeDailyNoteLocale(pattern?.locale)
    }
    const key = dateNotePatternKey(next)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(next)
  }
  return out
}

function normalizeWeeklyNotePatternHistory(
  value: readonly DateNotePatternSettings[] | null | undefined,
  primaryNotesLocation: VaultSettings['primaryNotesLocation']
): DateNotePatternSettings[] {
  if (!Array.isArray(value)) return []
  const out: DateNotePatternSettings[] = []
  const seen = new Set<string>()
  for (const pattern of value) {
    const next = {
      directory: normalizePrimaryRelativeSubpath(
        normalizeWeeklyNotesDirectory(pattern?.directory),
        { primaryNotesLocation }
      ),
      titlePattern: normalizeWeeklyNoteTitlePattern(pattern?.titlePattern),
      locale: normalizeWeeklyNoteLocale(pattern?.locale)
    }
    const key = dateNotePatternKey(next)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(next)
  }
  return out
}

function normalizePrimaryRelativeSubpath(
  subpath: string,
  settings: Pick<VaultSettings, 'primaryNotesLocation'>
): string {
  if (settings.primaryNotesLocation !== 'inbox') return subpath
  if (subpath === 'inbox') return ''
  return subpath.startsWith('inbox/') ? subpath.slice('inbox/'.length) : subpath
}

function normalizeTemplateId(value: string | null | undefined): string | undefined {
  const trimmed = (value ?? '').trim()
  return trimmed || undefined
}

function localeArg(locale: string): string | undefined {
  return locale === DEFAULT_DAILY_NOTE_LOCALE ? undefined : locale
}

function localeDatePart(
  date: Date,
  locale: string,
  options: Intl.DateTimeFormatOptions
): string {
  try {
    return date.toLocaleDateString(localeArg(locale), options)
  } catch {
    return date.toLocaleDateString(undefined, options)
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

const DATE_NOTE_PATTERN_TOKENS = [
  'yyyy',
  'yy',
  'MMMM',
  'MMM',
  'MM',
  'M',
  'dd',
  'd',
  'EEEE',
  'EEE',
  'ww',
  'w'
] as const

type DateNotePatternToken = (typeof DATE_NOTE_PATTERN_TOKENS)[number]

type DateNotePatternPart =
  | { kind: 'literal'; value: string }
  | { kind: 'token'; value: DateNotePatternToken }

function parseDateNotePattern(pattern: string): DateNotePatternPart[] {
  const parts: DateNotePatternPart[] = []
  let literal = ''
  let quoted = false

  const flushLiteral = (): void => {
    if (!literal) return
    parts.push({ kind: 'literal', value: literal })
    literal = ''
  }

  for (let i = 0; i < pattern.length; ) {
    const ch = pattern[i]
    if (ch === "'") {
      if (pattern[i + 1] === "'") {
        literal += "'"
        i += 2
        continue
      }
      quoted = !quoted
      i += 1
      continue
    }

    if (!quoted) {
      const token = DATE_NOTE_PATTERN_TOKENS.find((candidate) =>
        pattern.startsWith(candidate, i)
      )
      if (token) {
        flushLiteral()
        parts.push({ kind: 'token', value: token })
        i += token.length
        continue
      }
    }

    literal += ch
    i += 1
  }
  flushLiteral()
  return parts
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function formatDateNotePattern(
  date: Date,
  pattern: string,
  locale: string,
  parts: { year?: number; week?: number } = {}
): string {
  const year = parts.year ?? date.getFullYear()
  const week = parts.week ?? getISOWeek(date)
  const month = date.getMonth() + 1
  const day = date.getDate()
  return parseDateNotePattern(pattern)
    .map((part) => {
      if (part.kind === 'literal') return part.value
      switch (part.value) {
        case 'yyyy':
          return String(year)
        case 'yy':
          return pad2(year % 100)
        case 'MMMM':
          return localeDatePart(date, locale, { month: 'long' })
        case 'MMM':
          return localeDatePart(date, locale, { month: 'short' })
        case 'MM':
          return pad2(month)
        case 'M':
          return String(month)
        case 'dd':
          return pad2(day)
        case 'd':
          return String(day)
        case 'EEEE':
          return localeDatePart(date, locale, { weekday: 'long' })
        case 'EEE':
          return localeDatePart(date, locale, { weekday: 'short' })
        case 'ww':
          return pad2(week)
        case 'w':
          return String(week)
      }
    })
    .join('')
}

interface DateNotePatternMatch {
  year?: number
  month?: number
  day?: number
  week?: number
}

function mergeCapture(
  match: DateNotePatternMatch,
  key: keyof DateNotePatternMatch,
  value: number
): boolean {
  if (match[key] !== undefined && match[key] !== value) return false
  match[key] = value
  return true
}

function readTwoDigitYear(value: string): number {
  const n = Number(value)
  return n >= 70 ? 1900 + n : 2000 + n
}

function matchDateNotePattern(pattern: string, text: string): DateNotePatternMatch | null {
  const captures: Array<{ token: DateNotePatternToken; index: number }> = []
  let captureIndex = 1
  const source = parseDateNotePattern(pattern)
    .map((part) => {
      if (part.kind === 'literal') return escapeRegex(part.value)
      switch (part.value) {
        case 'yyyy':
          captures.push({ token: part.value, index: captureIndex++ })
          return '(\\d{4})'
        case 'yy':
          captures.push({ token: part.value, index: captureIndex++ })
          return '(\\d{2})'
        case 'MM':
        case 'M':
        case 'dd':
        case 'd':
        case 'ww':
        case 'w':
          captures.push({ token: part.value, index: captureIndex++ })
          return '(\\d{1,2})'
        case 'MMMM':
        case 'MMM':
        case 'EEEE':
        case 'EEE':
          return '[^/]+'
      }
    })
    .join('')
  const re = new RegExp(`^${source}$`)
  const m = re.exec(text)
  if (!m) return null

  const out: DateNotePatternMatch = {}
  for (const capture of captures) {
    const raw = m[capture.index]
    if (!raw) continue
    const value = Number(raw)
    switch (capture.token) {
      case 'yyyy':
        if (!mergeCapture(out, 'year', value)) return null
        break
      case 'yy':
        if (!mergeCapture(out, 'year', readTwoDigitYear(raw))) return null
        break
      case 'MM':
      case 'M':
        if (!mergeCapture(out, 'month', value)) return null
        break
      case 'dd':
      case 'd':
        if (!mergeCapture(out, 'day', value)) return null
        break
      case 'ww':
      case 'w':
        if (!mergeCapture(out, 'week', value)) return null
        break
    }
  }
  return out
}

function shouldFormatDirectoryPattern(pattern: string): boolean {
  const tokens = parseDateNotePattern(pattern).filter((part) => part.kind === 'token')
  return (
    pattern.includes("'") ||
    tokens.length >= 2 ||
    tokens.some((part) => part.value === 'yyyy' || part.value === 'yy' || part.value === 'ww')
  )
}

function formatDirectoryPattern(
  date: Date,
  pattern: string,
  locale: string,
  parts: { year?: number; week?: number } = {}
): string {
  if (!shouldFormatDirectoryPattern(pattern)) return pattern
  return formatDateNotePattern(date, pattern, locale, parts)
}

function matchDirectoryPattern(pattern: string, text: string): DateNotePatternMatch | null {
  if (!shouldFormatDirectoryPattern(pattern)) return pattern === text ? {} : null
  return matchDateNotePattern(pattern, text)
}

export function dateNoteDirectoryDisplayLabel(
  pattern: string,
  fallbackLabel: string
): string {
  if (!shouldFormatDirectoryPattern(pattern)) {
    return pattern.split('/').filter(Boolean).pop() || fallbackLabel
  }

  for (const segment of pattern.split('/')) {
    const parts = parseDateNotePattern(segment)
    if (parts.some((part) => part.kind === 'token')) continue
    const literal = parts
      .map((part) => (part.kind === 'literal' ? part.value : ''))
      .join('')
      .trim()
    if (literal) return literal
  }

  return fallbackLabel
}

const DATE_PATTERN_MATCH_KEYS: Array<keyof DateNotePatternMatch> = [
  'year',
  'month',
  'day',
  'week'
]

function mergePatternMatch(
  target: DateNotePatternMatch,
  source: DateNotePatternMatch
): boolean {
  for (const key of DATE_PATTERN_MATCH_KEYS) {
    const value = source[key]
    if (value !== undefined && !mergeCapture(target, key, value)) return false
  }
  return true
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
  const folderColors = settings?.folderColors
  const normalizedFolderColors: Record<string, FolderColorId> = {}
  if (folderColors && typeof folderColors === 'object') {
    for (const [key, value] of Object.entries(folderColors)) {
      if (!key || !isFolderColorId(value)) continue
      normalizedFolderColors[key] = value
    }
  }
  const normalizedFavorites: string[] = []
  if (Array.isArray(settings?.favorites)) {
    const seen = new Set<string>()
    for (const entry of settings.favorites) {
      if (typeof entry !== 'string' || !entry || seen.has(entry)) continue
      seen.add(entry)
      normalizedFavorites.push(entry)
    }
  }
  const primaryNotesLocation =
    settings?.primaryNotesLocation === 'root'
      ? 'root'
      : DEFAULT_VAULT_SETTINGS.primaryNotesLocation
  const dailyDirectory = normalizePrimaryRelativeSubpath(
    normalizeDailyNotesDirectory(settings?.dailyNotes?.directory),
    { primaryNotesLocation }
  )
  const weeklyDirectory = normalizePrimaryRelativeSubpath(
    normalizeWeeklyNotesDirectory(settings?.weeklyNotes?.directory),
    { primaryNotesLocation }
  )

  return {
    primaryNotesLocation,
    dailyNotes: {
      enabled: !!settings?.dailyNotes?.enabled,
      directory: dailyDirectory,
      titlePattern: normalizeDailyNoteTitlePattern(settings?.dailyNotes?.titlePattern),
      locale: normalizeDailyNoteLocale(settings?.dailyNotes?.locale),
      legacyPatterns: normalizeDailyNotePatternHistory(
        settings?.dailyNotes?.legacyPatterns,
        primaryNotesLocation
      ),
      templateId: normalizeTemplateId(settings?.dailyNotes?.templateId),
      // Defaults: derive due dates ON, roll tasks over OFF. Absent (undefined)
      // means "use the default", so only an explicit `false`/`true` overrides.
      tasksDueOnNoteDate: settings?.dailyNotes?.tasksDueOnNoteDate !== false,
      rolloverUnfinishedTasks: settings?.dailyNotes?.rolloverUnfinishedTasks === true
    },
    weeklyNotes: {
      enabled: !!settings?.weeklyNotes?.enabled,
      directory: weeklyDirectory,
      titlePattern: normalizeWeeklyNoteTitlePattern(settings?.weeklyNotes?.titlePattern),
      locale: normalizeWeeklyNoteLocale(settings?.weeklyNotes?.locale),
      legacyPatterns: normalizeWeeklyNotePatternHistory(
        settings?.weeklyNotes?.legacyPatterns,
        primaryNotesLocation
      ),
      templateId: normalizeTemplateId(settings?.weeklyNotes?.templateId)
    },
    folderIcons: normalizedFolderIcons,
    folderColors: normalizedFolderColors,
    favorites: normalizedFavorites
  }
}

export function folderIconKey(folder: NoteFolder, subpath: string): string {
  return `${folder}:${subpath}`
}

/**
 * Favorites store either a note's vault-relative path (e.g. `inbox/Idea.md`) or a
 * folder key `folder:subpath`. Folder keys always contain a `:`; note paths never
 * do, so the colon discriminates the two.
 */
export function favoriteFolderKey(folder: NoteFolder, subpath: string): string {
  return folderIconKey(folder, subpath)
}

export function isFavoriteFolderKey(key: string): boolean {
  return key.includes(':')
}

/** Parse a folder favorite key back into its `{ folder, subpath }` parts. */
export function parseFavoriteFolderKey(
  key: string
): { folder: NoteFolder; subpath: string } | null {
  const idx = key.indexOf(':')
  if (idx === -1) return null
  const folder = key.slice(0, idx) as NoteFolder
  return { folder, subpath: key.slice(idx + 1) }
}

/** Toggle a favorite key, returning the next list (added at the end, or removed). */
export function toggleFavorite(favorites: string[], key: string): string[] {
  return favorites.includes(key)
    ? favorites.filter((f) => f !== key)
    : [...favorites, key]
}

/** Rewrite a note favorite when its path changes (rename or move). */
export function rewriteFavoriteNotePath(
  favorites: string[],
  oldPath: string,
  newPath: string
): string[] {
  if (oldPath === newPath || !favorites.includes(oldPath)) return favorites
  return favorites.map((f) => (f === oldPath ? newPath : f))
}

/**
 * Rewrite favorites after a folder rename/move: the folder's own key plus every
 * note favorite whose path lived under that folder are repointed at the new
 * location. `oldRelPrefix`/`newRelPrefix` are the vault-relative folder paths
 * (with trailing slash) used to rewrite note paths.
 */
export function rewriteFavoritesForFolderRename(
  favorites: string[],
  folder: NoteFolder,
  oldSubpath: string,
  newSubpath: string,
  oldRelPrefix: string,
  newRelPrefix: string
): string[] {
  const exactKey = favoriteFolderKey(folder, oldSubpath)
  const keyPrefix = `${exactKey}/`
  const newExactKey = favoriteFolderKey(folder, newSubpath)
  return favorites.map((f) => {
    if (f === exactKey) return newExactKey
    if (f.startsWith(keyPrefix)) {
      return favoriteFolderKey(folder, newSubpath + f.slice(exactKey.length))
    }
    if (oldRelPrefix && f.startsWith(oldRelPrefix)) {
      return newRelPrefix + f.slice(oldRelPrefix.length)
    }
    return f
  })
}

/** Remove a single favorite key (note path or folder key) if present. */
export function removeFavorite(favorites: string[], key: string): string[] {
  return favorites.includes(key) ? favorites.filter((f) => f !== key) : favorites
}

/**
 * Remove favorites for a deleted folder: its own key, any descendant folder
 * keys, and any note favorites whose path lived under it (`relPrefix` is the
 * vault-relative folder path with trailing slash).
 */
export function removeFavoritesForFolder(
  favorites: string[],
  folder: NoteFolder,
  subpath: string,
  relPrefix: string
): string[] {
  const exactKey = favoriteFolderKey(folder, subpath)
  const keyPrefix = `${exactKey}/`
  return favorites.filter(
    (f) =>
      f !== exactKey &&
      !f.startsWith(keyPrefix) &&
      !(relPrefix && f.startsWith(relPrefix))
  )
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

// Folder color maps share the exact key scheme as folder icons (`folder:subpath`),
// so renames/deletes/duplicates rewrite them identically. Generic helpers keep
// the two in lock-step without duplicating the traversal logic.
function rewriteFolderKeyMap<T>(
  map: Record<string, T>,
  folder: NoteFolder,
  oldSubpath: string,
  newSubpath: string
): Record<string, T> {
  const next: Record<string, T> = {}
  const exactKey = folderIconKey(folder, oldSubpath)
  const prefix = `${exactKey}/`
  for (const [key, value] of Object.entries(map)) {
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

function removeFolderKeyMap<T>(
  map: Record<string, T>,
  folder: NoteFolder,
  subpath: string
): Record<string, T> {
  const next: Record<string, T> = {}
  const exactKey = folderIconKey(folder, subpath)
  const prefix = `${exactKey}/`
  for (const [key, value] of Object.entries(map)) {
    if (key === exactKey || key.startsWith(prefix)) continue
    next[key] = value
  }
  return next
}

function duplicateFolderKeyMap<T>(
  map: Record<string, T>,
  folder: NoteFolder,
  sourceSubpath: string,
  targetSubpath: string
): Record<string, T> {
  const next: Record<string, T> = { ...map }
  const exactKey = folderIconKey(folder, sourceSubpath)
  const prefix = `${exactKey}/`
  for (const [key, value] of Object.entries(map)) {
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

export function rewriteFolderColorsForRename(
  folderColors: Record<string, FolderColorId>,
  folder: NoteFolder,
  oldSubpath: string,
  newSubpath: string
): Record<string, FolderColorId> {
  return rewriteFolderKeyMap(folderColors, folder, oldSubpath, newSubpath)
}

export function removeFolderColors(
  folderColors: Record<string, FolderColorId>,
  folder: NoteFolder,
  subpath: string
): Record<string, FolderColorId> {
  return removeFolderKeyMap(folderColors, folder, subpath)
}

export function duplicateFolderColors(
  folderColors: Record<string, FolderColorId>,
  folder: NoteFolder,
  sourceSubpath: string,
  targetSubpath: string
): Record<string, FolderColorId> {
  return duplicateFolderKeyMap(folderColors, folder, sourceSubpath, targetSubpath)
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
  // Case-insensitive so a note under a capitalized on-disk system folder
  // (e.g. `Inbox/`) lands in the same subpath as its sibling assets, which use
  // the same lenient stripping. Mirrors `assetPathWithinFolder`. (#186)
  return path.toLowerCase().startsWith(prefix) ? path.slice(prefix.length) : path
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

export interface DailyNoteLocation {
  title: string
  subpath: string
}

export function dailyNoteLocationForDate(
  date = new Date(),
  settings: VaultSettings | null | undefined
): DailyNoteLocation {
  const normalized = normalizeVaultSettings(settings)
  return dailyNoteLocationForPattern(date, normalized, currentDailyNotePattern(normalized))
}

export function weeklyNoteTitle(date = new Date()): string {
  return `${getISOWeekYear(date)}-W${pad(getISOWeek(date))}`
}

export interface WeeklyNoteLocation {
  title: string
  subpath: string
}

export function weeklyNoteLocationForDate(
  date = new Date(),
  settings: VaultSettings | null | undefined
): WeeklyNoteLocation {
  const normalized = normalizeVaultSettings(settings)
  return weeklyNoteLocationForPattern(date, normalized, currentWeeklyNotePattern(normalized))
}

export interface DateNoteInfo {
  kind: 'daily' | 'weekly'
  /** Daily: that calendar day. Weekly: the Monday of that ISO week. */
  date: Date
}

function currentDailyNotePattern(settings: VaultSettings): DateNotePatternSettings {
  return {
    directory: settings.dailyNotes.directory,
    titlePattern: settings.dailyNotes.titlePattern ?? DEFAULT_DAILY_NOTE_TITLE_PATTERN,
    locale: settings.dailyNotes.locale ?? DEFAULT_DAILY_NOTE_LOCALE
  }
}

function currentWeeklyNotePattern(settings: VaultSettings): DateNotePatternSettings {
  return {
    directory: settings.weeklyNotes.directory,
    titlePattern: settings.weeklyNotes.titlePattern ?? DEFAULT_WEEKLY_NOTE_TITLE_PATTERN,
    locale: settings.weeklyNotes.locale ?? DEFAULT_WEEKLY_NOTE_LOCALE
  }
}

function dailyNotePatterns(settings: VaultSettings): DateNotePatternSettings[] {
  const current = currentDailyNotePattern(settings)
  const seen = new Set([dateNotePatternKey(current)])
  const out = [current]
  for (const pattern of settings.dailyNotes.legacyPatterns ?? []) {
    const key = dateNotePatternKey(pattern)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(pattern)
  }
  return out
}

function weeklyNotePatterns(settings: VaultSettings): DateNotePatternSettings[] {
  const current = currentWeeklyNotePattern(settings)
  const seen = new Set([dateNotePatternKey(current)])
  const out = [current]
  for (const pattern of settings.weeklyNotes.legacyPatterns ?? []) {
    const key = dateNotePatternKey(pattern)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(pattern)
  }
  return out
}

function dailyNoteLocationForPattern(
  date: Date,
  settings: VaultSettings,
  pattern: DateNotePatternSettings
): DailyNoteLocation {
  const locale = pattern.locale ?? DEFAULT_DAILY_NOTE_LOCALE
  const subpath = normalizePrimaryRelativeSubpath(
    normalizeDailyNotesDirectory(formatDirectoryPattern(date, pattern.directory, locale)),
    settings
  )
  const title = normalizeDailyNoteTitlePattern(
    formatDateNotePattern(
      date,
      pattern.titlePattern ?? DEFAULT_DAILY_NOTE_TITLE_PATTERN,
      locale
    )
  )
  return { title, subpath }
}

function weeklyNoteLocationForPattern(
  date: Date,
  settings: VaultSettings,
  pattern: DateNotePatternSettings
): WeeklyNoteLocation {
  const weekYear = getISOWeekYear(date)
  const week = getISOWeek(date)
  const monday = mondayOfISOWeek(weekYear, week)
  const locale = pattern.locale ?? DEFAULT_WEEKLY_NOTE_LOCALE
  const patternParts = { year: weekYear, week }
  const subpath = normalizePrimaryRelativeSubpath(
    normalizeWeeklyNotesDirectory(
      formatDirectoryPattern(monday, pattern.directory, locale, patternParts)
    ),
    settings
  )
  const title = normalizeWeeklyNoteTitlePattern(
    formatDateNotePattern(
      monday,
      pattern.titlePattern ?? DEFAULT_WEEKLY_NOTE_TITLE_PATTERN,
      locale,
      patternParts
    )
  )
  return { title, subpath }
}

/**
 * Numerics a note's directory + title expose, used only to bound the set of
 * candidate dates we round-trip. Tokens we cannot reverse cheaply (localized
 * month/weekday names) contribute nothing here — the round-trip below verifies
 * them instead, so the locale never has to be parsed backwards.
 */
function patternNumerics(
  pattern: DateNotePatternSettings,
  subpath: string,
  title: string,
  defaultTitlePattern: string
): DateNotePatternMatch | null {
  const directoryMatch = matchDirectoryPattern(pattern.directory, subpath)
  const titleMatch = matchDateNotePattern(pattern.titlePattern ?? defaultTitlePattern, title)
  if (!directoryMatch || !titleMatch) return null
  const merged: DateNotePatternMatch = {}
  if (!mergePatternMatch(merged, directoryMatch) || !mergePatternMatch(merged, titleMatch)) {
    return null
  }
  return merged
}

/**
 * Every calendar day consistent with the extracted numerics. A day-of-month
 * pins it to one date; otherwise we enumerate the relevant month(s)/week and
 * let the round-trip pick the match — so a title built from ISO week + weekday
 * (no day-of-month) still resolves to its day.
 */
function dailyCandidateDates(n: DateNotePatternMatch): Date[] {
  if (n.year === undefined) return []
  if (n.month !== undefined && n.day !== undefined) {
    const date = new Date(n.year, n.month - 1, n.day)
    const valid =
      date.getFullYear() === n.year &&
      date.getMonth() === n.month - 1 &&
      date.getDate() === n.day
    return valid ? [date] : []
  }
  const firstMonth = n.month !== undefined ? n.month - 1 : 0
  const lastMonth = n.month !== undefined ? n.month - 1 : 11
  const out: Date[] = []
  for (let month = firstMonth; month <= lastMonth; month++) {
    const daysInMonth = new Date(n.year, month + 1, 0).getDate()
    for (let day = 1; day <= daysInMonth; day++) {
      if (n.day !== undefined && day !== n.day) continue
      const date = new Date(n.year, month, day)
      if (n.week !== undefined && getISOWeek(date) !== n.week) continue
      out.push(date)
    }
  }
  return out
}

/** Mondays of every ISO week consistent with the extracted numerics. */
function weeklyCandidateMondays(n: DateNotePatternMatch): Date[] {
  if (n.year === undefined) return []
  if (n.week !== undefined) {
    const monday = mondayOfISOWeek(n.year, n.week)
    return getISOWeekYear(monday) === n.year ? [monday] : []
  }
  const out: Date[] = []
  for (let week = 1; week <= 53; week++) {
    const monday = mondayOfISOWeek(n.year, week)
    if (getISOWeekYear(monday) !== n.year) continue
    out.push(monday)
  }
  return out
}

function matchDailyPattern(
  subpath: string,
  title: string,
  settings: VaultSettings,
  pattern: DateNotePatternSettings
): Date | null {
  const numerics = patternNumerics(pattern, subpath, title, DEFAULT_DAILY_NOTE_TITLE_PATTERN)
  if (!numerics) return null
  for (const candidate of dailyCandidateDates(numerics)) {
    const expected = dailyNoteLocationForPattern(candidate, settings, pattern)
    if (expected.subpath === subpath && expected.title === title) return candidate
  }
  return null
}

function matchWeeklyPattern(
  subpath: string,
  title: string,
  settings: VaultSettings,
  pattern: DateNotePatternSettings
): Date | null {
  const numerics = patternNumerics(pattern, subpath, title, DEFAULT_WEEKLY_NOTE_TITLE_PATTERN)
  if (!numerics) return null
  for (const candidate of weeklyCandidateMondays(numerics)) {
    const expected = weeklyNoteLocationForPattern(candidate, settings, pattern)
    if (expected.subpath === subpath && expected.title === title) return candidate
  }
  return null
}

/**
 * Classify a note as a daily or weekly note, or `null` if it is neither.
 * A note qualifies only when re-formatting its recovered date with the
 * configured directory/title pattern reproduces this exact path — so a stray
 * note titled `2026-06-08` outside the daily folder is not treated as one, and
 * a note is recognized regardless of which tokens its title uses to encode the
 * day (day-of-month, or ISO week + weekday).
 */
export function classifyDateNote(
  note: Pick<NoteMeta, 'folder' | 'path' | 'title'>,
  settings: VaultSettings | null | undefined
): DateNoteInfo | null {
  const normalized = normalizeVaultSettings(settings)
  if (note.folder !== 'inbox') return null

  const subpath = noteFolderSubpath(note, normalized)

  if (normalized.dailyNotes.enabled) {
    for (const pattern of dailyNotePatterns(normalized)) {
      const date = matchDailyPattern(subpath, note.title, normalized, pattern)
      if (date) return { kind: 'daily', date }
    }
  }

  if (normalized.weeklyNotes.enabled) {
    for (const pattern of weeklyNotePatterns(normalized)) {
      const date = matchWeeklyPattern(subpath, note.title, normalized, pattern)
      if (date) return { kind: 'weekly', date }
    }
  }

  return null
}

export interface DateNoteIndexes {
  dailyByDate: Map<string, NoteMeta>
  weeklyByWeek: Map<string, NoteMeta>
}

export function buildDateNoteIndexes(
  notes: readonly NoteMeta[],
  settings: VaultSettings | null | undefined
): DateNoteIndexes {
  const dailyByDate = new Map<string, NoteMeta>()
  const weeklyByWeek = new Map<string, NoteMeta>()

  for (const note of notes) {
    const info = classifyDateNote(note, settings)
    if (!info) continue
    if (info.kind === 'daily') dailyByDate.set(noteTitleForDate(info.date), note)
    else weeklyByWeek.set(weeklyNoteTitle(info.date), note)
  }

  return { dailyByDate, weeklyByWeek }
}

/**
 * Map every daily note to its own date as `vault-relative path -> YYYY-MM-DD`
 * (the same encoding a `due:` token uses). Returns an empty map when daily
 * notes are disabled or `dailyNotes.tasksDueOnNoteDate` is off, so callers can
 * feed the result straight to `inferDailyTaskDueDates` without re-checking the
 * setting. Weekly notes are intentionally excluded — a week has no single day.
 */
export function buildDailyNoteDateByPath(
  notes: readonly NoteMeta[],
  settings: VaultSettings | null | undefined
): Map<string, string> {
  const out = new Map<string, string>()
  const normalized = normalizeVaultSettings(settings)
  if (!normalized.dailyNotes.enabled || !normalized.dailyNotes.tasksDueOnNoteDate) return out
  for (const note of notes) {
    const info = classifyDateNote(note, normalized)
    if (info?.kind === 'daily') out.set(note.path, noteTitleForDate(info.date))
  }
  return out
}

export function dateNoteFolderMayBelongToDatePattern(
  subpath: string,
  settings: VaultSettings | null | undefined
): boolean {
  const normalized = normalizeVaultSettings(settings)
  if (normalized.dailyNotes.enabled) {
    for (const pattern of dailyNotePatterns(normalized)) {
      if (matchDirectoryPattern(pattern.directory, subpath)) return true
    }
  }
  if (normalized.weeklyNotes.enabled) {
    for (const pattern of weeklyNotePatterns(normalized)) {
      if (matchDirectoryPattern(pattern.directory, subpath)) return true
    }
  }
  return false
}

export function findDailyNoteForDate(
  notes: readonly NoteMeta[],
  settings: VaultSettings | null | undefined,
  date: Date
): NoteMeta | null {
  const expected = dailyNoteLocationForDate(date, settings)
  const normalized = normalizeVaultSettings(settings)
  const dateKey = noteTitleForDate(date)
  return (
    notes.find(
      (note) =>
        note.folder === 'inbox' &&
        note.title === expected.title &&
        noteFolderSubpath(note, normalized) === expected.subpath &&
        classifyDateNote(note, normalized)?.kind === 'daily'
    ) ??
    notes.find((note) => {
      const info = classifyDateNote(note, normalized)
      return info?.kind === 'daily' && noteTitleForDate(info.date) === dateKey
    }) ??
    null
  )
}

export function findWeeklyNoteForDate(
  notes: readonly NoteMeta[],
  settings: VaultSettings | null | undefined,
  date: Date
): NoteMeta | null {
  const expected = weeklyNoteLocationForDate(date, settings)
  const normalized = normalizeVaultSettings(settings)
  const weekKey = weeklyNoteTitle(date)
  return (
    notes.find(
      (note) =>
        note.folder === 'inbox' &&
        note.title === expected.title &&
        noteFolderSubpath(note, normalized) === expected.subpath &&
        classifyDateNote(note, normalized)?.kind === 'weekly'
    ) ??
    notes.find((note) => {
      const info = classifyDateNote(note, normalized)
      return info?.kind === 'weekly' && weeklyNoteTitle(info.date) === weekKey
    }) ??
    null
  )
}

export function findDateNoteByTitle(
  notes: readonly NoteMeta[],
  settings: VaultSettings | null | undefined,
  kind: DateNoteInfo['kind'],
  title: string
): NoteMeta | null {
  for (const note of notes) {
    if (note.title !== title) continue
    const info = classifyDateNote(note, settings)
    if (info?.kind === kind) return note
  }
  return null
}

// Match a path's top segment to a system folder case-insensitively. On
// case-insensitive filesystems (macOS/Windows) the inbox folder can be stored
// with different casing than the canonical lowercase the rest of the app emits:
// `listNotes` builds note paths from `folderRoot()` (always `inbox/…`), but
// `listAssets`/the watcher walk real directory entries and preserve the on-disk
// case (e.g. `Inbox/…`). Comparing case-sensitively dropped those assets to
// `null`, so a capitalized `Inbox/` showed its notes but hid its images/PDFs. (#186)
function systemFolderForTopSegment(top: string): NoteFolder | null {
  const lower = top.toLowerCase()
  return SYSTEM_FOLDERS.has(lower as NoteFolder) ? (lower as NoteFolder) : null
}

export function folderForVaultRelativePath(
  relPath: string,
  settings: VaultSettings | null | undefined
): NoteFolder | null {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  const top = normalized.split('/')[0] ?? ''
  if (!top || top.startsWith('.')) return null
  const system = systemFolderForTopSegment(top)
  if (system) return system
  if (isPrimaryNotesAtRoot(settings) && !RESERVED_ROOT_NAMES.has(top.toLowerCase())) return 'inbox'
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
  // Strip the system-folder prefix case-insensitively so a capitalized on-disk
  // folder (e.g. `Inbox/`) lands in the same subpath tree as its notes. (#186)
  return normalized.toLowerCase().startsWith(prefix)
    ? normalized.slice(prefix.length)
    : normalized
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
