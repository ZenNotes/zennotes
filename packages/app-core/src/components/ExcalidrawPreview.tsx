import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { getExcalidrawPreview, peekExcalidrawPreview } from '../lib/excalidraw-preview'
import { useStore } from '../store'

export interface ExcalidrawPreviewProps {
  path: string
  width?: number
  height?: number
  className?: string
  onClick?: () => void
}

/**
 * Renders an Excalidraw drawing as a PNG image (exported @2x). Used both by
 * the editor live-preview widget and the preview-pane hydration to show a
 * drawing as an image-like embed inside a note. Re-renders when the vault
 * watcher bumps `excalidrawPreviewVersion`.
 */
export function ExcalidrawPreview({
  path,
  width,
  height,
  className,
  onClick
}: ExcalidrawPreviewProps): JSX.Element {
  // Seed from the cache so a re-mounted embed (the preview pane rebuilds its DOM
  // on every render) shows its PNG immediately instead of flashing the loading
  // pulse. The async fetch below still runs to refresh a changed drawing.
  const [src, setSrc] = useState<string | null>(() => peekExcalidrawPreview(path))
  // Whether the last render attempt came back empty (unreadable file, empty
  // scene). Only the state attribute shows it: a PDF export waits on each
  // drawing until it reads ready or error (#1078).
  const [failed, setFailed] = useState(false)
  const version = useStore((s) => s.excalidrawPreviewVersion)

  useEffect(() => {
    let cancelled = false
    // Show the cached image at once when we have one; otherwise keep whatever is
    // on screen (hold the last render) rather than blanking to the loading state
    // while the drawing re-resolves.
    const cached = peekExcalidrawPreview(path)
    if (cached) setSrc(cached)
    void getExcalidrawPreview(path).then((url) => {
      if (cancelled) return
      setSrc(url)
      setFailed(url == null)
    })
    return () => {
      cancelled = true
    }
  }, [path, version])

  const style: CSSProperties = {}
  if (width) style.maxWidth = `${width}px`
  if (height) style.maxHeight = `${height}px`

  if (!src) {
    return (
      <div
        className={`excalidraw-embed-loading${className ? ' ' + className : ''}`}
        style={style}
        aria-label="Loading drawing preview"
        data-excalidraw-state={failed ? 'error' : 'loading'}
      />
    )
  }

  return (
    <img
      src={src}
      data-excalidraw-state="ready"
      className={`excalidraw-embed-image${className ? ' ' + className : ''}`}
      style={style}
      alt=""
      loading="lazy"
      draggable={false}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onContextMenu={(e) => {
        // Show the drawing-specific menu instead of the editor's text menu.
        e.preventDefault()
        e.stopPropagation()
        window.dispatchEvent(
          new CustomEvent('zen:excalidraw-embed-menu', {
            detail: { path, x: e.clientX, y: e.clientY }
          })
        )
      }}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onClick()
              }
            }
          : undefined
      }
    />
  )
}
