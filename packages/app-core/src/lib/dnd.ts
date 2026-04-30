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
  | { kind: 'folder'; folder: 'inbox' | 'quick' | 'archive' | 'trash'; subpath: string }
  | {
      kind: 'multi'
      items: Array<
        | { kind: 'note'; path: string }
        | { kind: 'folder'; folder: 'inbox' | 'quick' | 'archive' | 'trash'; subpath: string }
      >
    }

export const ZEN_DND_MIME = 'application/x-zen-item'
export const ZEN_DND_TEXT_MIME = 'text/x-zen-item'

export function setDragPayload(e: React.DragEvent, payload: DragPayload): void {
  const encoded = JSON.stringify(payload)
  e.dataTransfer.setData(ZEN_DND_MIME, encoded)
  e.dataTransfer.setData(ZEN_DND_TEXT_MIME, encoded)
  // Text fallback so cross-app drops don't look totally empty.
  e.dataTransfer.setData(
    'text/plain',
    payload.kind === 'note'
      ? payload.path
      : payload.kind === 'folder'
        ? `${payload.folder}/${payload.subpath}`
        : payload.items
            .map((item) => (item.kind === 'note' ? item.path : `${item.folder}/${item.subpath}`))
            .join('\n')
  )
  e.dataTransfer.effectAllowed = 'move'
}

export function readDragPayload(e: React.DragEvent): DragPayload | null {
  const raw =
    e.dataTransfer.getData(ZEN_DND_MIME) || e.dataTransfer.getData(ZEN_DND_TEXT_MIME)
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
