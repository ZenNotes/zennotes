// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { attachInlineDiagramPanZoom } from './inline-diagram-pan-zoom'

function makeSurface(): HTMLElement {
  const viewport = document.createElement('div')
  viewport.className = 'zen-diagram-surface'
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  viewport.appendChild(svg)
  document.body.appendChild(viewport)
  attachInlineDiagramPanZoom(viewport)
  return viewport
}

function content(viewport: HTMLElement): HTMLElement {
  const el = viewport.querySelector<HTMLElement>('.zen-diagram-inline-content')
  if (!el) throw new Error('content layer missing')
  return el
}

function controlButtons(viewport: HTMLElement): {
  zoomOut: HTMLButtonElement
  label: HTMLButtonElement
  zoomIn: HTMLButtonElement
} {
  const buttons = Array.from(
    viewport.querySelectorAll<HTMLButtonElement>('.zen-diagram-zoom-controls button')
  )
  if (buttons.length !== 3) throw new Error(`expected 3 control buttons, got ${buttons.length}`)
  return { zoomOut: buttons[0], label: buttons[1], zoomIn: buttons[2] }
}

function click(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

function wheel(viewport: HTMLElement, init: WheelEventInit): WheelEvent {
  const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init })
  viewport.dispatchEvent(e)
  return e
}

describe('attachInlineDiagramPanZoom', () => {
  it('wraps the rendered diagram and shows − / 100% / + controls', () => {
    const viewport = makeSurface()
    expect(content(viewport).querySelector('svg')).not.toBeNull()
    const { zoomOut, label, zoomIn } = controlButtons(viewport)
    expect(zoomOut.textContent).toBe('−')
    expect(label.textContent).toBe('100%')
    expect(zoomIn.textContent).toBe('+')
    expect(viewport.dataset.zenInlinePanZoom).toBe('true')
  })

  it('slots the controls into the diagram toolbar, before the Expand button', () => {
    const outer = document.createElement('div')
    const toolbar = document.createElement('div')
    toolbar.className = 'zen-diagram-toolbar'
    const expand = document.createElement('button')
    expand.className = 'zen-diagram-expand'
    toolbar.appendChild(expand)
    outer.appendChild(toolbar)
    const viewport = document.createElement('div')
    viewport.className = 'zen-diagram-surface'
    outer.appendChild(viewport)
    document.body.appendChild(outer)

    attachInlineDiagramPanZoom(viewport)

    const controls = toolbar.querySelector('.zen-diagram-zoom-controls')
    expect(controls).not.toBeNull()
    expect(controls?.nextElementSibling).toBe(expand)
    // No overlay fallback inside the surface when the toolbar exists.
    expect(viewport.querySelector('.zen-diagram-zoom-controls')).toBeNull()
  })

  it('is idempotent — attaching twice does not double-wrap', () => {
    const viewport = makeSurface()
    attachInlineDiagramPanZoom(viewport)
    expect(viewport.querySelectorAll('.zen-diagram-inline-content')).toHaveLength(1)
    expect(viewport.querySelectorAll('.zen-diagram-zoom-controls')).toHaveLength(1)
  })

  it('ignores a bare wheel so the note keeps scrolling', () => {
    const viewport = makeSurface()
    const e = wheel(viewport, { deltaY: -100 })
    expect(e.defaultPrevented).toBe(false)
    expect(content(viewport).style.transform).toBe('')
    expect(controlButtons(viewport).label.textContent).toBe('100%')
  })

  it('zooms on ctrl+wheel and updates the percentage label', () => {
    const viewport = makeSurface()
    const e = wheel(viewport, { deltaY: -100, ctrlKey: true })
    expect(e.defaultPrevented).toBe(true)
    expect(content(viewport).style.transform).toContain('scale(1.1')
    expect(controlButtons(viewport).label.textContent).toBe('110%')
    expect(viewport.classList.contains('zen-diagram-inline-zoomed')).toBe(true)
  })

  it('zooms on meta+wheel too (macOS)', () => {
    const viewport = makeSurface()
    const e = wheel(viewport, { deltaY: -100, metaKey: true })
    expect(e.defaultPrevented).toBe(true)
    expect(content(viewport).style.transform).not.toBe('')
  })

  it('+ / − buttons zoom in steps and rapid clicks never reset', () => {
    const viewport = makeSurface()
    const { zoomOut, zoomIn, label } = controlButtons(viewport)
    click(zoomIn)
    expect(content(viewport).style.transform).toContain('scale(1.2)')
    click(zoomIn)
    expect(content(viewport).style.transform).toContain('scale(1.4')
    expect(label.textContent).toBe('140%')
    click(zoomOut)
    click(zoomOut)
    expect(label.textContent).toBe('100%')
    expect(content(viewport).style.transform).toBe('')
  })

  it('clicking the percentage label resets', () => {
    const viewport = makeSurface()
    const { zoomIn, label } = controlButtons(viewport)
    click(zoomIn)
    click(label)
    expect(content(viewport).style.transform).toBe('')
    expect(label.textContent).toBe('100%')
    expect(viewport.classList.contains('zen-diagram-inline-zoomed')).toBe(false)
  })

  it('double-click on the diagram resets to identity', () => {
    const viewport = makeSurface()
    wheel(viewport, { deltaY: -100, ctrlKey: true })
    expect(content(viewport).style.transform).not.toBe('')
    viewport.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    expect(content(viewport).style.transform).toBe('')
    expect(viewport.classList.contains('zen-diagram-inline-zoomed')).toBe(false)
  })

  it('supports + / - / 0 keys like the expanded view', () => {
    const viewport = makeSurface()
    const key = (k: string): void => {
      viewport.dispatchEvent(
        new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })
      )
    }
    key('+')
    expect(content(viewport).style.transform).toContain('scale(1.2)')
    key('-')
    expect(content(viewport).style.transform).toBe('')
    key('+')
    key('0')
    expect(content(viewport).style.transform).toBe('')
    expect(controlButtons(viewport).label.textContent).toBe('100%')
  })
})
