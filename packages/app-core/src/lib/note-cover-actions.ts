/**
 * Everything that changes a note's cover goes through here: the picker, the
 * cover's own buttons, the palette, `:cover` and `Space l c`.
 *
 * A cover is frontmatter, so an edit is a text edit. When the note is the one
 * in the focused editor the edit goes through that editor as a transaction, so
 * `u` / Mod+Z takes the cover back like any other change; otherwise the store
 * takes the new body. Either way the note is saved right after, since a cover
 * is a deliberate act rather than typing in progress.
 *
 * New images arrive through `importPastedImage`, the one import every host
 * has (local and remote desktop vaults, the web client over the Go server,
 * the phone shells), so the file lands in the vault's `assets/` folder by
 * the same rules a pasted screenshot does. An Unsplash photo is the one
 * exception: Unsplash's terms keep it on images.unsplash.com, so it is an
 * https cover with its photographer's credit (shared-domain unsplash.ts).
 */
import {
  readNoteCover,
  removeNoteCover,
  setNoteCover,
  setNoteCoverPosition,
  type NoteCover,
  type NoteCoverTarget
} from '@shared/note-cover'
import { IMAGE_FILE_EXTENSIONS } from '@shared/pasted-image'
import { unsplashCoverUrl, unsplashPhotoCredit } from '@shared/unsplash'
import type { UnsplashPhoto } from '@zennotes/bridge-contract/unsplash'
import { useStore } from '../store'
import { useToastStore } from './toast'
import { minimalTextChange } from './minimal-text-change'
import { isClipboardImageFile, readSystemClipboard } from './editor-paste-images'
import type { BuiltinCover } from './note-cover-gallery'
import { unsplashSearchAvailable } from './unsplash-search'

/** The note whose cover the cover commands act on: the active note, unless it
 *  is in the Trash, where nothing gets edited. */
export function coverNotePath(): string | null {
  const active = useStore.getState().activeNote
  if (!active || active.folder === 'trash') return null
  if (!/\.md$/i.test(active.path)) return null
  return active.path
}

/** Open the cover picker for the active note, on the Covers tab unless told
 *  otherwise. False (with a word why) when there is no note to give a cover. */
export function openCoverPicker(start?: { tab: 'covers' | 'unsplash'; query: string }): boolean {
  const path = coverNotePath()
  if (!path) {
    useToastStore.getState().addToast('Open a note to give it a cover', 'info')
    return false
  }
  useStore.getState().setNoteCoverPickerPath(path, start ?? null)
  return true
}

/** The picker on its Unsplash tab, searching for `query` when there is one
 *  (`Space l u`, `:cover unsplash fog`, the palette). */
export function openUnsplashCoverPicker(query = ''): boolean {
  if (!unsplashSearchAvailable()) {
    useToastStore.getState().addToast('Unsplash covers are not available in this app yet', 'info')
    return false
  }
  return openCoverPicker({ tab: 'unsplash', query })
}

/** Put the active note's cover into reposition mode; the first visible copy
 *  of it in the active pane takes the keyboard. */
export function startCoverReposition(): boolean {
  const path = coverNotePath()
  if (!path || !activeNoteCover()) return false
  if (useStore.getState().noteCoverPlacement === 'hidden') {
    useToastStore.getState().addToast('Covers are hidden in Settings, so there is nothing to reposition', 'info')
    return false
  }
  useStore.getState().setNoteCoverReposition({ path, owner: null })
  // No copy on screen to take it (a pane too narrow to draw one, say): drop
  // the request rather than let a cover drawn later jump into the mode.
  window.setTimeout(() => {
    const pending = useStore.getState().noteCoverReposition
    if (pending?.path === path && pending.owner === null) useStore.getState().setNoteCoverReposition(null)
  }, 400)
  return true
}

export function activeNoteCover(): NoteCover | null {
  const path = coverNotePath()
  if (!path) return null
  const body = useStore.getState().noteContents[path]?.body
  return body == null ? null : readNoteCover(body)
}

/** Apply `edit` to the note's body. Resolves true when the text changed. */
export async function editNoteCover(path: string, edit: (body: string) => string): Promise<boolean> {
  const state = useStore.getState()
  const content = state.noteContents[path]
  if (!content) return false
  const next = edit(content.body)
  if (next === content.body) return false
  const view = state.editorViewRef
  const viaEditor =
    !!view && state.selectedPath === path && !view.state.readOnly && view.state.doc.toString() === content.body
  if (view && viaEditor) {
    const change = minimalTextChange(content.body, next)
    if (change) view.dispatch({ changes: change, userEvent: 'input.cover' })
  } else {
    state.updateNoteBody(path, next)
  }
  // The editor's update listener has already handed the body to the store.
  if (useStore.getState().noteContents[path]?.body !== next) return false
  await useStore.getState().persistNote(path)
  return true
}

export async function setCoverTarget(path: string, target: NoteCoverTarget, y?: number): Promise<boolean> {
  return editNoteCover(path, (body) => {
    const withImage = setNoteCover(body, target)
    return y == null || y === 0.5 ? withImage : setNoteCoverPosition(withImage, y)
  })
}

export async function setCoverPosition(path: string, y: number): Promise<boolean> {
  return editNoteCover(path, (body) => setNoteCoverPosition(body, y))
}

export async function removeCover(path: string): Promise<boolean> {
  return editNoteCover(path, removeNoteCover)
}

function reportError(err: unknown, fallback: string): void {
  const message = err instanceof Error && err.message ? err.message : fallback
  useToastStore.getState().addToast(message, 'error')
}

function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export function isVaultImagePath(path: string): boolean {
  const dot = path.lastIndexOf('.')
  return dot > 0 && IMAGE_FILE_EXTENSIONS.has(path.slice(dot).toLowerCase())
}

async function importImageBytes(
  data: ArrayBuffer | Uint8Array,
  mimeType: string,
  suggestedName: string | null
): Promise<string> {
  const imported = await window.zen.importPastedImage({ data, mimeType, suggestedName })
  await useStore.getState().refreshAssets()
  return imported.path
}

/** Copy an image file (picked, pasted or dropped) into the vault and make it
 *  the note's cover. */
export async function setCoverFromFile(path: string, file: File): Promise<boolean> {
  if (!isClipboardImageFile(file)) {
    useToastStore.getState().addToast('A cover has to be an image file', 'info')
    return false
  }
  try {
    const assetPath = await importImageBytes(await file.arrayBuffer(), file.type || 'image/png', file.name || null)
    return await setCoverTarget(path, { kind: 'vault', href: assetPath })
  } catch (err) {
    reportError(err, 'Could not add that image as the cover')
    return false
  }
}

/** The image on the system clipboard, for the keyboard route that gets no
 *  paste event (the palette, `:cover paste`). */
export async function setCoverFromClipboard(path: string): Promise<boolean> {
  const { images } = await readSystemClipboard()
  const image = images[0]
  if (!image) {
    useToastStore.getState().addToast('There is no image on the clipboard', 'info')
    return false
  }
  return setCoverFromFile(path, image)
}

/** A built-in cover, copied into the vault the first time and reused after:
 *  every note with the Dawn gradient shares one file. */
export async function setCoverFromBuiltin(path: string, cover: BuiltinCover): Promise<boolean> {
  try {
    const existing = useStore
      .getState()
      .assetFiles.find((asset) => fileNameOf(asset.path).toLowerCase() === cover.fileName.toLowerCase())
    const assetPath =
      existing?.path ?? (await importImageBytes(await cover.bytes(), cover.mimeType, cover.fileName))
    return await setCoverTarget(path, { kind: 'vault', href: assetPath }, cover.y)
  } catch (err) {
    reportError(err, `Could not add ${cover.title} as the cover`)
    return false
  }
}

/** An Unsplash photo as the cover: hotlinked at a cover's width, never
 *  copied into the vault, with its photographer's credit on the lines under
 *  it. Unsplash hears that the photo was used (their download tracking) only
 *  once the note has it, and a ping that fails changes nothing. */
export async function setCoverFromUnsplash(path: string, photo: UnsplashPhoto): Promise<boolean> {
  const url = unsplashCoverUrl(photo.rawUrl)
  if (!url) return false
  const changed = await editNoteCover(path, (body) =>
    setNoteCover(body, { kind: 'url', url }, unsplashPhotoCredit(photo))
  )
  if (changed) void window.zen.trackUnsplashDownload?.(photo.downloadLocation)?.catch(() => {})
  return changed
}

/** `:cover <arg>`: an https URL, or an image already in the vault, matched by
 *  path or, when unique, by file name. */
export function resolveCoverArgument(arg: string): NoteCoverTarget | null {
  const text = arg.trim()
  if (/^https:\/\//i.test(text)) return { kind: 'url', url: text }
  const wanted = text.replace(/^\/+/, '').toLowerCase()
  if (!wanted) return null
  const images = useStore.getState().assetFiles.filter((asset) => isVaultImagePath(asset.path))
  const byPath = images.find((asset) => asset.path.toLowerCase() === wanted)
  if (byPath) return { kind: 'vault', href: byPath.path }
  const byName = images.filter((asset) => fileNameOf(asset.path).toLowerCase() === wanted)
  return byName.length === 1 ? { kind: 'vault', href: byName[0]!.path } : null
}
