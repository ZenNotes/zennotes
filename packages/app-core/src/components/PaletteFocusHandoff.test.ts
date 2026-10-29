// @vitest-environment jsdom

import { act, createElement, type FunctionComponent } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Which hand-off each palette asks for; the hand-offs themselves (desktop
// focuses, a reading host keeps the keyboard down) are covered in
// lib/editor-focus.test.ts.
const focusEditorNormalMode = vi.hoisted(() => vi.fn())
const focusEditorAfterReadOpen = vi.hoisted(() => vi.fn())
const focusEditorAfterPaletteClose = vi.hoisted(() => vi.fn())
vi.mock('../lib/editor-focus', () => ({
  focusEditorNormalMode,
  focusEditorAfterReadOpen,
  focusEditorAfterPaletteClose
}))

// The command palette lists whatever buildCommands gives it: stand-ins for a
// command that goes to a note already there, one that writes, and a toggle.
const goBack = vi.hoisted(() => vi.fn())
const newNote = vi.hoisted(() => vi.fn())
const toggle = vi.hoisted(() => vi.fn())
vi.mock('../lib/commands', () => ({
  buildCommands: () => [
    {
      id: 'test.read',
      title: 'Read Something',
      category: 'Go',
      run: goBack,
      opensToRead: () => true
    },
    { id: 'note.new.inbox', title: 'Write Something', category: 'Note', run: newNote },
    { id: 'view.status-bar', title: 'Toggle Something', category: 'View', run: toggle }
  ]
}))

import { CommandPalette } from './CommandPalette'
import { TemplatePalette } from './TemplatePalette'
import { EmbedDrawingPalette } from './EmbedDrawingPalette'

let host: HTMLDivElement
let root: Root
let originalScrollIntoView: PropertyDescriptor | undefined

beforeEach(() => {
  Object.defineProperty(window, 'zen', {
    configurable: true,
    value: {
      getAppInfo: () => ({ runtime: 'desktop' }),
      getCapabilities: () => ({ supportsRemoteWorkspace: false })
    }
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  for (const fn of [focusEditorNormalMode, focusEditorAfterReadOpen, focusEditorAfterPaletteClose]) {
    fn.mockClear()
  }
  goBack.mockClear()
  newNote.mockClear()
  toggle.mockClear()
  // The refocus after a command only happens when the editor was the panel
  // and nothing else is open over it.
  useStore.setState({
    focusedPanel: 'editor',
    commandPaletteOpen: false,
    templatePaletteOpen: false,
    embedDrawingPaletteOpen: false
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  if (originalScrollIntoView) {
    Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView)
  }
})

const render = (component: FunctionComponent): void => {
  act(() => root.render(createElement(component)))
}
const input = (): HTMLInputElement => document.querySelector('input') as HTMLInputElement
const type = (text: string): void => {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setValue.call(input(), text)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const key = async (name: string): Promise<void> => {
  await act(async () => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('palette hand-offs', () => {
  it('the command palette closes through the palette close hand-off', async () => {
    useStore.setState({ commandPaletteOpen: true })
    render(CommandPalette)
    await key('Escape')
    expect(useStore.getState().commandPaletteOpen).toBe(false)
    expect(focusEditorAfterPaletteClose).toHaveBeenCalledTimes(1)
    expect(focusEditorNormalMode).not.toHaveBeenCalled()
  })

  it('a command that goes to a note already there lands like a search pick', async () => {
    render(CommandPalette)
    type('Read Something')
    await key('Enter')
    expect(goBack).toHaveBeenCalledTimes(1)
    expect(focusEditorAfterReadOpen).toHaveBeenCalledTimes(1)
    expect(focusEditorNormalMode).not.toHaveBeenCalled()
  })

  it('a writing command still focuses the editor', async () => {
    render(CommandPalette)
    type('Write Something')
    await key('Enter')
    expect(newNote).toHaveBeenCalledTimes(1)
    expect(focusEditorNormalMode).toHaveBeenCalledTimes(1)
    expect(focusEditorAfterReadOpen).not.toHaveBeenCalled()
  })

  it('a toggle hands back like a close: focused on desktop, left where it was on a phone', async () => {
    render(CommandPalette)
    type('Toggle Something')
    await key('Enter')
    expect(toggle).toHaveBeenCalledTimes(1)
    expect(focusEditorAfterPaletteClose).toHaveBeenCalledTimes(1)
    expect(focusEditorNormalMode).not.toHaveBeenCalled()
    expect(focusEditorAfterReadOpen).not.toHaveBeenCalled()
  })

  it('a theme picked from Themes hands back like a close, so a phone keeps its keyboard down', async () => {
    useStore.setState({ commandPaletteOpen: true, commandPaletteInitialMode: 'theme' })
    render(CommandPalette)
    await key('Enter')
    expect(useStore.getState().commandPaletteOpen).toBe(false)
    expect(focusEditorAfterPaletteClose).toHaveBeenCalledTimes(1)
    expect(focusEditorNormalMode).not.toHaveBeenCalled()
  })

  it('the template palette closes through the palette close hand-off', async () => {
    useStore.setState({ templatePaletteOpen: true })
    render(TemplatePalette)
    await key('Escape')
    expect(useStore.getState().templatePaletteOpen).toBe(false)
    expect(focusEditorAfterPaletteClose).toHaveBeenCalledTimes(1)
    expect(focusEditorNormalMode).not.toHaveBeenCalled()
  })

  it('the drawing palette closes through the palette close hand-off', async () => {
    useStore.setState({ embedDrawingPaletteOpen: true })
    render(EmbedDrawingPalette)
    await key('Escape')
    expect(useStore.getState().embedDrawingPaletteOpen).toBe(false)
    expect(focusEditorAfterPaletteClose).toHaveBeenCalledTimes(1)
    expect(focusEditorNormalMode).not.toHaveBeenCalled()
  })
})
