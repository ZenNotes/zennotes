// @vitest-environment jsdom
import { history, undo } from '@codemirror/commands'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MIN_IMAGE_WIDTH,
  attachImageResizeHandle,
  clampImageWidth,
  parseImageWidthInput,
  setImageWidthAtCursor,
  setImageWidthOnLine
} from './image-resize'

function editor(doc: string, cursor: number): EditorView {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: [history()]
    })
  })
}

describe('clampImageWidth', () => {
  it('rounds and keeps the width between the minimum and the pane', () => {
    expect(clampImageWidth(300.4, 900)).toBe(300)
    expect(clampImageWidth(10, 900)).toBe(MIN_IMAGE_WIDTH)
    expect(clampImageWidth(2000, 900.7)).toBe(900)
    // A pane narrower than the minimum still yields the minimum, never 0.
    expect(clampImageWidth(200, 0)).toBe(MIN_IMAGE_WIDTH)
  })
})

describe('parseImageWidthInput', () => {
  it('reads pixels, strips px, and treats empty or auto as "no hint"', () => {
    expect(parseImageWidthInput('480')).toBe(480)
    expect(parseImageWidthInput(' 480px ')).toBe(480)
    expect(parseImageWidthInput('')).toBeNull()
    expect(parseImageWidthInput('auto')).toBeNull()
    expect(parseImageWidthInput('0')).toBeNull()
  })
  it('flags text that is not a width', () => {
    expect(parseImageWidthInput('wide')).toBeUndefined()
    expect(parseImageWidthInput('480x300')).toBeUndefined()
    expect(parseImageWidthInput('-20')).toBeUndefined()
  })
})

describe('setImageWidthOnLine / setImageWidthAtCursor', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('rewrites the hint on the image line as one undoable edit', () => {
    const view = editor('# Title\n![[pic.png|300]]\nafter', 12)
    expect(setImageWidthAtCursor(view, 480)).toBe('resized')
    expect(view.state.doc.line(2).text).toBe('![[pic.png|480]]')
    expect(view.state.doc.line(1).text).toBe('# Title')
    expect(view.state.doc.line(3).text).toBe('after')
    undo(view)
    expect(view.state.doc.line(2).text).toBe('![[pic.png|300]]')
    view.destroy()
  })

  it('strips the hint with null and reports a no-op', () => {
    const view = editor('![caption|300](pic.png)', 0)
    expect(setImageWidthOnLine(view, 1, null)).toBe('resized')
    expect(view.state.doc.line(1).text).toBe('![caption](pic.png)')
    expect(setImageWidthOnLine(view, 1, null)).toBe('unchanged')
    view.destroy()
  })

  it('leaves lines that are not standalone images alone', () => {
    const view = editor('plain text\n![[pic.png]]', 3)
    expect(setImageWidthAtCursor(view, 480)).toBe('not-an-image')
    expect(setImageWidthOnLine(view, 99, 480)).toBe('not-an-image')
    expect(view.state.doc.toString()).toBe('plain text\n![[pic.png]]')
    view.destroy()
  })
})

describe('attachImageResizeHandle', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  type Fixture = {
    figure: HTMLElement
    image: HTMLImageElement
    handle: HTMLElement
    badge: HTMLElement
    onCommit: ReturnType<typeof vi.fn>
  }

  function fixture(maxWidth = 900): Fixture {
    const figure = document.createElement('figure')
    figure.draggable = true
    const image = document.createElement('img')
    image.style.width = '300px'
    // jsdom lays nothing out; the drag reads the rendered width from here.
    image.getBoundingClientRect = () => ({ width: 300 }) as DOMRect
    const handle = document.createElement('div')
    const badge = document.createElement('span')
    figure.append(image, handle, badge)
    document.body.appendChild(figure)
    const onCommit = vi.fn()
    attachImageResizeHandle({
      handle,
      image,
      figure,
      badge,
      maxWidth: () => maxWidth,
      onCommit
    })
    return { figure, image, handle, badge, onCommit }
  }

  // jsdom may lack PointerEvent; the handler only reads clientX, button and
  // pointerId, which a MouseEvent carries (pointerId stays undefined on both
  // sides of the comparison).
  const Pointer = (globalThis as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent
  const pointer = (type: string, clientX: number, extra: MouseEventInit = {}): Event =>
    new Pointer(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX,
      ...extra
    })

  it('resizes live while dragging and writes the width once on release', () => {
    const f = fixture()
    const down = pointer('pointerdown', 100)
    f.handle.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
    expect(f.figure.classList.contains('is-resizing')).toBe(true)
    expect(f.figure.draggable).toBe(false)

    f.handle.dispatchEvent(pointer('pointermove', 180))
    expect(f.image.style.width).toBe('380px')
    expect(f.badge.textContent).toBe('380 px')
    expect(f.onCommit).not.toHaveBeenCalled()

    f.handle.dispatchEvent(pointer('pointerup', 180))
    expect(f.onCommit).toHaveBeenCalledWith(380)
    expect(f.onCommit).toHaveBeenCalledTimes(1)
    expect(f.figure.classList.contains('is-resizing')).toBe(false)
    expect(f.figure.draggable).toBe(true)
  })

  it('clamps to the pane and the minimum', () => {
    const f = fixture(500)
    f.handle.dispatchEvent(pointer('pointerdown', 100))
    f.handle.dispatchEvent(pointer('pointermove', 900))
    expect(f.image.style.width).toBe('500px')
    f.handle.dispatchEvent(pointer('pointermove', -900))
    expect(f.image.style.width).toBe(`${MIN_IMAGE_WIDTH}px`)
    f.handle.dispatchEvent(pointer('pointerup', -900))
    expect(f.onCommit).toHaveBeenCalledWith(MIN_IMAGE_WIDTH)
  })

  it('treats a click, a release in place, or a cancel as no resize', () => {
    const f = fixture()
    f.handle.dispatchEvent(pointer('pointerdown', 100))
    f.handle.dispatchEvent(pointer('pointerup', 100))
    expect(f.onCommit).not.toHaveBeenCalled()
    expect(f.image.style.width).toBe('300px')

    f.handle.dispatchEvent(pointer('pointerdown', 100))
    f.handle.dispatchEvent(pointer('pointermove', 250))
    expect(f.image.style.width).toBe('450px')
    f.handle.dispatchEvent(pointer('pointercancel', 250))
    expect(f.onCommit).not.toHaveBeenCalled()
    expect(f.image.style.width).toBe('300px')
    expect(f.figure.draggable).toBe(true)
  })

  it('ignores secondary buttons and never starts the block drag', () => {
    const f = fixture()
    f.handle.dispatchEvent(pointer('pointerdown', 100, { button: 2 }))
    expect(f.figure.classList.contains('is-resizing')).toBe(false)
    const dragstart = new Event('dragstart', {
      bubbles: true,
      cancelable: true
    })
    f.handle.dispatchEvent(dragstart)
    expect(dragstart.defaultPrevented).toBe(true)
  })
})
