// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseDoc } from '@shared/databases'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { useStore } from '../store'
import { DatabaseTableView } from './DatabaseTableView'

const CSV = 'Projects.base/data.csv'

function database(picked?: string[]): DatabaseDoc {
  return {
    version: 1,
    path: CSV,
    title: 'Projects',
    idFieldId: 'id',
    activeViewId: 'table',
    fields: [
      { id: 'id', name: 'id', type: 'text', hidden: true },
      { id: 'name', name: 'Name', type: 'text' }
    ],
    views: [{ id: 'table', name: 'Table', type: 'table', filters: [], sorts: [], ...(picked ? { pickedRowIds: picked } : {}) }],
    rows: [
      { id: 'a', cells: { id: 'a', name: 'Alpha' } },
      { id: 'b', cells: { id: 'b', name: 'Beta' } },
      { id: 'c', cells: { id: 'c', name: 'Gamma' } }
    ]
  }
}

let host: HTMLDivElement
let root: Root
const deleteDatabaseRows = vi.fn<(csvPath: string, rowIds: string[], options?: { confirm?: boolean }) => Promise<void>>()

beforeEach(() => {
  Object.defineProperty(window, 'zen', { configurable: true, value: { getCapabilities: () => ({}) } })
  // jsdom lays nothing out.
  Element.prototype.scrollIntoView = () => {}
  deleteDatabaseRows.mockReset()
  deleteDatabaseRows.mockResolvedValue(undefined)
  useStore.setState({ deleteDatabaseRows, vimMode: false, focusedPanel: 'editor' })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.querySelectorAll('[aria-modal]').forEach((node) => node.remove())
})

async function render(doc: DatabaseDoc): Promise<HTMLElement> {
  await act(async () =>
    root.render(createElement(DatabaseTableView, { csvPath: CSV, doc, view: doc.views[0], isActive: true }))
  )
  const grid = host.querySelector<HTMLElement>('[data-zen-db-grid]')!
  // Let the grid's own focus claim on opening run first, so a later focus
  // can only come from the key being tested.
  await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  act(() => grid.focus())
  return grid
}

async function press(grid: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    grid.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

describe('the database grid, Delete and Backspace', () => {
  it('ask to delete the row at the cursor', async () => {
    const grid = await render(database())
    await press(grid, 'Delete')
    expect(deleteDatabaseRows).toHaveBeenCalledWith(CSV, ['a'], { confirm: true })
  })

  it('do nothing while the picks are being edited, where the selection is the picks', async () => {
    const grid = await render(database(['a', 'b']))
    const edit = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Edit picks')!
    await act(async () => edit.click())
    expect(host.textContent).toContain('Editing picks: 2 selected')
    act(() => grid.focus())

    await press(grid, 'Backspace')
    await press(grid, 'Delete')

    expect(deleteDatabaseRows).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Editing picks: 2 selected')
  })

  it('do nothing behind a dialog', async () => {
    const grid = await render(database())
    const dialog = document.createElement('div')
    dialog.setAttribute('aria-modal', 'true')
    document.body.append(dialog)

    await press(grid, 'Delete')

    expect(deleteDatabaseRows).not.toHaveBeenCalled()
  })
})
