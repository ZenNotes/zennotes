import type { ExcalidrawDocument } from '@shared/excalidraw'
import {
  isExcalidrawPath,
  isObsidianExcalidrawPath,
  parseExcalidrawDocument,
  extractObsidianExcalidrawScene
} from '@shared/excalidraw'

// Size hints moved to shared-domain so the Word export in the desktop main
// process reads `|600` the same way the editor does (#629). Re-exported here
// because the editor and preview import them from this module.
export { parseEmbedSizeHint, splitEmbedLabel } from '@shared/embed-size'
export type { EmbedSize } from '@shared/embed-size'

interface CacheEntry {
  mtime: number
  /** Whether this PNG was exported in dark mode — a theme flip re-renders it. */
  dark: boolean
  dataUrl: string
}

/** The app's currently resolved light/dark mode (mirrored on <html> by App.tsx). */
function currentThemeDark(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.themeMode === 'dark'
}

/** Path → rendered PNG data URL, keyed by file mtime so edited drawings refresh.
 *  Bounded LRU: each entry is a full @2x base64 PNG, so cap the count to avoid
 *  unbounded heap growth when browsing a vault with many drawings. */
const previewCache = new Map<string, CacheEntry>()
const MAX_PREVIEW_CACHE = 24
/** Dedupes concurrent render requests for the same path. */
const inflight = new Map<string, Promise<string | null>>()

/** Read the cached entry, promoting it to most-recently-used. */
function readCache(path: string): CacheEntry | undefined {
  const entry = previewCache.get(path)
  if (!entry) return undefined
  previewCache.delete(path)
  previewCache.set(path, entry)
  return entry
}

/** Insert/update a cached entry, evicting the oldest past the cap. */
function writeCache(path: string, entry: CacheEntry): void {
  previewCache.set(path, entry)
  while (previewCache.size > MAX_PREVIEW_CACHE) {
    const oldest = previewCache.keys().next().value
    if (oldest === undefined) break
    previewCache.delete(oldest)
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

async function renderPng(doc: ExcalidrawDocument, dark: boolean): Promise<string> {
  const { exportToBlob } = await import('@excalidraw/excalidraw')
  // Excalidraw keeps deleted elements in the scene for undo history.
  // exportToBlob expects only non-deleted elements — including deleted
  // ones corrupts the bounding-box calculation and crops the output.
  const activeElements = doc.elements.filter((el) => {
    if (typeof el !== 'object' || el === null) return false
    return !(el as { isDeleted?: boolean }).isDeleted
  })
  const blob = await exportToBlob({
    elements: activeElements as never,
    // Follow the app's light/dark mode so an embedded drawing matches the note
    // (and the editor, which already themes itself) instead of showing a white
    // box in a dark note. (#363)
    appState: { ...doc.appState, exportBackground: true, exportWithDarkMode: dark } as never,
    files: doc.files as never,
    mimeType: 'image/png',
    exportPadding: 8,
    getDimensions: (width: number, height: number) => ({
      width: width * 2,
      height: height * 2,
      scale: 2
    })
  } as never)
  return blobToDataUrl(blob)
}

/** Read a `.excalidraw` or Obsidian `.excalidraw.md` file into a renderable scene. */
async function readScene(
  path: string
): Promise<{ doc: ExcalidrawDocument; mtime: number } | null> {
  const res = await window.zen.readNote(path)
  if (!res) return null
  const mtime = res.updatedAt ?? 0
  const doc = isObsidianExcalidrawPath(path)
    ? extractObsidianExcalidrawScene(res.body)
    : parseExcalidrawDocument(res.body)
  if (!doc) return null
  return { doc, mtime }
}

/**
 * Render an Excalidraw file to a PNG data URL, cached by path + mtime.
 * Returns null if the file can't be read or the export fails (e.g. an
 * empty scene that produces no bitmap).
 */
export async function getExcalidrawPreview(path: string): Promise<string | null> {
  const existing = inflight.get(path)
  if (existing) return existing
  const p = (async () => {
    try {
      const dark = currentThemeDark()
      const scene = await readScene(path)
      if (!scene) return null
      const cached = readCache(path)
      if (cached && cached.mtime === scene.mtime && cached.dark === dark) return cached.dataUrl
      const dataUrl = await renderPng(scene.doc, dark)
      writeCache(path, { mtime: scene.mtime, dark, dataUrl })
      return dataUrl
    } catch (err) {
      console.error('excalidraw preview failed', path, err)
      return null
    } finally {
      inflight.delete(path)
    }
  })()
  inflight.set(path, p)
  return p
}

/**
 * Synchronously return the last-rendered PNG for a path if one is cached, without
 * reading the file or checking mtime. Lets a re-mounted embed show its image
 * immediately instead of flashing the loading state; the async
 * `getExcalidrawPreview` still runs to refresh a changed drawing.
 */
export function peekExcalidrawPreview(path: string): string | null {
  return previewCache.get(path)?.dataUrl ?? null
}

/** Drop a single cached preview (called by the vault watcher on change). */
export function invalidateExcalidrawPreview(path: string): void {
  previewCache.delete(path)
}

/** Drop every cached preview. After a change-feed gap (watch socket
 *  reconnect) the per-path change events are gone for good, so any drawing
 *  may be stale; previews re-render lazily from disk. */
export function invalidateAllExcalidrawPreviews(): void {
  previewCache.clear()
}

/**
 * Resolve a raw embed target (e.g. `Drawings/foo.excalidraw`, `foo.excalidraw`,
 * or bare `foo`) to a real vault-relative note path. Excalidraw drawings live in
 * `state.notes`, not `assetFiles`, and `resolveWikilinkTarget` only matches
 * `.md` files — so this handles the drawing-specific lookup.
 */
export function resolveExcalidrawEmbedPath(
  notePaths: string[],
  target: string
): string | null {
  const t = target.trim()
  if (!t) return null
  const stripExt = (name: string): string =>
    name.replace(/\.(excalidraw\.md|excalidraw)$/i, '')

  if (isObsidianExcalidrawPath(t) || isExcalidrawPath(t)) {
    const exact = notePaths.find((p) => p === t)
    if (exact) return exact
    const suffixMatches = notePaths.filter((p) => p.endsWith('/' + t))
    if (suffixMatches.length === 1) return suffixMatches[0]!
  }

  const base = t.split('/').pop() ?? t
  const byBase = notePaths.filter((p) => (p.split('/').pop() ?? p) === base)
  if (byBase.length === 1) return byBase[0]!

  const titleTarget = stripExt(base)
  const byTitle = notePaths.filter((p) => {
    const b = p.split('/').pop() ?? p
    return stripExt(b) === titleTarget
  })
  if (byTitle.length === 1) return byTitle[0]!

  return null
}
