// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'

import {
  EXCALIDRAW_SURFACE,
  SELF_KEYED_SURFACES,
  releaseSelfKeyedSurfaceFocus
} from './self-keyed-surfaces'

afterEach(() => {
  document.body.innerHTML = ''
})

function mount(html: string): void {
  document.body.innerHTML = html
}

describe('releaseSelfKeyedSurfaceFocus', () => {
  it('blurs a focused Excalidraw canvas so the sidebar can take the keys', () => {
    mount('<div data-excalidraw-view><div class="excalidraw-container" tabindex="0"></div></div>')
    const canvas = document.querySelector<HTMLElement>('.excalidraw-container')!
    canvas.focus()
    expect(document.activeElement).toBe(canvas)
    releaseSelfKeyedSurfaceFocus()
    expect(document.activeElement).toBe(document.body)
  })

  it("keeps Excalidraw's text editor focused mid-edit", () => {
    mount('<div data-excalidraw-view><textarea class="excalidraw-wysiwyg"></textarea></div>')
    const editor = document.querySelector<HTMLElement>('textarea')!
    editor.focus()
    releaseSelfKeyedSurfaceFocus()
    expect(document.activeElement).toBe(editor)
  })

  it('still blurs the self-keyed grids it always covered', () => {
    mount('<div data-zen-db-grid tabindex="0"></div>')
    const grid = document.querySelector<HTMLElement>('[data-zen-db-grid]')!
    grid.focus()
    releaseSelfKeyedSurfaceFocus()
    expect(document.activeElement).toBe(document.body)
  })

  it('leaves focus alone outside those surfaces', () => {
    mount('<button id="b">x</button>')
    const button = document.getElementById('b')!
    button.focus()
    releaseSelfKeyedSurfaceFocus()
    expect(document.activeElement).toBe(button)
  })
})

describe('EXCALIDRAW_SURFACE', () => {
  it('is not one of the surfaces VimNav yields to outright, so the leader tap, gt/gT and Ctrl+W keep working in a drawing', () => {
    expect(SELF_KEYED_SURFACES.split(', ')).not.toContain(EXCALIDRAW_SURFACE)
  })
})
