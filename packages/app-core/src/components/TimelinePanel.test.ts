// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VaultTask } from '@shared/tasks'
import { useStore } from '../store'
import { TimelinePanel } from './TimelinePanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function isoOffset(days: number): string {
  const now = new Date()
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function task(id: string, overrides?: Partial<VaultTask>): VaultTask {
  return {
    id,
    sourcePath: `inbox/${id}.md`,
    noteTitle: `Note ${id}`,
    noteFolder: 'inbox',
    lineNumber: 0,
    taskIndex: 0,
    rawText: `- [ ] ${id}`,
    content: id,
    checked: false,
    forwarded: false,
    cancelled: false,
    inProgress: false,
    waiting: false,
    tags: [],
    ...overrides
  }
}

const VAULT: VaultTask[] = [
  task('late', { due: isoOffset(-3), priority: 'high' }),
  task('today', { due: isoOffset(0) }),
  task('doing', { due: isoOffset(0), inProgress: true, rawText: '- [/] doing' }),
  task('launch', { due: isoOffset(5), tags: ['milestone'], content: 'launch #milestone' }),
  task('far', { due: isoOffset(20) }),
  task('someday')
]

describe('TimelinePanel', () => {
  let host: HTMLDivElement
  let root: Root
  let originalState: ReturnType<typeof useStore.getState>
  const toggleTaskFromList = vi.fn(async (_task: VaultTask) => {})
  const openTaskAt = vi.fn(async (_task: VaultTask) => {})
  const openTasksView = vi.fn(async () => {})
  const refreshTasks = vi.fn(async () => {})

  beforeEach(() => {
    originalState = useStore.getState()
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn()
    })
    useStore.setState({
      notes: [],
      vaultTasks: VAULT,
      tasksLoading: false,
      showArchivedTasks: false,
      vimMode: true,
      keymapOverrides: {},
      focusedPanel: 'timeline',
      timelineRange: 'two-weeks',
      timelineFilter: '',
      toggleTaskFromList,
      openTaskAt,
      openTasksView,
      refreshTasks
    })
    for (const fn of [toggleTaskFromList, openTaskAt, openTasksView, refreshTasks]) fn.mockClear()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    useStore.setState(originalState, true)
  })

  function render(): HTMLElement {
    act(() => root.render(createElement(TimelinePanel, {})))
    const panel = host.querySelector<HTMLElement>('[data-timeline-panel]')
    if (!panel) throw new Error('no panel')
    return panel
  }

  function press(panel: HTMLElement, key: string, init: KeyboardEventInit = {}): void {
    const code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key
    act(() => {
      panel.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true, ...init }))
    })
  }

  const rowIds = (): string[] =>
    [...host.querySelectorAll('[data-timeline-task]')].map((el) => el.getAttribute('data-timeline-task') ?? '')
  const cursorId = (): string | null =>
    host.querySelector('.vim-cursor')?.getAttribute('data-timeline-task') ?? null

  it('draws overdue, today, quiet days and the milestone, and counts what it shows', () => {
    const panel = render()
    // Within a day, the Tasks list's order: priority, then the notes' order.
    expect(rowIds()).toEqual(['late', 'doing', 'today', 'launch'])
    expect(panel.querySelector('[data-timeline-count]')?.textContent).toBe('4 open · 1 overdue')
    expect(panel.querySelector('[data-timeline-overdue]')?.textContent).toContain('3d late')
    expect(panel.querySelector('[data-timeline-overdue]')?.textContent).toContain('!high')
    expect(panel.querySelector(`[data-timeline-day="${isoOffset(0)}"]`)?.textContent).toMatch(/^Today · /)
    expect(panel.querySelector('[data-timeline-quiet]')?.textContent).toBe('4 quiet days')
    const milestoneDay = panel.querySelector(`[data-timeline-day="${isoOffset(5)}"]`)
    expect(milestoneDay?.textContent).toContain('· milestone')
    // Three open tasks stand before it: the overdue one and today's two.
    expect(milestoneDay?.querySelector('[data-timeline-before]')?.textContent).toBe('· 3 tasks before it')
    expect(panel.querySelector('[data-timeline-task="doing"] [role="checkbox"]')?.getAttribute('title')).toMatch(
      /^In progress\./
    )
    expect(panel.querySelector('[data-timeline-later]')?.textContent).toMatch(/^1 after /)
    expect(panel.querySelector('[data-timeline-undated]')?.textContent).toBe('1 undated in Tasks')
  })

  it('reaches further with Month and All, and keeps the choice', () => {
    const panel = render()
    act(() => panel.querySelector<HTMLButtonElement>('[data-timeline-range="month"]')?.click())
    expect(useStore.getState().timelineRange).toBe('month')
    expect(rowIds()).toContain('far')
    act(() => panel.querySelector<HTMLButtonElement>('[data-timeline-range="two-weeks"]')?.click())
    expect(rowIds()).not.toContain('far')
    act(() => panel.querySelector<HTMLButtonElement>('[data-timeline-later]')?.click())
    expect(useStore.getState().timelineRange).toBe('all')
    expect(rowIds()).toContain('far')
  })

  it('narrows with the Tasks filter syntax', () => {
    useStore.setState({ timelineFilter: '!high' })
    render()
    expect(rowIds()).toEqual(['late'])
  })

  it('moves with j/k, ticks with x and opens with Enter in Vim mode', () => {
    const panel = render()
    expect(cursorId()).toBe('late')
    press(panel, 'j')
    press(panel, 'j')
    expect(cursorId()).toBe('today')
    press(panel, 'k')
    expect(cursorId()).toBe('doing')
    press(panel, 'x')
    expect(toggleTaskFromList).toHaveBeenCalledWith(expect.objectContaining({ id: 'doing' }))
    press(panel, 'Enter')
    expect(openTaskAt).toHaveBeenCalledWith(expect.objectContaining({ id: 'doing' }))
    press(panel, 'G', { shiftKey: true })
    expect(cursorId()).toBe('launch')
    press(panel, 'g')
    press(panel, 'g')
    expect(cursorId()).toBe('late')
    expect(panel.querySelector('[data-timeline-hints]')?.textContent).toContain('tick')
  })

  it('takes a ticked task off the rail, as the calendar panel does', () => {
    render()
    act(() =>
      useStore.setState({
        vaultTasks: VAULT.map((t) => (t.id === 'today' ? { ...t, checked: true } : t))
      })
    )
    expect(rowIds()).toEqual(['late', 'doing', 'launch'])
    expect(host.querySelector('[data-timeline-count]')?.textContent).toBe('3 open · 1 overdue')
  })

  it('leaves the letters alone with Vim off; the arrows, Enter and Escape still work', () => {
    useStore.setState({ vimMode: false })
    const panel = render()
    press(panel, 'j')
    expect(cursorId()).toBe('late')
    press(panel, 'x')
    expect(toggleTaskFromList).not.toHaveBeenCalled()
    press(panel, 'ArrowDown')
    expect(cursorId()).toBe('doing')
    press(panel, 'Enter')
    expect(openTaskAt).toHaveBeenCalledWith(expect.objectContaining({ id: 'doing' }))
    expect(panel.querySelector('[data-timeline-hints]')).toBeNull()
    expect(panel.querySelector('[role="checkbox"]')?.getAttribute('title')).not.toMatch(/\(x\)/)
    press(panel, 'Escape')
    expect(useStore.getState().focusedPanel).toBe('editor')
  })

  it('stands down while a menu is open over it', () => {
    const panel = render()
    const menu = document.createElement('div')
    menu.setAttribute('data-ctx-menu', '')
    document.body.append(menu)
    try {
      press(panel, 'j')
      expect(cursorId()).toBe('late')
    } finally {
      menu.remove()
    }
  })

  it('opens the shared task menu on right-click', () => {
    render()
    const row = host.querySelector('[data-timeline-task="today"]')
    act(() => {
      row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }))
    })
    const menu = document.querySelector('[data-ctx-menu]')
    expect(menu?.textContent).toContain('Open note')
    expect(menu?.textContent).toContain('Mark in progress')
    expect(menu?.textContent).toContain('Edit')
  })

  it('sends undated tasks to the Tasks view', () => {
    render()
    act(() => host.querySelector<HTMLButtonElement>('[data-timeline-undated]')?.click())
    expect(openTasksView).toHaveBeenCalledTimes(1)
  })

  it('reads the vault again when it opens after a while closed, not on a quick remount', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
    try {
      render()
      expect(refreshTasks).toHaveBeenCalledTimes(1)
      // A pane remounts its panels while a note loads: no second full scan.
      act(() => root.render(createElement('div')))
      render()
      expect(refreshTasks).toHaveBeenCalledTimes(1)
    } finally {
      now.mockRestore()
    }
  })
})
