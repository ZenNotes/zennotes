/**
 * Resizing a standalone image embed from the editor (#684). The drag handle
 * on the live-preview widget and the Resize Image command / `:imgwidth` both
 * end in `setImageWidthOnLine`, so the markdown is rewritten in exactly one
 * way: as the Obsidian size hint every other surface already reads (#570),
 * `![[pic.png|480]]` or `![alt|480](pic.png)`, never as app-private state.
 * The reading view, exports, the server, and Obsidian therefore all agree on
 * the size. Width only: a drag keeps the picture's aspect ratio, and an
 * explicit `WxH` hint is replaced rather than distorted into the old height.
 */
import type { EditorView } from '@codemirror/view'
import { readEmbedWidth, withEmbedWidth } from '@shared/embed-size'
import { promptApp } from './prompt-requests'
import { useToastStore } from './toast'

/** Narrower than this and the handle itself hides the picture. */
export const MIN_IMAGE_WIDTH = 48

export function clampImageWidth(width: number, maxWidth: number): number {
  const max = Math.max(MIN_IMAGE_WIDTH, Math.floor(maxWidth))
  return Math.min(max, Math.max(MIN_IMAGE_WIDTH, Math.round(width)))
}

export type ImageResizeResult = 'resized' | 'unchanged' | 'not-an-image'

/** Rewrite the size hint of the standalone image on 1-based `lineNumber`;
 *  `null` strips the hint. One transaction, so one undo step. */
export function setImageWidthOnLine(
  view: EditorView,
  lineNumber: number,
  width: number | null
): ImageResizeResult {
  if (lineNumber < 1 || lineNumber > view.state.doc.lines) return 'not-an-image'
  const line = view.state.doc.line(lineNumber)
  const next = withEmbedWidth(line.text, width)
  if (next === null) return 'not-an-image'
  if (next === line.text) return 'unchanged'
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: next },
    userEvent: 'input.image-resize'
  })
  return 'resized'
}

export function setImageWidthAtCursor(view: EditorView, width: number | null): ImageResizeResult {
  const line = view.state.doc.lineAt(view.state.selection.main.head)
  return setImageWidthOnLine(view, line.number, width)
}

/**
 * The prompt / ex argument for a width: a pixel count (`480`, `480px`), or
 * `auto`, `0`, or nothing to strip the hint. `undefined` means the text was
 * not a width at all.
 */
export function parseImageWidthInput(raw: string): number | null | undefined {
  const value = raw.trim().toLowerCase().replace(/px$/, '').trim()
  if (value === '' || value === 'auto' || value === 'reset' || value === 'none') return null
  if (!/^\d+$/.test(value)) return undefined
  const width = Number(value)
  return width >= 1 ? width : null
}

function notImageLine(): void {
  useToastStore.getState().addToast('Put the cursor on an image line to resize it', 'info')
}

/** `:imgwidth <arg>`: apply a typed width to the image on the cursor line,
 *  explaining a refusal instead of failing silently. */
export function setImageWidthFromInput(
  view: EditorView,
  raw: string
): ImageResizeResult | 'invalid' {
  const width = parseImageWidthInput(raw)
  if (width === undefined) {
    useToastStore.getState().addToast(`"${raw.trim()}" is not a width in pixels`, 'error')
    return 'invalid'
  }
  const result = setImageWidthAtCursor(view, width)
  if (result === 'not-an-image') notImageLine()
  return result
}

/** The keyboard path: ask for a width for the image on the cursor line.
 *  Empty (or `auto`) strips the hint; a non-number is refused with a toast. */
export async function promptImageWidth(
  view: EditorView
): Promise<ImageResizeResult | 'cancelled' | 'invalid'> {
  const line = view.state.doc.lineAt(view.state.selection.main.head)
  if (withEmbedWidth(line.text, 1) === null) {
    notImageLine()
    return 'not-an-image'
  }
  const current = readEmbedWidth(line.text)
  const answer = await promptApp({
    title: 'Resize image',
    description: 'Width in pixels. Leave it empty (or type auto) for the natural size.',
    initialValue: current ? String(current) : '',
    placeholder: '480',
    okLabel: 'Resize',
    allowEmptySubmit: true
  })
  if (answer === null) return 'cancelled'
  const result = setImageWidthFromInput(view, answer)
  view.focus()
  return result
}

export interface ImageResizeHandleOptions {
  /** The element the user drags (sits on the picture's right edge). */
  handle: HTMLElement
  image: HTMLImageElement
  /** The widget root: gets `is-resizing` while a drag is live and has its
   *  block drag-to-move suspended so the two gestures never fight. */
  figure: HTMLElement
  /** Live readout, `480 px`, shown while dragging. */
  badge: HTMLElement
  /** Widest the picture may go right now (the pane's content width). */
  maxWidth: () => number
  /** Called once, on release, with the final width; not called for a click
   *  or a drag that ended where it began. */
  onCommit: (width: number) => void
}

/**
 * Logseq-style pointer resize. Live width changes go on the element only;
 * the note is written once, on release, by `onCommit`. Pointer capture keeps
 * the drag alive when the cursor leaves the handle, and a release with no
 * movement restores the picture instead of writing a no-op hint.
 */
export function attachImageResizeHandle(options: ImageResizeHandleOptions): void {
  const { handle, image, figure, badge, maxWidth, onCommit } = options
  let drag: {
    pointerId: number
    startX: number
    startWidth: number
    previousInlineWidth: string
    width: number
  } | null = null

  const setWidth = (width: number): void => {
    image.style.width = `${width}px`
    badge.textContent = `${width} px`
  }

  const move = (event: PointerEvent): void => {
    if (!drag || event.pointerId !== drag.pointerId) return
    event.preventDefault()
    drag.width = clampImageWidth(drag.startWidth + (event.clientX - drag.startX), maxWidth())
    setWidth(drag.width)
  }

  const finish = (event: PointerEvent): void => {
    if (!drag || event.pointerId !== drag.pointerId) return
    const { width, startWidth, previousInlineWidth, pointerId } = drag
    drag = null
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', finish)
    handle.removeEventListener('pointercancel', finish)
    if (typeof handle.releasePointerCapture === 'function') {
      try {
        handle.releasePointerCapture(pointerId)
      } catch {
        /* capture already gone */
      }
    }
    figure.classList.remove('is-resizing')
    figure.draggable = true
    if (event.type === 'pointercancel' || Math.abs(width - startWidth) < 1) {
      image.style.width = previousInlineWidth
      return
    }
    onCommit(width)
  }

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || drag) return
    // The default would start the figure's HTML drag (block move) and a text
    // selection; neither belongs to a resize.
    event.preventDefault()
    event.stopPropagation()
    const startWidth = Math.round(image.getBoundingClientRect().width)
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth,
      previousInlineWidth: image.style.width,
      width: startWidth
    }
    figure.classList.add('is-resizing')
    figure.draggable = false
    if (typeof handle.setPointerCapture === 'function') {
      try {
        handle.setPointerCapture(event.pointerId)
      } catch {
        /* not a capturable pointer */
      }
    }
    badge.textContent = `${startWidth} px`
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', finish)
    handle.addEventListener('pointercancel', finish)
  })
  // Belt and braces for the block drag: a dragstart that still reaches the
  // handle must not lift the whole figure.
  handle.addEventListener('dragstart', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })
  handle.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })
}
