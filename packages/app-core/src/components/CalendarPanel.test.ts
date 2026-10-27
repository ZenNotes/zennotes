// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteMeta } from '@shared/ipc'
import { useStore } from '../store'
import { dailyNoteLocationForDate } from '../lib/vault-layout'
import { CalendarPanel } from './CalendarPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const confirmApp = vi.hoisted(() => vi.fn(async () => true))
vi.mock('../lib/confirm-requests', () => ({ confirmApp }))

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function dailyNote(date: Date): NoteMeta {
  const { title, subpath } = dailyNoteLocationForDate(date, useStore.getState().vaultSettings)
  return {
    path: `inbox/${subpath ? `${subpath}/` : ''}${title}.md`,
    title,
    folder: 'inbox',
    siblingOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    size: 0,
    tags: [],
    wikilinks: [],
    hasAttachments: false,
    assetEmbeds: [],
    excerpt: ''
  }
}

/** A press then its click, the order a browser fires them in. */
function tap(el: Element, pointerType: 'touch' | 'mouse'): void {
  const down = new Event('pointerdown', { bubbles: true })
  Object.defineProperty(down, 'pointerType', { value: pointerType })
  act(() => {
    el.dispatchEvent(down)
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('CalendarPanel: a day on a touch screen', () => {
  let host: HTMLDivElement
  let root: Root
  let originalState: ReturnType<typeof useStore.getState>
  const openDailyNoteForDate = vi.fn(async (_date: Date) => {})
  const today = new Date()
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)

  beforeEach(() => {
    originalState = useStore.getState()
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn()
    })
    const settings = originalState.vaultSettings
    useStore.setState({
      vaultSettings: { ...settings, dailyNotes: { ...settings.dailyNotes, enabled: true } },
      notes: [],
      vaultTasks: [],
      tasksLoading: true,
      openDailyNoteForDate
    })
    confirmApp.mockClear()
    openDailyNoteForDate.mockClear()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    useStore.setState(originalState, true)
  })

  function day(date: Date): Element {
    const cell = host.querySelector(`[data-cal-day="${isoDate(date)}"]`)
    if (!cell) throw new Error(`no cell for ${isoDate(date)}`)
    return cell
  }

  it('stands on its own with no note, oriented on today', () => {
    act(() => root.render(createElement(CalendarPanel, { note: null })))
    expect(day(today).className).toContain('ring-accent/60')
  })

  it('selects with the first tap and offers to create the day with a second', async () => {
    act(() => root.render(createElement(CalendarPanel, { note: null })))
    tap(day(tomorrow), 'touch')
    expect(day(tomorrow).className).toContain('ring-accent/60')
    expect(confirmApp).not.toHaveBeenCalled()

    tap(day(tomorrow), 'touch')
    await act(async () => {})
    expect(confirmApp).toHaveBeenCalledWith(expect.objectContaining({ title: 'New daily note' }))
    expect(openDailyNoteForDate).toHaveBeenCalledTimes(1)
    expect(isoDate(openDailyNoteForDate.mock.calls[0][0])).toBe(isoDate(tomorrow))
  })

  it("opens an existing day's note on the tap that lands on the selected day", async () => {
    useStore.setState({ notes: [dailyNote(today)] })
    const onOpen = vi.fn()
    act(() => root.render(createElement(CalendarPanel, { note: null, onOpen })))
    tap(day(today), 'touch')
    await act(async () => {})
    expect(confirmApp).not.toHaveBeenCalled()
    expect(openDailyNoteForDate).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('stays open when the new day is declined', async () => {
    confirmApp.mockResolvedValueOnce(false)
    const onOpen = vi.fn()
    act(() => root.render(createElement(CalendarPanel, { note: null, onOpen })))
    tap(day(today), 'touch')
    await act(async () => {})
    expect(confirmApp).toHaveBeenCalledTimes(1)
    expect(openDailyNoteForDate).not.toHaveBeenCalled()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('keeps a mouse click to select only', async () => {
    useStore.setState({ notes: [dailyNote(today)] })
    act(() => root.render(createElement(CalendarPanel, { note: null })))
    tap(day(today), 'mouse')
    tap(day(tomorrow), 'mouse')
    tap(day(tomorrow), 'mouse')
    await act(async () => {})
    expect(day(tomorrow).className).toContain('ring-accent/60')
    expect(confirmApp).not.toHaveBeenCalled()
    expect(openDailyNoteForDate).not.toHaveBeenCalled()
  })

  it("opens on the host's day, in that day's month (the widget's day link)", () => {
    const later = new Date(today.getFullYear(), today.getMonth() + 2, 15)
    act(() => root.render(createElement(CalendarPanel, { note: null, initialDate: isoDate(later) })))
    expect(day(later).className).toContain('ring-accent/60')
    expect(host.querySelector(`[data-cal-day="${isoDate(today)}"]`)).toBeNull()
  })

  it('ignores a malformed host day and orients on today', () => {
    act(() => root.render(createElement(CalendarPanel, { note: null, initialDate: '2026-13-45' })))
    expect(day(today).className).toContain('ring-accent/60')
  })

  it('puts the cursor in "Add a task" when asked (the widget\'s add button)', async () => {
    act(() => root.render(createElement(CalendarPanel, { note: null, focusAdd: true })))
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    })
    const input = host.querySelector('input[placeholder^="Add a task for"]')
    expect(input).not.toBeNull()
    expect(document.activeElement).toBe(input)
  })
})
