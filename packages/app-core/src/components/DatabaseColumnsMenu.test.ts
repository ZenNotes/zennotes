// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseDoc } from '@shared/databases'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const opensToRead = vi.hoisted(() => ({ value: false }))
vi.mock('../lib/editor-host', async (load) => ({
  ...(await load<typeof import('../lib/editor-host')>()),
  hostOpensNotesToRead: () => opensToRead.value
}))

import { useStore } from '../store'
import { DatabaseColumnsMenu } from './DatabaseColumnsMenu'

const doc: DatabaseDoc = {
  version: 1,
  path: 'Projects.base/data.csv',
  title: 'Projects',
  idFieldId: 'id',
  activeViewId: 'table',
  fields: [
    { id: 'id', name: 'id', type: 'text', hidden: true },
    { id: 'name', name: 'Name', type: 'text' },
    { id: 'status', name: 'Status', type: 'text' }
  ],
  views: [{ id: 'table', name: 'Table', type: 'table', filters: [], sorts: [] }],
  rows: []
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  Object.defineProperty(window, 'zen', { configurable: true, value: { getCapabilities: () => ({}) } })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  opensToRead.value = false
})

async function open(): Promise<void> {
  await act(async () =>
    root.render(
      createElement(DatabaseColumnsMenu, {
        csvPath: doc.path,
        doc,
        view: doc.views[0],
        anchor: new DOMRect(10, 10, 80, 20),
        onClose: () => {}
      })
    )
  )
}

const findField = (): HTMLInputElement | null =>
  document.querySelector<HTMLInputElement>('input[aria-label="Find a column"]')

describe('the Columns menu as it opens', () => {
  it('gives the find field the keyboard with Vim mode off', async () => {
    useStore.setState({ vimMode: false })
    await open()
    expect(findField()).toBeTruthy()
    expect(document.activeElement).toBe(findField())
  })

  it('leaves the find field alone on a host that opens notes to read (a phone keyboard)', async () => {
    useStore.setState({ vimMode: false })
    opensToRead.value = true
    await open()
    expect(findField()).toBeTruthy()
    expect(document.activeElement).not.toBe(findField())
  })

  it('starts on the list with Vim mode on, on either host', async () => {
    useStore.setState({ vimMode: true })
    opensToRead.value = true
    await open()
    expect(document.activeElement?.closest('[data-column-id]')).toBeTruthy()
  })
})
