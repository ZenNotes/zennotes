// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ContextMenu } from './ContextMenu'

describe('ContextMenu focus', () => {
  let host: HTMLDivElement
  let root: Root
  let opener: HTMLButtonElement

  const menu = () =>
    createElement(ContextMenu, {
      x: 10,
      y: 10,
      items: [{ label: "Move into Sep 25's note", onSelect: () => {} }],
      onClose: () => {}
    })

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    opener.remove()
  })

  it('holds the keyboard as soon as it mounts, not a frame later (#850)', async () => {
    await act(async () => root.render(menu()))
    expect(document.activeElement?.closest('[data-ctx-menu]')).toBeTruthy()
  })

  it('hands focus back to what held it when it closes', async () => {
    await act(async () => root.render(menu()))
    await act(async () => root.render(createElement('div')))
    expect(document.activeElement).toBe(opener)
  })
})
