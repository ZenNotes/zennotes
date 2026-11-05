// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { ASSETS_VIEW_TAB_PATH } from '@shared/assets-view'
import { useStore } from '../store'
import { TitleBar } from './TitleBar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('TitleBar', () => {
  const originalState = useStore.getState()
  afterEach(() => useStore.setState(originalState, true))

  it('names the Assets page instead of falling back to the vault', () => {
    ;(window as unknown as { zen: unknown }).zen = {
      platformSync: () => 'darwin',
      getAppInfo: () => ({ runtime: 'desktop' })
    }
    useStore.setState({
      showWindowTitleBar: true,
      vault: { root: '/v', name: 'my vault' },
      activeNote: null,
      selectedPath: ASSETS_VIEW_TAB_PATH
    } as never)
    const host = document.createElement('div')
    const root = createRoot(host)
    act(() => root.render(createElement(TitleBar)))
    expect(host.textContent).toContain('Assets')
    expect(host.textContent).not.toContain('my vault')
    act(() => root.unmount())
  })
})
