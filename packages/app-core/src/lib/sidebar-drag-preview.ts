import type { DragEvent } from 'react'
import { setDragPayload, type DragPayload } from './dnd'

export function setSidebarDragPayload(event: DragEvent, payload: DragPayload): void {
  setDragPayload(event, payload)

  const source = event.currentTarget as HTMLElement
  const rect = source.getBoundingClientRect()
  const preview = source.cloneNode(true) as HTMLElement
  const originals = [source, ...source.querySelectorAll<HTMLElement | SVGElement>('*')]
  const copies = [preview, ...preview.querySelectorAll<HTMLElement | SVGElement>('*')]

  // The native snapshot inherits the scroller's clip. Freeze the row's rendered
  // appearance (including inherited fonts and hover styles) before moving its
  // copy outside that clipping context.
  originals.forEach((original, index) => {
    const copy = copies[index]
    const style = getComputedStyle(original)
    for (const property of Array.from(style)) {
      copy.style.setProperty(property, style.getPropertyValue(property))
    }
    copy.style.transition = 'none'
    copy.style.animation = 'none'
    for (const attribute of Array.from(copy.attributes)) {
      if (attribute.name === 'id' || attribute.name.startsWith('data-sidebar-')) {
        copy.removeAttribute(attribute.name)
      }
    }
  })

  Object.assign(preview.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    margin: '0',
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    boxSizing: 'border-box',
    pointerEvents: 'none',
    zIndex: '2147483647'
  })
  preview.setAttribute('aria-hidden', 'true')
  preview.inert = true
  document.body.appendChild(preview)
  event.dataTransfer.setDragImage(preview, event.clientX - rect.left, event.clientY - rect.top)

  // Chromium captures the drag image after dragstart, before the next frame.
  // Removing it in that frame also keeps the temporary copy from flashing.
  requestAnimationFrame(() => preview.remove())
}
