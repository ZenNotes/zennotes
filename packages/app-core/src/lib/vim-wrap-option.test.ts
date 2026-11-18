// @vitest-environment jsdom

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { Vim, getCM, vim } from '@replit/codemirror-vim'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useStore } from '../store'
import { defineWrapOption } from './vim-wrap-option'

let view: EditorView | null = null

function mountVim(): Parameters<typeof Vim.handleEx>[0] {
  view = new EditorView({
    state: EditorState.create({ doc: 'a long line', extensions: [vim()] }),
    parent: document.body
  })
  const cm = getCM(view)
  if (!cm) throw new Error('Vim adapter did not mount')
  return cm as Parameters<typeof Vim.handleEx>[0]
}

beforeEach(() => {
  useStore.setState({ wordWrap: true })
})

afterEach(() => {
  view?.destroy()
  view = null
  document.body.innerHTML = ''
})

describe(':set wrap (#1084)', () => {
  it('leaves a saved choice alone when the option is defined at launch', () => {
    useStore.setState({ wordWrap: false })
    defineWrapOption()
    expect(useStore.getState().wordWrap).toBe(false)
  })

  it(':set nowrap and :set wrap drive the Word wrap preference', () => {
    defineWrapOption()
    const cm = mountVim()
    Vim.handleEx(cm, 'set nowrap')
    expect(useStore.getState().wordWrap).toBe(false)
    expect(Vim.getOption('wrap')).toBe(false)
    Vim.handleEx(cm, 'set wrap')
    expect(useStore.getState().wordWrap).toBe(true)
    Vim.handleEx(cm, 'set wrap!')
    expect(useStore.getState().wordWrap).toBe(false)
  })

  it('follows a change made elsewhere (Settings, Alt+Z, config.toml)', () => {
    defineWrapOption()
    useStore.getState().setWordWrap(false)
    expect(Vim.getOption('wrap')).toBe(false)
    useStore.getState().setWordWrap(true)
    expect(Vim.getOption('wrap')).toBe(true)
  })

  it(':set wrap? reports the state the way Vim does, without changing it', () => {
    defineWrapOption()
    const cm = mountVim()
    useStore.setState({ wordWrap: false })
    Vim.handleEx(cm, 'set wrap?')
    expect(useStore.getState().wordWrap).toBe(false)
    expect(document.body.textContent).toContain('nowrap')
    useStore.setState({ wordWrap: true })
    Vim.handleEx(cm, 'set wrap?')
    expect(useStore.getState().wordWrap).toBe(true)
    expect(document.body.textContent).toMatch(/(^|[^o])wrap/)
  })
})
