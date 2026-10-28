// @vitest-environment jsdom

import { Vim } from '@replit/codemirror-vim'
import { beforeEach, describe, expect, it } from 'vitest'
import { useStore } from '../store'
import { defineStatusBarOption } from './vim-status-bar-option'

beforeEach(() => {
  useStore.setState({ showStatusBar: true })
})

describe(':set statusbar', () => {
  it('leaves a saved choice alone when the option is defined at launch', () => {
    useStore.setState({ showStatusBar: false })
    defineStatusBarOption()
    expect(useStore.getState().showStatusBar).toBe(false)
  })

  it('sets, clears and reports the setting', () => {
    defineStatusBarOption()
    Vim.setOption('statusbar', false)
    expect(useStore.getState().showStatusBar).toBe(false)
    expect(Vim.getOption('statusbar')).toBe(false)
    Vim.setOption('stb', true)
    expect(useStore.getState().showStatusBar).toBe(true)
    expect(Vim.getOption('statusbar')).toBe(true)
  })
})
