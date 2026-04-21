import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { NoteContent, NoteMeta } from '@shared/ipc'
import { useStore } from '../store'
import { renderMarkdown } from '../lib/markdown'
import { enhanceLocalAssetNodes } from '../lib/local-assets'

type AnchorRectLike = Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'>

export function NoteHoverPreview({
  note,
  anchorRect,
  placement = 'anchored',
  interactive = false,
  onPointerEnter,
  onPointerLeave
}: {
  note: Pick<NoteMeta, 'path' | 'title'>
  anchorRect: AnchorRectLike
  placement?: 'anchored' | 'floating'
  interactive?: boolean
  onPointerEnter?: () => void
  onPointerLeave?: () => void
}): JSX.Element {
  const activeNote = useStore((s) => s.activeNote)
  const vault = useStore((s) => s.vault)
  const focusedPanel = useStore((s) => s.focusedPanel)
  const setFocusedPanel = useStore((s) => s.setFocusedPanel)
  const [content, setContent] = useState<NoteContent | null>(
    activeNote?.path === note.path ? activeNote : null
  )
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const articleRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    let cancelled = false
    if (activeNote?.path === note.path) {
      setContent(activeNote)
      return
    }
    void window.zen.readNote(note.path).then(
      (next) => {
        if (!cancelled) setContent(next)
      },
      () => {
        if (!cancelled) setContent(null)
      }
    )
    return () => {
      cancelled = true
    }
  }, [note.path, activeNote])

  useEffect(() => {
    if (!interactive || focusedPanel !== 'hoverpreview') return
    const raf = requestAnimationFrame(() => {
      scrollRef.current?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(raf)
  }, [focusedPanel, interactive, note.path])

  const html = useMemo(() => {
    const source = (content?.body ?? '').slice(0, 1400)
    return source ? renderMarkdown(source) : ''
  }, [content?.body])

  useEffect(() => {
    const root = articleRef.current
    if (!root || !content?.path) return
    enhanceLocalAssetNodes(root, {
      vaultRoot: vault?.root,
      notePath: content.path
    })
  }, [content?.path, html, vault?.root])

  const position = useMemo(() => {
    const width = 380
    const viewportPad = 12
    const maxTop = window.innerHeight - 320 - viewportPad
    let left: number
    let top: number

    if (placement === 'floating') {
      const gap = 28
      const preferLeft = anchorRect.left > window.innerWidth * 0.55
      left = preferLeft
        ? Math.max(viewportPad, anchorRect.left - width - gap)
        : Math.min(window.innerWidth - width - viewportPad, anchorRect.right + gap)
      top = Math.min(maxTop, Math.max(viewportPad + 56, window.innerHeight * 0.22))
    } else {
      const gap = 14
      const preferRight = anchorRect.right + width + gap < window.innerWidth - viewportPad
      left = preferRight
        ? anchorRect.right + gap
        : Math.max(viewportPad, anchorRect.left - width - gap)
      top = Math.min(maxTop, Math.max(viewportPad, anchorRect.top - 12))
    }

    return { left, top, width }
  }, [anchorRect, placement])

  return createPortal(
    <div
      className={[
        'note-hover-preview fixed z-[85] overflow-hidden rounded-2xl bg-paper-100/98 shadow-float ring-1 ring-paper-300/80 backdrop-blur-md',
        interactive ? 'pointer-events-auto' : 'pointer-events-none'
      ].join(' ')}
      style={{ left: position.left, top: position.top, width: position.width }}
      onPointerEnter={interactive ? onPointerEnter : undefined}
      onPointerLeave={interactive ? onPointerLeave : undefined}
    >
      <div className="border-b border-paper-300/60 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-400">
              Hover Preview
            </div>
            <div className="mt-1 truncate text-sm font-semibold text-ink-900">{note.title}</div>
            <div className="mt-0.5 truncate text-[11px] text-ink-500">{note.path}</div>
          </div>
          {interactive && (
            <span className="shrink-0 rounded-md border border-paper-300/70 bg-paper-50/70 px-1.5 py-0.5 text-[10px] leading-none text-ink-500">
              <span className="font-mono text-[10px]">esc</span>
              <span className="ml-1">back</span>
            </span>
          )}
        </div>
      </div>
      <div
        ref={scrollRef}
        data-hover-preview-scroll
        tabIndex={interactive ? 0 : -1}
        onMouseDownCapture={interactive ? () => setFocusedPanel('hoverpreview') : undefined}
        onFocusCapture={interactive ? () => setFocusedPanel('hoverpreview') : undefined}
        className="max-h-[320px] overflow-y-auto overscroll-contain px-4 py-3 outline-none focus:outline-none"
      >
        {html ? (
          <article
            ref={articleRef}
            className="prose-zen prose-hover-preview"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <div className="text-sm text-ink-400">Loading preview…</div>
        )}
      </div>
    </div>,
    document.body
  )
}
