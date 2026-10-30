// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseTasksFromBody, TASKS_TAB_PATH } from '@shared/tasks'
import { useStore } from '../store'
import { makeLeaf } from '../lib/pane-layout'
import { TasksView } from './TasksView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function isoToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** A key as the app gets it: dispatched at the page, so the Tasks view's and
 *  the calendar's window capture listeners run in the order they registered. */
function press(key: string): void {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

describe('Tasks calendar keys while a task is picked up', () => {
  let host: HTMLDivElement
  let root: Root
  let originalState: ReturnType<typeof useStore.getState>
  const newTaskFile = vi.fn(async () => null)
  const setHideEmptyTasks = vi.fn()

  beforeEach(() => {
    originalState = useStore.getState()
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
    const leaf = makeLeaf([TASKS_TAB_PATH], TASKS_TAB_PATH)
    const tasks = parseTasksFromBody(`- [ ] Pay rent due:${isoToday()}\n- [ ] Call the bank due:${isoToday()}\n`, {
      path: 'Calendar.md',
      title: 'Calendar',
      folder: 'inbox'
    })
    useStore.setState({
      vimMode: true,
      paneLayout: leaf,
      activePaneId: leaf.id,
      focusedPanel: 'tasks',
      tasksViewMode: 'calendar',
      vaultTasks: tasks,
      tasksLoading: false,
      tasksFilter: '',
      refreshTasks: vi.fn(async () => {}),
      newTaskFile,
      setHideEmptyTasks
    })
    newTaskFile.mockClear()
    setHideEmptyTasks.mockClear()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root.render(createElement(TasksView)))
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    useStore.setState(originalState, true)
  })

  const moving = (): boolean => /Moving “Pay rent”/.test(host.textContent ?? '')

  it('puts the task back on Esc', () => {
    press('m')
    expect(moving()).toBe(true)
    press('Escape')
    expect(moving()).toBe(false)
  })

  it('keeps the keys it does not use from the Tasks view until the task is placed', () => {
    press('m')
    press('E')
    press('a')
    expect(setHideEmptyTasks).not.toHaveBeenCalled()
    expect(newTaskFile).not.toHaveBeenCalled()
    expect(moving()).toBe(true)
  })

  it('leaves Esc to clear the filter when nothing is picked up', () => {
    act(() => useStore.setState({ tasksFilter: 'rent' }))
    press('Escape')
    expect(useStore.getState().tasksFilter).toBe('')
  })
})
