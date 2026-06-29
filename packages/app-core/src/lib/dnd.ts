/**
 * Tiny helpers for passing note / folder drag payloads through the
 * browser's HTML5 drag-and-drop API. We use a custom MIME type so
 * we don't collide with text or file drops.
 */

export type DragPayload =
  | {
      kind: 'note'
      path: string
      /** Leaf pane id the tab was dragged from, when the source is a tab. */
      sourcePaneId?: string
    }
  | { kind: 'asset'; path: string }
  | { kind: 'folder'; folder: 'inbox' | 'quick' | 'archive' | 'trash'; subpath: string }
  | { kind: 'task'; id: string }
  | {
      kind: 'multi'
      items: Array<
        | { kind: 'note'; path: string }
        | { kind: 'folder'; folder: 'inbox' | 'quick' | 'archive' | 'trash'; subpath: string }
      >
    }

export const ZEN_DND_MIME = 'application/x-zen-item'
export const ZEN_DND_ASSET_MIME = 'application/x-zen-asset'
export const ZEN_DND_TEXT_MIME = 'text/x-zen-item'

// The active drag's payload, readable during `dragover` (where `getData` is
// blocked by the browser). Set on every dragstart so it's always fresh for the
// current drag; used by manual reorder to tell same-folder drops apart.
let currentDragPayload: DragPayload | null = null

/** The payload of the in-flight drag, or null. Safe to read during dragover. */
export function getCurrentDragPayload(): DragPayload | null {
  return currentDragPayload
}

export function setDragPayload(e: React.DragEvent, payload: DragPayload): void {
  currentDragPayload = payload
  const encoded = JSON.stringify(payload)
  if (payload.kind === 'asset') {
    e.dataTransfer.setData(ZEN_DND_ASSET_MIME, encoded)
    e.dataTransfer.effectAllowed = 'copy'
    return
  }

  e.dataTransfer.setData(ZEN_DND_MIME, encoded)
  e.dataTransfer.setData(ZEN_DND_TEXT_MIME, encoded)
  // Text fallback so cross-app drops don't look totally empty.
  e.dataTransfer.setData(
    'text/plain',
    payload.kind === 'note'
      ? payload.path
      : payload.kind === 'folder'
        ? `${payload.folder}/${payload.subpath}`
        : payload.kind === 'task'
          ? payload.id
          : payload.items
              .map((item) => (item.kind === 'note' ? item.path : `${item.folder}/${item.subpath}`))
              .join('\n')
  )
  e.dataTransfer.effectAllowed = 'move'
}

export function readDragPayload(e: React.DragEvent): DragPayload | null {
  const raw =
    e.dataTransfer.getData(ZEN_DND_MIME) ||
    e.dataTransfer.getData(ZEN_DND_ASSET_MIME) ||
    e.dataTransfer.getData(ZEN_DND_TEXT_MIME)
  if (!raw) return null
  try {
    return JSON.parse(raw) as DragPayload
  } catch {
    return null
  }
}

export function hasZenItem(e: React.DragEvent): boolean {
  return (
    e.dataTransfer.types.includes(ZEN_DND_MIME) ||
    e.dataTransfer.types.includes(ZEN_DND_TEXT_MIME)
  )
}

export function hasZenAssetItem(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes(ZEN_DND_ASSET_MIME)
}
