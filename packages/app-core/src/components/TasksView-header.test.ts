// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TASKS_TAB_PATH } from '@shared/tasks'
import { makeLeaf } from '../lib/pane-layout'
import { useStore } from '../store'
import { TasksView } from './TasksView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let originalState: ReturnType<typeof useStore.getState>

function mount(vimMode: boolean, tasksLoading = false): void {
  originalState = useStore.getState()
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  const leaf = makeLeaf([TASKS_TAB_PATH], TASKS_TAB_PATH)
  useStore.setState({
    vimMode,
    paneLayout: leaf,
    activePaneId: leaf.id,
    vaultTasks: [],
    tasksLoading,
    tasksFilter: '',
    refreshTasks: vi.fn(async () => {})
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(createElement(TasksView)))
}

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useStore.setState(originalState, true)
})

const filter = (): HTMLInputElement =>
  host.querySelector<HTMLInputElement>('[data-tasks-header] input')!

describe('the Tasks header', () => {
  it('names the / key only in Vim mode, which is the only place it works', () => {
    mount(false)
    expect(filter().placeholder).toBe('Filter…')
    act(() => root.unmount())
    host.remove()
    useStore.setState(originalState, true)
    mount(true)
    expect(filter().placeholder).toBe('Filter…  /  to focus')
  })

  it('wraps rather than pushing its buttons off a narrow pane', () => {
    mount(false, true)
    const header = host.querySelector<HTMLElement>('[data-tasks-header]')!
    expect(header.classList.contains('flex-wrap')).toBe(true)
    expect(header.textContent).toContain('scanning')
    expect(header.textContent).toContain('Refresh')
  })
})
