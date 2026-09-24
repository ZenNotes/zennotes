// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDragAutoScroller,
  DRAG_AUTOSCROLL_BAND,
  DRAG_AUTOSCROLL_MAX_SPEED,
  edgeScrollVelocity
} from './drag-autoscroll'

describe('edgeScrollVelocity (#838)', () => {
  it('is still between the bands', () => {
    expect(edgeScrollVelocity(500, 0, 1000)).toBe(0)
    expect(edgeScrollVelocity(DRAG_AUTOSCROLL_BAND, 0, 1000)).toBe(0)
    expect(edgeScrollVelocity(1000 - DRAG_AUTOSCROLL_BAND, 0, 1000)).toBe(0)
  })

  it('scrolls toward the edge the pointer is near, faster the deeper it sits', () => {
    const shallow = edgeScrollVelocity(1000 - DRAG_AUTOSCROLL_BAND / 4, 0, 1000)
    const deep = edgeScrollVelocity(999, 0, 1000)
    expect(shallow).toBeGreaterThan(0)
    expect(deep).toBeGreaterThan(shallow)
    expect(edgeScrollVelocity(DRAG_AUTOSCROLL_BAND / 4, 0, 1000)).toBe(-shallow)
  })

  it('holds the top speed at and past the edge, so an overshoot keeps going', () => {
    expect(edgeScrollVelocity(1000, 0, 1000)).toBe(DRAG_AUTOSCROLL_MAX_SPEED)
    expect(edgeScrollVelocity(1400, 0, 1000)).toBe(DRAG_AUTOSCROLL_MAX_SPEED)
    expect(edgeScrollVelocity(-300, 0, 1000)).toBe(-DRAG_AUTOSCROLL_MAX_SPEED)
  })

  it('keeps a dead zone in the middle of a scroller narrower than two bands', () => {
    // 90px wide: the bands shrink to a third each, so the middle third is still.
    expect(edgeScrollVelocity(45, 0, 90)).toBe(0)
    expect(edgeScrollVelocity(10, 0, 90)).toBeLessThan(0)
    expect(edgeScrollVelocity(80, 0, 90)).toBeGreaterThan(0)
  })

  it('never scrolls a scroller with no size', () => {
    expect(edgeScrollVelocity(0, 0, 0)).toBe(0)
    expect(edgeScrollVelocity(5, 10, 0)).toBe(0)
  })
})

describe('createDragAutoScroller (#838)', () => {
  let frames: Map<number, FrameRequestCallback>
  let nextFrame: number
  let now: number

  beforeEach(() => {
    frames = new Map()
    nextFrame = 1
    now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = nextFrame++
      frames.set(id, callback)
      return id
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** Advance one ~60 Hz frame; true if a frame was waiting. */
  function frame(ms = 16): boolean {
    const [id, callback] = frames.entries().next().value ?? []
    if (id === undefined || !callback) return false
    frames.delete(id)
    now += ms
    callback(now)
    return true
  }

  /** A scroller of `size` px showing `view` px, laid out at 0..view on both axes. */
  function scroller(size: number, view: number): HTMLElement {
    const el = document.createElement('div')
    let left = 0
    let top = 0
    const clamp = (value: number): number => Math.max(0, Math.min(size - view, Math.round(value)))
    Object.defineProperties(el, {
      scrollWidth: { value: size },
      clientWidth: { value: view },
      scrollHeight: { value: size },
      clientHeight: { value: view },
      scrollLeft: { get: () => left, set: (value: number) => (left = clamp(value)) },
      scrollTop: { get: () => top, set: (value: number) => (top = clamp(value)) }
    })
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, view, view))
    return el
  }

  it('keeps scrolling while the pointer rests in a band, with no further moves', () => {
    const board = scroller(3000, 1000)
    const autoScroll = createDragAutoScroller({ horizontal: () => board })
    autoScroll.update(995, 500)
    for (let i = 0; i < 30; i++) frame()
    expect(board.scrollLeft).toBeGreaterThan(300)
    expect(frames.size).toBe(1)
  })

  it('scrolls back toward the start from the start band', () => {
    const board = scroller(3000, 1000)
    board.scrollLeft = 2000
    const autoScroll = createDragAutoScroller({ horizontal: () => board })
    autoScroll.update(3, 500)
    for (let i = 0; i < 10; i++) frame()
    expect(board.scrollLeft).toBeLessThan(2000)
  })

  it('does nothing, and stops asking for frames, between the bands', () => {
    const board = scroller(3000, 1000)
    const autoScroll = createDragAutoScroller({ horizontal: () => board })
    autoScroll.update(500, 500)
    expect(frame()).toBe(true)
    expect(board.scrollLeft).toBe(0)
    expect(frames.size).toBe(0)
  })

  it('stops once the scroller runs out of room', () => {
    const board = scroller(1200, 1000)
    const autoScroll = createDragAutoScroller({ horizontal: () => board })
    autoScroll.update(1000, 500)
    for (let i = 0; i < 60 && frame(); i++);
    expect(board.scrollLeft).toBe(200)
    expect(frames.size).toBe(0)
  })

  it('carries sub-pixel steps, so the slow edge of the band still creeps', () => {
    const board = scroller(3000, 1000)
    const autoScroll = createDragAutoScroller({ horizontal: () => board })
    // Barely inside the band: well under one pixel per frame.
    autoScroll.update(1000 - DRAG_AUTOSCROLL_BAND + 2, 500)
    frame()
    expect(board.scrollLeft).toBe(0)
    for (let i = 0; i < 120; i++) frame()
    expect(board.scrollLeft).toBeGreaterThan(0)
  })

  it('caps a stalled frame instead of jumping by the whole gap', () => {
    const board = scroller(30000, 1000)
    const autoScroll = createDragAutoScroller({ horizontal: () => board })
    autoScroll.update(1000, 500)
    frame(5000)
    expect(board.scrollLeft).toBeLessThanOrEqual(DRAG_AUTOSCROLL_MAX_SPEED * 0.05)
  })

  it('scrolls the vertical target resolved under the pointer', () => {
    const board = scroller(3000, 1000)
    const column = scroller(2000, 500)
    const vertical = vi.fn(() => column)
    const autoScroll = createDragAutoScroller({ horizontal: () => board, vertical })
    autoScroll.update(250, 495)
    for (let i = 0; i < 10; i++) frame()
    expect(column.scrollTop).toBeGreaterThan(0)
    expect(board.scrollLeft).toBe(0)
    expect(vertical).toHaveBeenLastCalledWith(250, 495)
  })

  it('follows the latest pointer position', () => {
    const board = scroller(3000, 1000)
    const autoScroll = createDragAutoScroller({ horizontal: () => board })
    autoScroll.update(995, 500)
    for (let i = 0; i < 5; i++) frame()
    const scrolled = board.scrollLeft
    expect(scrolled).toBeGreaterThan(0)
    autoScroll.update(500, 500)
    frame()
    expect(board.scrollLeft).toBe(scrolled)
    expect(frames.size).toBe(0)
  })

  it('stop() cancels the pending frame and ignores late frames', () => {
    const board = scroller(3000, 1000)
    const autoScroll = createDragAutoScroller({ horizontal: () => board })
    autoScroll.update(995, 500)
    frame()
    const scrolled = board.scrollLeft
    autoScroll.stop()
    expect(frames.size).toBe(0)
    expect(frame()).toBe(false)
    expect(board.scrollLeft).toBe(scrolled)
  })
})
