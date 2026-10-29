/**
 * The Gallery: one folder's notes as a grid of cards, each led by the note's
 * cover. Asked for by charles b. once covers shipped (2.78.0): "a gallery
 * view of all notes in a folder by cover thumbnail".
 *
 * Everything here is pure, so the view is a thin shell over it: which notes a
 * gallery holds, their order, the title filter, the grid's geometry and
 * cursor moves, and which picture a card draws for a cover. The covers
 * themselves come from reading the notes on screen (gallery-covers.ts); the
 * vault index carries no cover, on purpose, so the desktop scan, the Go
 * server and the phones' vault code stay as they are.
 *
 * A gallery is a tab like the Unresolved Links view, keyed by its folder:
 * `zen://gallery/<folder>/<encoded subpath>`, so two folders open as two
 * tabs and a workspace restore brings each one back.
 */
import type { FolderEntry, NoteFolder, NoteMeta, VaultSettings } from '@shared/ipc'
import type { NoteCover } from '@shared/note-cover'
import { isFormDirName } from '@shared/databases'
import { isExcalidrawPath, isObsidianExcalidrawPath } from '@shared/excalidraw'
import { builtinGradientForAsset, gradientCoverDataUrl } from '@shared/note-cover-gradients'
import { isUnsplashImageUrl } from '@shared/unsplash'
import { naturalCompare } from './natural-sort'
import {
  folderForVaultRelativePath,
  noteFolderSubpath,
  notePathWithinFolder,
  vaultRelativeFolderPath
} from './vault-layout'

/* ------------------------------------------------------------------------ */
/* The tab                                                                  */
/* ------------------------------------------------------------------------ */

export interface GalleryFolder {
  folder: NoteFolder
  /** POSIX path inside the top-level folder, "" for the folder itself. */
  subpath: string
}

const GALLERY_TAB_PREFIX = 'zen://gallery/'
const NOTE_FOLDERS: readonly NoteFolder[] = ['inbox', 'quick', 'archive', 'trash']

function cleanSubpath(subpath: string): string {
  return (subpath ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

export function galleryTabPath(folder: NoteFolder, subpath: string): string {
  return `${GALLERY_TAB_PREFIX}${folder}/${encodeURIComponent(cleanSubpath(subpath))}`
}

export function isGalleryTabPath(path: string | null | undefined): boolean {
  return typeof path === 'string' && path.startsWith(GALLERY_TAB_PREFIX)
}

export function galleryFolderFromTabPath(path: string | null | undefined): GalleryFolder | null {
  if (!path || !isGalleryTabPath(path)) return null
  const rest = path.slice(GALLERY_TAB_PREFIX.length)
  const slash = rest.indexOf('/')
  const folder = (slash < 0 ? rest : rest.slice(0, slash)) as NoteFolder
  if (!NOTE_FOLDERS.includes(folder)) return null
  const encoded = slash < 0 ? '' : rest.slice(slash + 1)
  let subpath = encoded
  try {
    subpath = decodeURIComponent(encoded)
  } catch {
    // Keep the text as written.
  }
  return { folder, subpath: cleanSubpath(subpath) }
}

/** The folder's own name: its last segment, or the system folder's label at
 *  the top of one. */
export function galleryFolderName(
  target: GalleryFolder,
  labels: Record<NoteFolder, string>
): string {
  if (!target.subpath) return labels[target.folder]
  return target.subpath.slice(target.subpath.lastIndexOf('/') + 1)
}

/**
 * Where a gallery tab goes when its folder is renamed, moved or deleted:
 * `rewriteFile` is the workspace's own rewrite for paths under the changed
 * folder (a vault-relative `dir/` in, the new one or null out). A top-level
 * folder never moves, and a gallery of a folder that is gone closes.
 */
export function rewriteGalleryTabPath(
  path: string,
  rewriteFile: (path: string) => string | null,
  settings: VaultSettings | null | undefined
): string | null {
  const target = galleryFolderFromTabPath(path)
  if (!target || !target.subpath) return path
  const dir = `${vaultRelativeFolderPath(target.folder, target.subpath, settings)}/`
  const mapped = rewriteFile(dir)
  if (mapped === null) return null
  if (mapped === dir) return path
  const nextDir = mapped.replace(/\/+$/, '')
  const folder = folderForVaultRelativePath(nextDir, settings) ?? target.folder
  // The path inside the folder, read through a stand-in file name so the
  // folder's own directory (remapped or not, root-mode or not) comes off the
  // same way it does for a note.
  const within = notePathWithinFolder(`${nextDir}/_`, folder, settings)
  return galleryTabPath(folder, within.slice(0, -2))
}

/* ------------------------------------------------------------------------ */
/* Which notes, in which order                                              */
/* ------------------------------------------------------------------------ */

export type GallerySort = 'updated' | 'created' | 'title'

export const GALLERY_SORTS: readonly GallerySort[] = ['updated', 'created', 'title']

export const GALLERY_SORT_LABELS: Record<GallerySort, string> = {
  updated: 'Updated',
  created: 'Created',
  title: 'Title'
}

export function normalizeGallerySort(value: unknown): GallerySort {
  return value === 'created' || value === 'title' ? value : 'updated'
}

/** A drawing is a canvas, not a note with a cover. */
function isDrawing(path: string): boolean {
  return isExcalidrawPath(path) || isObsidianExcalidrawPath(path)
}

/**
 * The notes a gallery of `target` holds: the folder's own notes, and with
 * `includeSubfolders` every note below it too. A database's record pages
 * (`<Name>.base/` under the folder) are rows of that database, not the
 * folder's notes, so they stay out either way.
 */
export function galleryNotesIn<T extends Pick<NoteMeta, 'path' | 'folder'>>(
  notes: readonly T[],
  target: GalleryFolder,
  includeSubfolders: boolean,
  settings: VaultSettings | null | undefined
): T[] {
  const base = cleanSubpath(target.subpath)
  const out: T[] = []
  for (const note of notes) {
    if (note.folder !== target.folder || isDrawing(note.path)) continue
    const sub = noteFolderSubpath(note, settings)
    if (sub === base) {
      out.push(note)
      continue
    }
    if (!includeSubfolders) continue
    if (base && !sub.startsWith(`${base}/`)) continue
    const below = base ? sub.slice(base.length + 1) : sub
    if (below.split('/').some((segment) => isFormDirName(segment))) continue
    out.push(note)
  }
  return out
}

/** Newest first for the two dates, A to Z for the title; ties fall back to
 *  the title, then the path, so the order never shuffles between renders. */
export function sortGalleryNotes<T extends Pick<NoteMeta, 'path' | 'title' | 'createdAt' | 'updatedAt'>>(
  notes: readonly T[],
  sort: GallerySort
): T[] {
  const byTitle = (a: T, b: T): number =>
    naturalCompare(a.title, b.title) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  return [...notes].sort((a, b) => {
    if (sort === 'updated') return b.updatedAt - a.updatedAt || byTitle(a, b)
    if (sort === 'created') return b.createdAt - a.createdAt || byTitle(a, b)
    return byTitle(a, b)
  })
}

/** Keeps the notes whose title holds every word of the query, in any case. */
export function filterGalleryNotes<T extends Pick<NoteMeta, 'title'>>(
  notes: readonly T[],
  query: string
): T[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...notes]
  return notes.filter((note) => {
    const title = note.title.toLowerCase()
    return words.every((word) => title.includes(word))
  })
}

/** The date a card shows: when it was made under the Created sort, when it
 *  last changed otherwise. */
export function galleryCardTimestamp(
  note: Pick<NoteMeta, 'createdAt' | 'updatedAt'>,
  sort: GallerySort
): number {
  return sort === 'created' ? note.createdAt : note.updatedAt
}

/** "Oct 28", with the year only when it is not this year's. */
export function formatGalleryDate(ms: number, now: number = Date.now()): string {
  const date = new Date(ms)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric'
  })
}

/** The letter a card without a cover shows: the title's first letter or
 *  digit (an emoji or a bracket in front is skipped), upper-cased. */
export function galleryInitial(title: string): string {
  const letter = title.match(/[\p{L}\p{N}]/u)?.[0] ?? Array.from(title.trim())[0] ?? '?'
  return letter.toLocaleUpperCase()
}

/* ------------------------------------------------------------------------ */
/* Opening one                                                              */
/* ------------------------------------------------------------------------ */

/** The folder a note sits in, as a gallery names it. */
export function galleryFolderOfNote(
  note: Pick<NoteMeta, 'path' | 'folder'>,
  settings: VaultSettings | null | undefined
): GalleryFolder {
  return { folder: note.folder, subpath: noteFolderSubpath(note, settings) }
}

/**
 * The folder `:gallery <path>` names. In order: a vault-relative directory
 * (`inbox/Projects`, `archive/2025`, or `Projects` in a root-mode vault), a
 * folder inside the main notes area as `:newtask` takes it (`Projects`), or a
 * system folder by its key or its label (`archive`, `Quick Notes`). Case does
 * not matter. Null when nothing in the vault answers.
 */
export function resolveGalleryFolderArgument(
  arg: string,
  folders: readonly Pick<FolderEntry, 'folder' | 'subpath'>[],
  settings: VaultSettings | null | undefined,
  labels: Record<NoteFolder, string>
): GalleryFolder | null {
  const wanted = arg
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.?\/+|\/+$/g, '')
    .toLowerCase()
  if (!wanted) return null
  const candidates: GalleryFolder[] = NOTE_FOLDERS.map((folder) => ({ folder, subpath: '' }))
  for (const entry of folders) {
    const subpath = cleanSubpath(entry.subpath)
    if (subpath) candidates.push({ folder: entry.folder, subpath })
  }
  const byDirectory = candidates.find(
    (c) => vaultRelativeFolderPath(c.folder, c.subpath, settings).toLowerCase() === wanted
  )
  if (byDirectory) return byDirectory
  const inNotes = candidates.find((c) => c.folder === 'inbox' && c.subpath.toLowerCase() === wanted)
  if (inNotes) return inNotes
  const system = NOTE_FOLDERS.find(
    (folder) => folder === wanted || labels[folder].toLowerCase() === wanted
  )
  return system ? { folder: system, subpath: '' } : null
}

/** True while the vault still has the folder; a top-level one always does. */
export function galleryFolderExists(
  target: GalleryFolder,
  folders: readonly Pick<FolderEntry, 'folder' | 'subpath'>[]
): boolean {
  if (!target.subpath) return true
  return folders.some(
    (entry) => entry.folder === target.folder && cleanSubpath(entry.subpath) === target.subpath
  )
}

/* ------------------------------------------------------------------------ */
/* The grid                                                                 */
/* ------------------------------------------------------------------------ */

/** A card is never narrower than this while a third column could fit. */
const MIN_CARD_WIDTH = 200
export const GALLERY_MIN_COLUMNS = 2
export const GALLERY_MAX_COLUMNS = 8
/** The cover's height over its width: a wide frame, like the note's own. */
const COVER_RATIO = 0.56
/** The title and date under the cover: two lines and their padding. */
export const GALLERY_CARD_TEXT_HEIGHT = 56
/** Below this width the grid tightens its margins (a phone, a narrow split). */
const NARROW_WIDTH = 640

export interface GalleryGeometry {
  columns: number
  /** Space around the grid, inside the scroller. */
  padding: number
  /** Space between cards, both ways. */
  gap: number
  cardWidth: number
  coverHeight: number
  cardHeight: number
  /** A card row and the gap under it. */
  rowHeight: number
}

/**
 * The grid for a scroller `width` pixels wide. Columns fill the width at no
 * less than MIN_CARD_WIDTH each, never fewer than two (a phone shows two
 * small cards a row rather than one huge one) and never more than eight.
 * Every card has the same height, which is what lets the view mount only
 * the rows on screen.
 */
export function galleryGeometry(width: number): GalleryGeometry {
  const narrow = width < NARROW_WIDTH
  const padding = narrow ? 12 : 24
  const gap = narrow ? 12 : 16
  const inner = Math.max(0, width - padding * 2)
  const fit = Math.floor((inner + gap) / (MIN_CARD_WIDTH + gap))
  const columns = Math.min(GALLERY_MAX_COLUMNS, Math.max(GALLERY_MIN_COLUMNS, fit))
  const cardWidth = Math.max(0, (inner - gap * (columns - 1)) / columns)
  const coverHeight = Math.round(cardWidth * COVER_RATIO)
  const cardHeight = coverHeight + GALLERY_CARD_TEXT_HEIGHT
  return { columns, padding, gap, cardWidth, coverHeight, cardHeight, rowHeight: cardHeight + gap }
}

/** The grid's full height in the scroller: every row, without a gap under
 *  the last one, inside the padding. */
export function galleryContentHeight(count: number, geometry: GalleryGeometry): number {
  const rows = Math.ceil(Math.max(0, count) / geometry.columns)
  if (rows === 0) return 0
  return geometry.padding * 2 + rows * geometry.rowHeight - geometry.gap
}

export interface GalleryRowRange {
  /** First row to mount. */
  start: number
  /** One past the last row to mount. */
  end: number
}

/** The rows a scroller shows at `scrollTop`, plus `overscan` rows each side. */
export function galleryRowRange(
  count: number,
  geometry: GalleryGeometry,
  scrollTop: number,
  viewportHeight: number,
  overscan: number
): GalleryRowRange {
  const rows = Math.ceil(Math.max(0, count) / geometry.columns)
  if (rows === 0) return { start: 0, end: 0 }
  const top = Math.max(0, scrollTop - geometry.padding)
  const first = Math.min(rows - 1, Math.floor(top / geometry.rowHeight))
  const last = Math.min(
    rows - 1,
    Math.floor((top + Math.max(0, viewportHeight)) / geometry.rowHeight)
  )
  return {
    start: Math.max(0, first - overscan),
    end: Math.min(rows, last + 1 + overscan)
  }
}

/** The scroll position that shows card `index` whole, moving as little as it
 *  can: unchanged when the card is in view already. */
export function galleryScrollTopFor(
  index: number,
  geometry: GalleryGeometry,
  scrollTop: number,
  viewportHeight: number
): number {
  const row = Math.floor(Math.max(0, index) / geometry.columns)
  const cardTop = geometry.padding + row * geometry.rowHeight
  const cardBottom = cardTop + geometry.cardHeight
  if (cardTop - geometry.padding < scrollTop) return Math.max(0, cardTop - geometry.padding)
  if (cardBottom + geometry.padding > scrollTop + viewportHeight) {
    return Math.max(0, cardBottom + geometry.padding - viewportHeight)
  }
  return scrollTop
}

export type GalleryMove = 'left' | 'right' | 'up' | 'down' | 'first' | 'last'

/**
 * Where the cursor goes. Left and right walk the cards in reading order, so
 * they cross rows; up and down keep the column. Down from a column the short
 * last row does not reach lands on the last card, so a downward walk always
 * gets to the end; any other move past an edge stays put.
 */
export function stepGalleryCursor(
  index: number,
  count: number,
  columns: number,
  move: GalleryMove
): number {
  if (count <= 0) return -1
  const cols = Math.max(1, Math.floor(columns))
  const at = Math.min(count - 1, Math.max(0, index))
  switch (move) {
    case 'first':
      return 0
    case 'last':
      return count - 1
    case 'left':
      return Math.max(0, at - 1)
    case 'right':
      return Math.min(count - 1, at + 1)
    case 'up':
      return at - cols >= 0 ? at - cols : at
    case 'down': {
      if (at + cols < count) return at + cols
      const lastRowStart = Math.floor((count - 1) / cols) * cols
      return at < lastRowStart ? count - 1 : at
    }
  }
}

/* ------------------------------------------------------------------------ */
/* A card's picture                                                         */
/* ------------------------------------------------------------------------ */

/** Wide enough for the widest card on a 2x screen; the full cover asks
 *  Unsplash for 2400 pixels. */
export const GALLERY_UNSPLASH_WIDTH = 800

/**
 * An Unsplash cover at thumbnail width. Unsplash serves any size of a photo
 * from its imgix parameters, and its terms want the photo hotlinked, never
 * copied, so a smaller `w` is the thumbnail. The rest of the URL (its
 * `ixid` among them) stays byte for byte what the note holds. Any other URL
 * comes back as it was.
 */
export function unsplashThumbnailUrl(url: string, width: number = GALLERY_UNSPLASH_WIDTH): string {
  if (!isUnsplashImageUrl(url)) return url
  const base = url.replace(/#.*$/, '')
  const w = Math.max(1, Math.round(width))
  if (/[?&]w=\d+/.test(base)) return base.replace(/([?&])w=\d+/, `$1w=${w}`)
  return `${base}${base.includes('?') ? '&' : '?'}w=${w}`
}

export type GalleryThumbnailSource = 'vault' | 'gradient' | 'unsplash' | 'web'

export type GalleryThumbnail =
  | {
      kind: 'image'
      url: string
      /** Vertical focal point, 0 (top) to 1 (bottom): the note's `banner_y`. */
      y: number
      source: GalleryThumbnailSource
    }
  | { kind: 'placeholder' }

/**
 * What a card draws for a note's cover. A vault image is the file itself
 * (served by the host, so a remote vault and the web app work the same); a
 * built-in gradient whose file the vault cannot hand over yet draws from its
 * own SVG; an Unsplash photo comes at thumbnail width; any other https cover
 * as it is. No cover, or an image this device cannot find, is the quiet
 * placeholder: a card is not where a broken cover gets fixed.
 */
export function galleryThumbnail(
  cover: NoteCover | null,
  resolveVault: (href: string) => string | null
): GalleryThumbnail {
  if (!cover) return { kind: 'placeholder' }
  if (cover.target.kind === 'url') {
    const unsplash = isUnsplashImageUrl(cover.target.url)
    return {
      kind: 'image',
      url: unsplash ? unsplashThumbnailUrl(cover.target.url) : cover.target.url,
      y: cover.y,
      source: unsplash ? 'unsplash' : 'web'
    }
  }
  const gradient = builtinGradientForAsset(cover.target.href)
  const served = resolveVault(cover.target.href)
  if (served) return { kind: 'image', url: served, y: cover.y, source: gradient ? 'gradient' : 'vault' }
  if (gradient) return { kind: 'image', url: gradientCoverDataUrl(gradient), y: cover.y, source: 'gradient' }
  return { kind: 'placeholder' }
}
