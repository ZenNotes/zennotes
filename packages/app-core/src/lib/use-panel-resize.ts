import { useCallback, useState, type MouseEvent as ReactMouseEvent } from 'react'

/**
 * Drag-to-resize for a RIGHT-side editor panel (outline, connections,
 * comments). The handle lives on the panel's LEFT edge, so dragging left grows
 * the panel and dragging right shrinks it — mirroring the pinned reference
 * pane. Width clamping is handled by the store setter.
 */
export function usePanelResize(
  width: number,
  setWidth: (px: number) => void
): { resizing: boolean; startResize: (e: ReactMouseEvent<HTMLElement>) => void } {
  const [resizing, setResizing] = useState(false)
  const startResize = useCallback(
    (e: ReactMouseEvent<HTMLElement>) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = width
      setResizing(true)
      const onMove = (ev: MouseEvent): void => {
        setWidth(startWidth + (startX - ev.clientX))
      }
      const onUp = (): void => {
        setResizing(false)
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [width, setWidth]
  )
  return { resizing, startResize }
}

/**
 * Drag-to-resize for a LEFT-side panel (cheatsheet). The handle lives on the
 * panel's RIGHT edge, so dragging RIGHT grows the panel and dragging LEFT
 * shrinks it — opposite of right-side panels.
 */
export function useLeftPanelResize(
  width: number,
  setWidth: (px: number) => void
): { resizing: boolean; startResize: (e: ReactMouseEvent<HTMLElement>) => void } {
  const [resizing, setResizing] = useState(false)
  const startResize = useCallback(
    (e: ReactMouseEvent<HTMLElement>) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = width
      setResizing(true)
      const onMove = (ev: MouseEvent): void => {
        // For left panel: dragging right (ev.clientX > startX) should increase width
        setWidth(startWidth + (ev.clientX - startX))
      }
      const onUp = (): void => {
        setResizing(false)
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [width, setWidth]
  )
  return { resizing, startResize }
}
