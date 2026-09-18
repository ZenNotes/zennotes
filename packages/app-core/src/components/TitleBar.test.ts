// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TitleBar } from './TitleBar'

const state = vi.hoisted(() => ({
  showWindowTitleBar: true as boolean | undefined,
  vault: { name: 'Demo vault' },
  activeNote: null,
  selectedPath: null,
  systemFolderLabels: {},
  workspaceMode: 'local'
}))

vi.mock('../store', () => ({
  useStore: (select: (value: typeof state) => unknown) => select(state)
}))

describe('window title bar', () => {
  let root: Root
  let host: HTMLDivElement
  let runtime: 'desktop' | 'web'
  let platform: NodeJS.Platform
  const close = vi.fn()

  beforeEach(() => {
    runtime = 'desktop'
    platform = 'linux'
    state.showWindowTitleBar = true
    close.mockClear()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    Object.defineProperty(window, 'zen', {
      configurable: true,
      value: {
        getAppInfo: () => ({ runtime }),
        platformSync: () => platform,
        windowClose: close
      }
    })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it.each<NodeJS.Platform>(['darwin', 'linux', 'win32'])('reclaims the whole title row on %s', (os) => {
    platform = os
    act(() => root.render(createElement(TitleBar)))
    expect(host.textContent).toContain('Demo vault')
    state.showWindowTitleBar = false
    act(() => root.render(createElement(TitleBar)))
    expect(host.childElementCount).toBe(0)
    state.showWindowTitleBar = true
    act(() => root.render(createElement(TitleBar)))
    expect(host.textContent).toContain('Demo vault')
  })

  it('restores working Linux window controls when shown again', () => {
    state.showWindowTitleBar = false
    act(() => root.render(createElement(TitleBar)))
    expect(host.querySelector('button')).toBeNull()
    state.showWindowTitleBar = true
    act(() => root.render(createElement(TitleBar)))
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="✕"]')!.click())
    expect(close).toHaveBeenCalledOnce()
  })

  it('keeps the browser layout and old preferences unchanged', () => {
    runtime = 'web'
    state.showWindowTitleBar = false
    act(() => root.render(createElement(TitleBar)))
    expect(host.textContent).toContain('Demo vault')
    runtime = 'desktop'
    state.showWindowTitleBar = undefined
    act(() => root.render(createElement(TitleBar)))
    expect(host.textContent).toContain('Demo vault')
  })
})
