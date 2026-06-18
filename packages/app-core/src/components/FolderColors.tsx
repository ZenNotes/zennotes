import type { FolderColorId, NoteFolder } from '@shared/ipc'
import { folderIconKey } from '../lib/vault-layout'

export interface FolderColorOption {
  id: FolderColorId
  label: string
  /** Solid swatch background, used in the picker. */
  swatchClass: string
  /** Text color applied to the folder's sidebar glyph. */
  glyphClass: string
}

// Preset palette. Tailwind palette colors at the 500 weight read well on both
// the light (paper) and dark sidebar. Class names are literal so the Tailwind
// content scanner keeps them.
export const FOLDER_COLOR_OPTIONS: readonly FolderColorOption[] = [
  { id: 'red', label: 'Red', swatchClass: 'bg-red-500', glyphClass: 'text-red-500' },
  { id: 'orange', label: 'Orange', swatchClass: 'bg-orange-500', glyphClass: 'text-orange-500' },
  { id: 'amber', label: 'Amber', swatchClass: 'bg-amber-500', glyphClass: 'text-amber-500' },
  { id: 'green', label: 'Green', swatchClass: 'bg-green-500', glyphClass: 'text-green-500' },
  { id: 'teal', label: 'Teal', swatchClass: 'bg-teal-500', glyphClass: 'text-teal-500' },
  { id: 'sky', label: 'Sky', swatchClass: 'bg-sky-500', glyphClass: 'text-sky-500' },
  { id: 'blue', label: 'Blue', swatchClass: 'bg-blue-500', glyphClass: 'text-blue-500' },
  { id: 'indigo', label: 'Indigo', swatchClass: 'bg-indigo-500', glyphClass: 'text-indigo-500' },
  { id: 'violet', label: 'Violet', swatchClass: 'bg-violet-500', glyphClass: 'text-violet-500' },
  { id: 'pink', label: 'Pink', swatchClass: 'bg-pink-500', glyphClass: 'text-pink-500' }
] as const

const FOLDER_COLOR_LOOKUP = new Map(FOLDER_COLOR_OPTIONS.map((option) => [option.id, option]))

/** The glyph text-color class for a color id (any keyed entry — folder, note,
 *  database…), or null when there's no color. */
export function colorGlyphClassById(id: FolderColorId | null | undefined): string | null {
  return id ? FOLDER_COLOR_LOOKUP.get(id)?.glyphClass ?? null : null
}

/** The chosen color for a folder, or null when none is set (default tint). */
export function resolveFolderColorId(
  folder: NoteFolder,
  subpath: string,
  folderColors: Record<string, FolderColorId>
): FolderColorId | null {
  return folderColors[folderIconKey(folder, subpath)] ?? null
}

/** The glyph text-color class for a folder, or null when no color is set. */
export function resolveFolderColorGlyphClass(
  folder: NoteFolder,
  subpath: string,
  folderColors: Record<string, FolderColorId>
): string | null {
  const id = resolveFolderColorId(folder, subpath, folderColors)
  return id ? FOLDER_COLOR_LOOKUP.get(id)?.glyphClass ?? null : null
}
