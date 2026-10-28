import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { clampNoteCoverY, type NoteCover as NoteCoverValue } from '@shared/note-cover'
import { noteCoverCreditLine } from '@shared/unsplash'
import { useStore } from '../store'
import { resolveLocalAsset } from '../lib/local-assets'
import { focusEditorNormalMode } from '../lib/editor-focus'
import { hasZenAssetItem, readDragPayload } from '../lib/dnd'
import { isClipboardImageFile } from '../lib/editor-paste-images'
import {
  isVaultImagePath,
  removeCover,
  setCoverFromFile,
  setCoverPosition,
  setCoverTarget
} from '../lib/note-cover-actions'
import { Button } from './ui/Button'
import { NoteCoverCredit } from './NoteCoverCredit'

/** One arrow press moves the focal point this far; Shift moves it finely. */
const STEP = 0.05
const FINE_STEP = 0.01

export type NoteCoverVariant = 'scroll' | 'pinned'

interface NoteCoverProps {
  notePath: string
  cover: NoteCoverValue
  variant: NoteCoverVariant
  /** Whether this copy may answer the palette's "Reposition cover" (the
   *  active pane's, visible one). A button press always acts on its own. */
  claimable: boolean
}

/** A web cover's host, for the line shown when it cannot load (offline, say). */
function webCoverHost(url: string): string {
  try {
    return new URL(url).hostname || url
  } catch {
    return url
  }
}

function resolveCoverUrl(
  vaultRoot: string | null,
  notePath: string,
  cover: NoteCoverValue
): { url: string | null; missing: boolean } {
  if (cover.target.kind === 'url') return { url: cover.target.url, missing: false }
  const asset = resolveLocalAsset(vaultRoot, notePath, cover.target.href)
  return { url: asset?.url ?? null, missing: asset?.missing ?? false }
}

/**
 * A note's cover image, the same component in the editor (portalled into the
 * CodeMirror slot), above the pane (pinned) and in the Read view.
 *
 * Repositioning is a mode: the cover takes the keyboard (it is a self-keyed
 * surface, so Vim navigation stands down), the image follows a drag or the
 * arrow keys (j/k too with Vim on), Enter keeps the new focal point and
 * Escape puts the old one back. Nothing is written until Enter, so a drag
 * does not save a stream of half-way positions.
 */
export function NoteCover({ notePath, cover, variant, claimable }: NoteCoverProps): JSX.Element {
  const instanceId = useId()
  const vaultRoot = useStore((s) => s.vault?.root ?? null)
  // Subscribed so the image resolves as soon as the vault's file list lands.
  useStore((s) => s.assetFiles)
  useStore((s) => s.assetFilesListed)
  const vimMode = useStore((s) => s.vimMode)
  const reposition = useStore((s) => s.noteCoverReposition)
  const setReposition = useStore((s) => s.setNoteCoverReposition)
  const openPicker = useStore((s) => s.setNoteCoverPickerPath)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const dragRef = useRef<{ startY: number; startFocal: number; overflow: number } | null>(null)
  const [draftY, setDraftY] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)
  const [dropActive, setDropActive] = useState(false)

  const { url, missing } = resolveCoverUrl(vaultRoot, notePath, cover)
  useEffect(() => setFailed(false), [url])

  const repositioning = reposition?.path === notePath && reposition.owner === instanceId
  const y = repositioning && draftY != null ? draftY : cover.y

  // The palette and `Space l c` ask for "the" cover: the first visible copy in
  // the active pane takes the request.
  useEffect(() => {
    if (!reposition || reposition.path !== notePath || reposition.owner !== null) return
    if (!claimable || !rootRef.current?.offsetParent) return
    if (useStore.getState().noteCoverReposition?.owner !== null) return
    setReposition({ path: notePath, owner: instanceId })
  }, [claimable, instanceId, notePath, reposition, setReposition])

  useEffect(() => {
    if (!repositioning) {
      setDraftY(null)
      return
    }
    // Seeded on entering the mode only: a draft must not snap back to the
    // saved position while it is being moved.
    setDraftY(cover.y)
    // Whatever started the mode may still be handing focus back as it closes
    // (the palette returns it to the editor over a few frames), so the cover
    // takes the keyboard again until that settles.
    const claim = (): void => {
      const root = rootRef.current
      if (root && document.activeElement !== root) root.focus({ preventScroll: true })
    }
    claim()
    const timers = [50, 150, 300].map((ms) => window.setTimeout(claim, ms))
    return () => timers.forEach((t) => window.clearTimeout(t))
  }, [repositioning])

  const finish = useCallback(
    (save: boolean) => {
      const next = draftY
      setReposition(null)
      if (save && next != null && next !== cover.y) void setCoverPosition(notePath, next)
      focusEditorNormalMode()
    },
    [cover.y, draftY, notePath, setReposition]
  )

  const startReposition = (): void => setReposition({ path: notePath, owner: instanceId })

  /** How far the image overhangs the frame vertically, in pixels. Zero when
   *  the picture is no taller than the frame, and dragging can do nothing. */
  const verticalOverflow = (): number => {
    const img = imageRef.current
    const frame = rootRef.current
    if (!img || !frame || !img.naturalWidth || !img.naturalHeight) return 0
    const scale = Math.max(frame.clientWidth / img.naturalWidth, frame.clientHeight / img.naturalHeight)
    return Math.max(0, img.naturalHeight * scale - frame.clientHeight)
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!repositioning || e.button !== 0) return
    if ((e.target as HTMLElement).closest('button, a')) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { startY: e.clientY, startFocal: y, overflow: verticalOverflow() }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.overflow <= 0) return
    // Dragging the picture down shows more of its top: the focal point rises.
    setDraftY(clampNoteCoverY(drag.startFocal - (e.clientY - drag.startY) / drag.overflow))
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragRef.current) return
    dragRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!repositioning) return
    const key = e.key
    const step = e.shiftKey ? FINE_STEP : STEP
    let next: number | null = null
    // The arrows move the picture the way a drag does: Down brings its top
    // into view. j/k mirror them only with Vim on (single-key rule).
    if (key === 'ArrowDown' || (vimMode && !e.ctrlKey && !e.metaKey && (key === 'j' || key === 'J'))) {
      next = (draftY ?? cover.y) - step
    } else if (key === 'ArrowUp' || (vimMode && !e.ctrlKey && !e.metaKey && (key === 'k' || key === 'K'))) {
      next = (draftY ?? cover.y) + step
    } else if (key === 'Home') {
      next = 0
    } else if (key === 'End') {
      next = 1
    } else if (key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      finish(true)
      return
    } else if (key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      finish(false)
      return
    } else {
      return
    }
    e.preventDefault()
    e.stopPropagation()
    setDraftY(clampNoteCoverY(Math.round(next * 100) / 100))
  }

  const droppedImage = (e: ReactDragEvent): File | null =>
    Array.from(e.dataTransfer.files ?? []).find(isClipboardImageFile) ?? null

  const acceptsDrop = (e: ReactDragEvent): boolean =>
    hasZenAssetItem(e) || Array.from(e.dataTransfer.types).includes('Files')

  const onDragOver = (e: ReactDragEvent<HTMLDivElement>): void => {
    if (!acceptsDrop(e)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    setDropActive(true)
  }

  const onDrop = (e: ReactDragEvent<HTMLDivElement>): void => {
    setDropActive(false)
    if (!acceptsDrop(e)) return
    e.preventDefault()
    e.stopPropagation()
    const payload = hasZenAssetItem(e) ? readDragPayload(e) : null
    if (payload?.kind === 'asset') {
      if (isVaultImagePath(payload.path)) void setCoverTarget(notePath, { kind: 'vault', href: payload.path })
      return
    }
    const file = droppedImage(e)
    if (file) void setCoverFromFile(notePath, file)
  }

  const showImage = !!url && !missing && !failed
  const name =
    cover.target.kind === 'url'
      ? cover.target.url
      : cover.target.href.slice(cover.target.href.lastIndexOf('/') + 1)
  const credit = noteCoverCreditLine(cover)

  return (
    <div
      ref={rootRef}
      data-note-cover={variant}
      data-note-cover-reposition={repositioning ? '' : undefined}
      tabIndex={repositioning ? 0 : -1}
      aria-label={repositioning ? 'Reposition cover' : 'Note cover'}
      className={[
        // shrink-0: the split Read view is a flex column, where an overflow-hidden
        // box would otherwise give its height up to the text below it.
        'zen-note-cover group relative w-full shrink-0 select-none overflow-hidden bg-paper-200 outline-none',
        variant === 'pinned' ? 'zen-note-cover-pinned' : '',
        repositioning ? 'cursor-grab active:cursor-grabbing' : '',
        dropActive ? 'ring-2 ring-inset ring-accent' : ''
      ].join(' ')}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      onDragOver={onDragOver}
      onDragLeave={() => setDropActive(false)}
      onDrop={onDrop}
    >
      {showImage ? (
        <img
          ref={imageRef}
          src={url}
          alt=""
          draggable={false}
          onError={() => setFailed(true)}
          className="pointer-events-none h-full w-full object-cover"
          style={{ objectPosition: `50% ${Math.round(y * 1000) / 10}%` }}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center px-6 text-center text-sm text-ink-500">
          {url === null && !missing && cover.target.kind === 'vault'
            ? 'Loading cover…'
            : cover.target.kind === 'url'
              ? `Could not load the cover from ${webCoverHost(cover.target.url)}`
              : `Cover image not found: ${name}`}
        </div>
      )}
      {credit && !repositioning && <NoteCoverCredit line={credit} persistent={false} />}
      {repositioning ? (
        <>
          <div className="pointer-events-none absolute inset-x-0 top-1/2 flex -translate-y-1/2 justify-center">
            <span className="rounded-md bg-ink-900/70 px-3 py-1.5 text-xs font-medium text-paper-50">
              Drag the image or press {vimMode ? '↑ ↓ (j k)' : '↑ ↓'} to reposition
            </span>
          </div>
          <div className="absolute bottom-3 right-3 flex gap-1.5">
            <Button variant="primary" onClick={() => finish(true)}>
              Save position
            </Button>
            <Button className="bg-paper-50/90" onClick={() => finish(false)}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <div className="absolute bottom-3 right-3 flex gap-1.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <Button className="bg-paper-50/90" onClick={() => openPicker(notePath)}>
            Change cover
          </Button>
          {showImage && (
            <Button className="bg-paper-50/90" onClick={startReposition}>
              Reposition
            </Button>
          )}
          <Button className="bg-paper-50/90" onClick={() => void removeCover(notePath)}>
            Remove
          </Button>
        </div>
      )}
    </div>
  )
}
