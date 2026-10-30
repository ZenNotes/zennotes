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

let host: HTMLDivElement
let root: Root
let originalState: ReturnType<typeof useStore.getState>
const newTaskFile = vi.fn(async () => null)
const setHideEmptyTasks = vi.fn()

/** The Tasks view on the calendar, Vim on, two tasks due today. */
function mount(dailyNotes: boolean): void {
  originalState = useStore.getState()
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  const leaf = makeLeaf([TASKS_TAB_PATH], TASKS_TAB_PATH)
  const tasks = parseTasksFromBody(`- [ ] Pay rent due:${isoToday()}\n- [ ] Call the bank due:${isoToday()}\n`, {
    path: 'Calendar.md',
    title: 'Calendar',
    folder: 'inbox'
  })
  const settings = originalState.vaultSettings
  useStore.setState({
    vimMode: true,
    paneLayout: leaf,
    activePaneId: leaf.id,
    focusedPanel: 'tasks',
    tasksViewMode: 'calendar',
    vaultTasks: tasks,
    tasksLoading: false,
    tasksFilter: '',
    vaultSettings: { ...settings, dailyNotes: { ...settings.dailyNotes, enabled: dailyNotes } },
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
}

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useStore.setState(originalState, true)
})

describe('Tasks calendar keys while a task is picked up', () => {
  beforeEach(() => mount(false))

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

describe('the Tasks calendar’s `a`', () => {
  const quickAddFocused = (): boolean =>
    /^Add a task for/.test((document.activeElement as HTMLElement | null)?.getAttribute('placeholder') ?? '')

  it('adds to the selected day with daily notes on, however the handlers registered', async () => {
    mount(true)
    press('a')
    await vi.waitFor(() => expect(quickAddFocused()).toBe(true))
    act(() => (document.activeElement as HTMLElement).blur())
    // A day there and back registers the calendar's handler again, after the
    // Tasks view's: the order that used to hand `a` to New task.
    press('l')
    press('h')
    press('a')
    await vi.waitFor(() => expect(quickAddFocused()).toBe(true))
    expect(newTaskFile).not.toHaveBeenCalled()
  })

  it('opens New task with daily notes off, where there is no day to add to', () => {
    mount(false)
    press('l')
    press('a')
    expect(newTaskFile).toHaveBeenCalledTimes(1)
  })
})
