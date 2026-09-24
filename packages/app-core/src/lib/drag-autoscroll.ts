/**
 * Edge auto-scroll for pointer-driven drags (#838).
 *
 * The Kanban board moves cards and columns with pointer events rather than
 * HTML5 drag-and-drop, so it gets none of the browser's built-in drag
 * autoscroll: a board wider than its pane could never carry a card to an
 * off-screen column in one drag. Holding the pointer in a band along a
 * scroller's edge scrolls it, faster the deeper the pointer sits. A resting
 * mouse sends no pointermove, so a frame loop keeps the scroll going until the
 * pointer leaves the band, the scroller runs out of room, or the drag ends.
 */

/** Depth of the hot band inside a scroller's edge, in CSS pixels. */
export const DRAG_AUTOSCROLL_BAND = 64
/** Scroll speed with the pointer at (or past) the edge, in CSS pixels per second. */
export const DRAG_AUTOSCROLL_MAX_SPEED = 1200

/**
 * Signed velocity, in px/s, along one axis for a pointer at `pointer` over a
 * scroller spanning `start`..`end`: negative toward `start`, positive toward
 * `end`, zero between the two bands. The speed eases in with depth, so skimming
 * the band nudges and pushing into the edge races. Past the edge it holds the
 * maximum, so overshooting into the sidebar or a neighbouring pane keeps going.
 */
export function edgeScrollVelocity(
  pointer: number,
  start: number,
  end: number,
  band = DRAG_AUTOSCROLL_BAND,
  maxSpeed = DRAG_AUTOSCROLL_MAX_SPEED
): number {
  // A narrow scroller keeps a dead zone in the middle, or every spot would scroll.
  const depth = Math.min(band, (end - start) / 3)
  if (!(depth > 0)) return 0
  const intoStart = start + depth - pointer
  if (intoStart > 0) return -maxSpeed * Math.min(1, intoStart / depth) ** 2
  const intoEnd = pointer - (end - depth)
  if (intoEnd > 0) return maxSpeed * Math.min(1, intoEnd / depth) ** 2
  return 0
}

export interface DragAutoScrollTargets {
  /** Scrolled sideways by the pointer's x. The pointer may be past its edges. */
  horizontal?: () => HTMLElement | null
  /** Scrolled up and down by the pointer's y, resolved under the pointer each frame. */
  vertical?: (clientX: number, clientY: number) => HTMLElement | null
}

export interface DragAutoScroller {
  /** The drag moved: remember where, and scroll while that spot is in a band. */
  update(clientX: number, clientY: number): void
  /** The drag ended: stop scrolling and forget the pointer. */
  stop(): void
}

type Axis = 'x' | 'y'

export function createDragAutoScroller(targets: DragAutoScrollTargets): DragAutoScroller {
  let point: { x: number; y: number } | null = null
  let frame: number | null = null
  let lastTime = 0
  // Sub-pixel remainders per axis. At the slow end of the ramp a frame asks
  // for a fraction of a pixel, which the scroll offset would round away every
  // single frame, so the band's inner edge would never move at all.
  const carry: Record<Axis, number> = { x: 0, y: 0 }

  /** Scrolls one frame's worth; true while this axis still wants more frames. */
  const scrollAxis = (el: HTMLElement, axis: Axis, velocity: number, seconds: number): boolean => {
    const position = axis === 'x' ? el.scrollLeft : el.scrollTop
    const limit =
      axis === 'x' ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight
    if (velocity === 0 || (velocity < 0 ? position <= 0 : position >= limit - 1)) {
      carry[axis] = 0
      return false
    }
    if (Math.sign(carry[axis]) === -Math.sign(velocity)) carry[axis] = 0
    carry[axis] += velocity * seconds
    const whole = Math.trunc(carry[axis])
    if (whole !== 0) {
      carry[axis] -= whole
      if (axis === 'x') el.scrollLeft = position + whole
      else el.scrollTop = position + whole
    }
    return true
  }

  const tick = (now: number): void => {
    frame = null
    if (!point) return
    // A stalled frame (a busy main thread, a hidden window) must not land as
    // one giant jump, so the step is capped at a short frame's worth.
    const seconds = Math.min(0.05, Math.max(0, (now - lastTime) / 1000))
    lastTime = now
    let active = false
    const horizontal = targets.horizontal?.() ?? null
    if (horizontal) {
      const rect = horizontal.getBoundingClientRect()
      const velocity = edgeScrollVelocity(point.x, rect.left, rect.right)
      active = scrollAxis(horizontal, 'x', velocity, seconds) || active
    }
    const vertical = targets.vertical?.(point.x, point.y) ?? null
    if (vertical) {
      const rect = vertical.getBoundingClientRect()
      const velocity = edgeScrollVelocity(point.y, rect.top, rect.bottom)
      active = scrollAxis(vertical, 'y', velocity, seconds) || active
    } else {
      carry.y = 0
    }
    if (active) frame = requestAnimationFrame(tick)
  }

  return {
    update(clientX, clientY) {
      point = { x: clientX, y: clientY }
      if (frame !== null) return
      lastTime = performance.now()
      frame = requestAnimationFrame(tick)
    },
    stop() {
      point = null
      if (frame !== null) cancelAnimationFrame(frame)
      frame = null
      carry.x = 0
      carry.y = 0
    }
  }
}
