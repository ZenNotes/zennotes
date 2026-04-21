import { useCallback, useRef } from 'react'

/**
 * Thin vertical grabber along the right edge of a panel. Reports new
 * widths via `onResize` on every mousemove; the parent decides how to
 * clamp + persist.
 *
 * Usage: place the panel with `position: relative` and render
 * `<ResizeHandle getWidth={...} onResize={...} />` as its last child.
 */
export function ResizeHandle({
  getWidth,
  onResize
}: {
  getWidth: () => number
  onResize: (nextWidth: number) => void
}): JSX.Element {
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)

  const onMouseMove = useCallback(
    (e: MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      const delta = e.clientX - d.startX
      onResize(d.startW + delta)
    },
    [onResize]
  )

  const stopDrag = useCallback(() => {
    dragRef.current = null
    document.body.style.removeProperty('cursor')
    document.body.style.removeProperty('user-select')
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('mouseup', stopDrag)
  }, [onMouseMove])

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      dragRef.current = { startX: e.clientX, startW: getWidth() }
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mouseup', stopDrag)
    },
    [getWidth, onMouseMove, stopDrag]
  )

  return (
    <div
      onMouseDown={onMouseDown}
      onDoubleClick={() => onResize(0)}
      title="Drag to resize"
      className="group absolute right-0 top-0 z-10 h-full w-1 cursor-col-resize select-none"
    >
      <div className="h-full w-full opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-active:opacity-100" style={{ background: 'rgb(var(--z-accent) / 0.5)' }} />
    </div>
  )
}
