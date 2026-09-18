// @vitest-environment jsdom
import type { DragEvent } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readDragPayload, type DragPayload } from './dnd'
import { setSidebarDragPayload } from './sidebar-drag-preview'

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('sidebar drag preview', () => {
  it.each([
    { edge: 'top', top: 80, clientY: 110 },
    { edge: 'bottom', top: 280, clientY: 290 }
  ])('uses the full row outside the scroller when clipped at the $edge', ({ top, clientY }) => {
    const scroller = document.createElement('div')
    scroller.style.cssText = 'overflow: auto; height: 200px'
    const row = document.createElement('button')
    row.dataset.sidebarIdx = '12'
    row.id = 'note-row'
    row.style.paddingLeft = '32px'
    row.style.color = 'rgb(120, 80, 40)'
    row.innerHTML = '<span data-sidebar-path="inbox/note.md">My note</span>'
    scroller.appendChild(row)
    document.body.appendChild(scroller)
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(new DOMRect(12, top, 280, 36))
    const original = row.outerHTML
    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => frames.push(callback))
    const setDragImage = vi.fn()
    const data = new Map<string, string>()
    const event = {
      currentTarget: row,
      clientX: 92,
      clientY,
      dataTransfer: { setDragImage, setData: (type: string, value: string) => data.set(type, value) }
    } as unknown as DragEvent

    setSidebarDragPayload(event, { kind: 'note', path: 'inbox/note.md' })

    const [preview, x, y] = setDragImage.mock.calls[0] as [HTMLElement, number, number]
    expect(preview).not.toBe(row)
    expect(preview.parentElement).toBe(document.body)
    expect(preview.textContent).toBe('My note')
    expect(preview.style.width).toBe('280px')
    expect(preview.style.height).toBe('36px')
    expect(preview.style.paddingLeft).toBe('32px')
    expect(preview.style.color).toBe('rgb(120, 80, 40)')
    expect([x, y]).toEqual([80, clientY - top])
    expect(preview.querySelector('[data-sidebar-path]')).toBeNull()
    expect(document.querySelectorAll('[data-sidebar-idx]')).toHaveLength(1)
    expect(document.querySelectorAll('#note-row')).toHaveLength(1)
    expect(row.outerHTML).toBe(original)
    expect(row.parentElement).toBe(scroller)

    expect(preview.isConnected).toBe(true)
    frames.forEach((callback) => callback(0))
    expect(preview.isConnected).toBe(false)
    expect(row.isConnected).toBe(true)
  })

  it.each<DragPayload>([
    { kind: 'note', path: 'inbox/note.md' },
    { kind: 'asset', path: 'inbox/image.png' },
    { kind: 'folder', folder: 'inbox', subpath: 'Nested' },
    { kind: 'multi', items: [{ kind: 'note', path: 'inbox/a.md' }, { kind: 'note', path: 'inbox/b.md' }] }
  ])('preserves the $kind payload and operation', (payload) => {
    const row = document.createElement('div')
    document.body.appendChild(row)
    const data = new Map<string, string>()
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
    const event = {
      currentTarget: row,
      clientX: 0,
      clientY: 0,
      dataTransfer: {
        setDragImage: vi.fn(),
        setData: (type: string, value: string) => data.set(type, value),
        getData: (type: string) => data.get(type) ?? ''
      }
    } as unknown as DragEvent

    setSidebarDragPayload(event, payload)

    expect(readDragPayload(event)).toEqual(payload)
    expect(event.dataTransfer.effectAllowed).toBe(payload.kind === 'asset' ? 'copy' : 'move')
  })
})
