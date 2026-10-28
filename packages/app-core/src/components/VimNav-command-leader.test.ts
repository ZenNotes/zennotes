// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../store'
import { useToastStore } from '../lib/toast'
import { VimNav } from './VimNav'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// A command's leader sequence runs through VimNav's leader, after every
// built-in leader key, and shows in the which-key hints (#971).

function installZen(): void {
  Object.defineProperty(window, 'zen', {
    configurable: true,
    value: {
      platformSync: () => 'darwin',
      getAppInfo: vi.fn().mockReturnValue({ runtime: 'desktop' }),
      getCapabilities: vi.fn().mockReturnValue({
        supportsLocalFilesystemPickers: true,
        supportsRemoteWorkspace: false
      })
    }
  })
}

function press(key: string, code: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...init })
  act(() => {
    document.body.dispatchEvent(event)
  })
  return event
}

const archivable = { folder: 'inbox', path: 'inbox/A.md', title: 'A', body: '' } as never

describe('command leader sequences in VimNav', () => {
  let host: HTMLDivElement
  let root: Root
  let originalState: ReturnType<typeof useStore.getState>

  beforeEach(() => {
    installZen()
    originalState = useStore.getState()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    useToastStore.setState({ toasts: [] })
    useStore.setState({
      vimMode: true,
      whichKeyHints: true,
      whichKeyHintMode: 'sticky',
      focusedPanel: 'sidebar',
      activeNote: archivable,
      commandKeymaps: { 'note.archive': 'Leader x a', 'note.trash': 'Leader x t' }
    } as never)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    document.body.innerHTML = ''
    useStore.setState(originalState, true)
  })

  it('runs the command at the end of its sequence', async () => {
    const archiveActive = vi.fn().mockResolvedValue(undefined)
    useStore.setState({ archiveActive } as never)
    act(() => root.render(createElement(VimNav)))
    press(' ', 'Space')
    expect(press('x', 'KeyX').defaultPrevented).toBe(true)
    press('a', 'KeyA')
    await vi.waitFor(() => expect(archiveActive).toHaveBeenCalled())
  })

  it('lists the sequences in the leader hints, then the keys that follow', () => {
    act(() => root.render(createElement(VimNav)))
    press(' ', 'Space')
    expect(document.body.textContent).toContain('2 commands')
    press('x', 'KeyX')
    expect(document.body.textContent).toContain('Leader · Commands')
    expect(document.body.textContent).toContain('Move Note to Archive')
    expect(document.body.textContent).toContain('Move Note to Trash')
  })

  it('leaves a built-in leader key alone even when a sequence would start there', () => {
    // A hand-made state the loader would refuse: a command on `Space o x`.
    useStore.setState({ commandKeymaps: { 'note.archive': 'Leader o x' } })
    act(() => root.render(createElement(VimNav)))
    press(' ', 'Space')
    press('o', 'KeyO')
    // `Space o` is the buffer switcher, and it won.
    expect(useStore.getState().bufferPaletteOpen).toBe(true)
  })

  it('says why when the command cannot run, and runs nothing', async () => {
    const restoreActive = vi.fn()
    useStore.setState({ restoreActive, commandKeymaps: { 'note.restore': 'Leader z' } } as never)
    act(() => root.render(createElement(VimNav)))
    press(' ', 'Space')
    press('z', 'KeyZ')
    await vi.waitFor(() =>
      expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
        'Restore from Trash only works on a note in the Trash'
      ])
    )
    expect(restoreActive).not.toHaveBeenCalled()
  })

  it('is inert with Vim mode off', async () => {
    const archiveActive = vi.fn()
    useStore.setState({ vimMode: false, archiveActive } as never)
    act(() => root.render(createElement(VimNav)))
    press(' ', 'Space')
    press('x', 'KeyX')
    press('a', 'KeyA')
    await Promise.resolve()
    expect(archiveActive).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('Leader')
  })
})
