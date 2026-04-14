import type { EditorView } from '@codemirror/view'

export type ImageBlockDragPayload = {
  kind: 'image-block'
  notePath: string
  from: number
  to: number
  text: string
}

export type ImageBlockDropPlacement = {
  insertAt: number
  indicatorPos: number
  removeFrom: number
  removeTo: number
  movedText: string
}

export const ZEN_IMAGE_BLOCK_MIME = 'application/x-zen-image-block'

export function setImageBlockDragPayload(
  dataTransfer: DataTransfer,
  payload: ImageBlockDragPayload
): void {
  dataTransfer.setData(ZEN_IMAGE_BLOCK_MIME, JSON.stringify(payload))
  dataTransfer.effectAllowed = 'move'
}

export function readImageBlockDragPayload(
  dataTransfer: DataTransfer | null
): ImageBlockDragPayload | null {
  if (!dataTransfer) return null
  const raw = dataTransfer.getData(ZEN_IMAGE_BLOCK_MIME)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as ImageBlockDragPayload
    if (
      parsed.kind !== 'image-block' ||
      typeof parsed.notePath !== 'string' ||
      typeof parsed.from !== 'number' ||
      typeof parsed.to !== 'number' ||
      typeof parsed.text !== 'string'
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function hasImageBlockDragPayload(dataTransfer: DataTransfer | null): boolean {
  return !!dataTransfer?.types?.includes(ZEN_IMAGE_BLOCK_MIME)
}

export function moveImageBlockInEditor(
  view: EditorView,
  payload: ImageBlockDragPayload,
  coords?: { x: number; y: number }
): boolean {
  const placement = getImageBlockDropPlacement(view, payload, coords)
  if (!placement) return false

  const { state } = view
  const { insertAt, removeFrom, removeTo, movedText } = placement
  const doc = state.doc.toString()
  const withoutSource = doc.slice(0, removeFrom) + doc.slice(removeTo)
  const nextDoc = withoutSource.slice(0, insertAt) + movedText + withoutSource.slice(insertAt)

  view.dispatch({
    changes: { from: 0, to: state.doc.length, insert: nextDoc },
    selection: { anchor: insertAt, head: insertAt + movedText.length },
    scrollIntoView: true
  })
  view.focus()
  return true
}

export function getImageBlockDropPlacement(
  view: EditorView,
  payload: ImageBlockDragPayload,
  coords?: { x: number; y: number }
): ImageBlockDropPlacement | null {
  const state = view.state
  if (payload.from < 0 || payload.to < payload.from || payload.to > state.doc.length) return null

  let removeFrom = payload.from
  let removeTo = payload.to
  if (removeTo < state.doc.length && state.doc.sliceString(removeTo, removeTo + 1) === '\n') {
    removeTo += 1
  }

  const movedText = state.doc.sliceString(removeFrom, removeTo)
  if (!movedText.trim()) return null

  let rawTarget = coords ? view.posAtCoords(coords) ?? state.selection.main.head : state.selection.main.head
  rawTarget = Math.max(0, Math.min(state.doc.length, rawTarget))

  if (rawTarget >= removeFrom && rawTarget <= removeTo) return null

  const targetLine = state.doc.lineAt(rawTarget)
  let insertAt = targetLine.from
  let indicatorPos = targetLine.from
  if (coords) {
    const lineRect = view.coordsAtPos(targetLine.from)
    if (lineRect && coords.y > lineRect.top + (lineRect.bottom - lineRect.top) / 2) {
      insertAt = targetLine.to
      if (insertAt < state.doc.length && state.doc.sliceString(insertAt, insertAt + 1) === '\n') {
        insertAt += 1
      }
      indicatorPos = insertAt
    }
  }

  const removedLength = removeTo - removeFrom
  const mappedInsertAt = insertAt > removeFrom ? insertAt - removedLength : insertAt
  if (mappedInsertAt === removeFrom) return null

  return {
    insertAt: mappedInsertAt,
    indicatorPos,
    removeFrom,
    removeTo,
    movedText
  }
}
