/**
 * Imperative pan & zoom for *inline* diagram surfaces in the markdown
 * preview (mermaid + TikZ). The expanded modal has its own React
 * implementation (`DiagramPanZoomFrame` in Preview.tsx); this helper reuses
 * the same math from `diagram-pan-zoom.ts` for the plain DOM nodes that the
 * preview re-creates on every markdown render.
 *
 * Interactions are deliberately scroll-safe:
 *   - Cmd/Ctrl + wheel (and trackpad pinch, which browsers report as a
 *     ctrlKey wheel) zooms at the cursor.
 *   - A bare wheel keeps scrolling the note exactly as before.
 *   - Dragging pans once the diagram is zoomed; double-click resets.
 *   - Clicking a diagram focuses it, after which `+` / `-` / `0` work,
 *     matching the expanded view's keyboard map.
 *   - A small percentage pill appears while transformed; clicking it resets.
 *
 * JSXGraph and function-plot blocks are NOT wired through this helper —
 * both libraries ship their own native mouse interactions.
 */
import {
  diagramZoomLabel,
  stepDiagramZoom,
  zoomDiagramAtPoint,
  zoomFromWheelDelta,
  type DiagramPanZoomState
} from './diagram-pan-zoom'

const IDENTITY: DiagramPanZoomState = { zoom: 1, pan: { x: 0, y: 0 } }

function isIdentity(state: DiagramPanZoomState): boolean {
  return state.zoom === 1 && state.pan.x === 0 && state.pan.y === 0
}

/**
 * Wrap the already-rendered children of `viewport` in a transformable
 * content layer and wire up wheel/drag/keyboard pan-zoom. Safe to call once
 * per render pass — the preview rebuilds the surface DOM on each render, so
 * listeners die with their nodes and state intentionally resets.
 */
export function attachInlineDiagramPanZoom(viewport: HTMLElement): void {
  if (viewport.dataset.zenInlinePanZoom === 'true') return
  viewport.dataset.zenInlinePanZoom = 'true'

  // The content layer fills the viewport, so viewport coordinates and
  // content layout coordinates coincide — that keeps the shared
  // zoom-at-cursor math exact without any offset bookkeeping.
  const content = document.createElement('div')
  content.className = 'zen-diagram-inline-content'
  while (viewport.firstChild) content.appendChild(viewport.firstChild)
  viewport.appendChild(content)

  // Always-visible zoom controls: [−] [100%] [+]. The percentage label
  // doubles as the reset button.
  const controls = document.createElement('div')
  controls.className = 'zen-diagram-zoom-controls'
  controls.title = 'Cmd/Ctrl+scroll to zoom · drag to pan · double-click to reset'
  const makeButton = (text: string, label: string, extraClass?: string): HTMLButtonElement => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.textContent = text
    btn.setAttribute('aria-label', label)
    btn.title = label
    if (extraClass) btn.classList.add(extraClass)
    controls.appendChild(btn)
    return btn
  }
  const zoomOutButton = makeButton('−', 'Zoom out')
  const zoomLabel = makeButton('100%', 'Reset zoom', 'zen-diagram-zoom-label')
  const zoomInButton = makeButton('+', 'Zoom in')

  // Sit next to the Expand button in the diagram toolbar; fall back to an
  // in-surface overlay if a host renders a surface without a toolbar.
  const toolbar = viewport.parentElement?.querySelector<HTMLElement>(
    ':scope > .zen-diagram-toolbar'
  )
  if (toolbar) toolbar.insertBefore(controls, toolbar.firstChild)
  else viewport.appendChild(controls)

  // Focusable by click only — dozens of diagrams must not pollute tab order.
  viewport.tabIndex = -1

  let state: DiagramPanZoomState = IDENTITY

  const apply = (): void => {
    zoomLabel.textContent = diagramZoomLabel(state.zoom)
    if (isIdentity(state)) {
      content.style.transform = ''
      viewport.classList.remove('zen-diagram-inline-zoomed')
      return
    }
    content.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`
    viewport.classList.add('zen-diagram-inline-zoomed')
  }

  const reset = (): void => {
    state = IDENTITY
    apply()
  }

  const zoomFromCenter = (direction: 1 | -1): void => {
    const rect = viewport.getBoundingClientRect()
    state = zoomDiagramAtPoint(state, stepDiagramZoom(state.zoom, direction), {
      x: rect.width / 2,
      y: rect.height / 2
    })
    apply()
  }

  viewport.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      // Bare wheel keeps scrolling the note; only modified wheel zooms.
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      e.stopPropagation()
      const rect = viewport.getBoundingClientRect()
      const point = { x: e.clientX - rect.left, y: e.clientY - rect.top }
      state = zoomDiagramAtPoint(state, zoomFromWheelDelta(state.zoom, e.deltaY), point)
      apply()
    },
    { passive: false }
  )

  let dragging = false
  let dragStart = { x: 0, y: 0 }
  let panStart = { x: 0, y: 0 }

  viewport.addEventListener('pointerdown', (e: PointerEvent) => {
    viewport.focus({ preventScroll: true })
    if (e.button !== 0) return
    if (controls.contains(e.target as Node)) return
    if (isIdentity(state)) return
    dragging = true
    dragStart = { x: e.clientX, y: e.clientY }
    panStart = { ...state.pan }
    try {
      viewport.setPointerCapture?.(e.pointerId)
    } catch {
      /* jsdom / detached nodes — capture is an enhancement, not required */
    }
    e.preventDefault()
  })

  viewport.addEventListener('pointermove', (e: PointerEvent) => {
    if (!dragging) return
    state = {
      zoom: state.zoom,
      pan: {
        x: panStart.x + (e.clientX - dragStart.x),
        y: panStart.y + (e.clientY - dragStart.y)
      }
    }
    apply()
  })

  const endDrag = (e: PointerEvent): void => {
    if (!dragging) return
    dragging = false
    try {
      if (viewport.hasPointerCapture?.(e.pointerId)) {
        viewport.releasePointerCapture(e.pointerId)
      }
    } catch {
      /* see above */
    }
  }
  viewport.addEventListener('pointerup', endDrag)
  viewport.addEventListener('pointercancel', endDrag)

  viewport.addEventListener('dblclick', (e: MouseEvent) => {
    if (isIdentity(state)) return
    e.preventDefault()
    reset()
  })

  viewport.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === '+' || e.key === '=') {
      e.preventDefault()
      zoomFromCenter(1)
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault()
      zoomFromCenter(-1)
    } else if (e.key === '0') {
      e.preventDefault()
      reset()
    }
  })

  // Keep clicks (and rapid double-clicks) on the controls from reaching the
  // viewport's drag / dblclick-reset handlers.
  controls.addEventListener('dblclick', (e: MouseEvent) => e.stopPropagation())
  zoomInButton.addEventListener('click', (e: MouseEvent) => {
    e.stopPropagation()
    zoomFromCenter(1)
  })
  zoomOutButton.addEventListener('click', (e: MouseEvent) => {
    e.stopPropagation()
    zoomFromCenter(-1)
  })
  zoomLabel.addEventListener('click', (e: MouseEvent) => {
    e.stopPropagation()
    reset()
  })
}
