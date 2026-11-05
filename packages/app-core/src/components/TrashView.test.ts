// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NoteMeta } from '@shared/ipc'
import { useStore } from '../store'
import { TrashView } from './TrashView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const old: NoteMeta = {
  path: 'trash/Old meeting notes.md',
  title: 'Old meeting notes',
  folder: 'trash',
  siblingOrder: 0,
  createdAt: 0,
  updatedAt: 0,
  size: 0,
  tags: [],
  wikilinks: [],
  hasAttachments: false,
  assetEmbeds: [],
  excerpt: 'Old meeting notes The agenda covered budgets.'
}

describe('TrashView rows', () => {
  let host: HTMLDivElement
  let root: Root
  let originalState: ReturnType<typeof useStore.getState>
  beforeEach(() => {
    originalState = useStore.getState()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    Element.prototype.scrollIntoView = () => {}
    useStore.setState({ notes: [old] } as never)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    useStore.setState(originalState, true)
  })

  it('do not repeat the title in the preview line', () => {
    act(() => root.render(createElement(TrashView)))
    const text = host.textContent ?? ''
    expect(text).toContain('The agenda covered budgets.')
    expect(text).not.toContain('Old meeting notes The agenda')
  })
})
