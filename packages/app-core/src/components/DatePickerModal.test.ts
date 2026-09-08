// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../store'
import { DatePickerModal, type DatePickerOptions } from './DatePickerModal'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function key(target: Element, key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
  })
}

function cell(iso: string): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(`[data-date-cell="${iso}"]`)
  if (!el) throw new Error(`no cell for ${iso}`)
  return el
}

function selectedIso(): string | null {
  return document.querySelector('[role="gridcell"][aria-selected="true"]')?.getAttribute('data-date-cell') ?? null
}

function monthShown(): string {
  return document.querySelector('[data-date-picker-month]')?.textContent ?? ''
}

describe('DatePickerModal', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null
  const onSubmit = vi.fn<(iso: string) => void>()
  const onCancel = vi.fn<() => void>()

  function mount(options: DatePickerOptions): void {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root!.render(createElement(DatePickerModal, { options, onSubmit, onCancel }))
    })
  }

  beforeEach(() => {
    onSubmit.mockReset()
    onCancel.mockReset()
    useStore.setState({ vimMode: false, calendarWeekStart: 'monday' })
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = null
    container = null
  })

  it('opens on the given day with that cell focused, and Enter inserts it', () => {
    mount({ initialDate: '2026-09-08' })
    expect(selectedIso()).toBe('2026-09-08')
    expect(monthShown()).toBe('September 2026')
    expect(document.activeElement).toBe(cell('2026-09-08'))
    key(cell('2026-09-08'), 'Enter')
    expect(onSubmit).toHaveBeenCalledWith('2026-09-08')
  })

  it('moves with arrows and paging, following the selection across months', () => {
    mount({ initialDate: '2026-09-08' })
    key(cell('2026-09-08'), 'ArrowRight')
    expect(selectedIso()).toBe('2026-09-09')
    key(cell('2026-09-09'), 'ArrowDown')
    expect(selectedIso()).toBe('2026-09-16')
    expect(document.activeElement).toBe(cell('2026-09-16'))
    key(cell('2026-09-16'), 'PageDown')
    expect(selectedIso()).toBe('2026-10-16')
    expect(monthShown()).toBe('October 2026')
    // A month change replaces every cell; focus must land on the new one,
    // not fall to the body with the unmounted button.
    expect(document.activeElement).toBe(cell('2026-10-16'))
    key(cell('2026-10-16'), 'PageUp', { shiftKey: true })
    expect(selectedIso()).toBe('2025-10-16')
    expect(monthShown()).toBe('October 2025')
    expect(document.activeElement).toBe(cell('2025-10-16'))
    key(cell('2025-10-16'), 'Enter')
    expect(onSubmit).toHaveBeenCalledWith('2025-10-16')
  })

  it('keeps letters inert with Vim mode off and makes them moves with it on', () => {
    mount({ initialDate: '2026-09-08' })
    key(cell('2026-09-08'), 'l')
    expect(selectedIso()).toBe('2026-09-08')

    act(() => useStore.setState({ vimMode: true }))
    key(cell('2026-09-08'), 'l')
    expect(selectedIso()).toBe('2026-09-09')
    key(cell('2026-09-09'), 'j')
    expect(selectedIso()).toBe('2026-09-16')
  })

  it('takes a typed date: the grid follows it and Enter inserts it', () => {
    mount({ initialDate: '2026-09-08' })
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Date"]')!
    // A digit pressed on the grid moves typing to the field, starting fresh.
    key(cell('2026-09-08'), '2')
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('2')

    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setValue.call(input, '2027-03-14')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(selectedIso()).toBe('2027-03-14')
    expect(monthShown()).toBe('March 2027')

    key(input, 'Enter')
    expect(onSubmit).toHaveBeenCalledWith('2027-03-14')
  })

  it('refuses a typed day that does not exist instead of inserting a rolled-over one', () => {
    mount({ initialDate: '2026-09-08' })
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Date"]')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setValue.call(input, '2026-02-30')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    key(input, 'Enter')
    expect(onSubmit).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Type a real date as YYYY-MM-DD.')
    // The grid still stands on the last real day.
    expect(selectedIso()).toBe('2026-09-08')
  })

  it('cancels from the footer and marks itself as a prompt for the key routers', () => {
    mount({ initialDate: '2026-09-08' })
    expect(document.querySelector('[data-prompt-modal]')).not.toBeNull()
    const cancel = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Cancel'
    )!
    act(() => cancel.click())
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('falls back to today when the initial date is malformed', () => {
    mount({ initialDate: 'yesterday' })
    const now = new Date()
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
      now.getDate()
    ).padStart(2, '0')}`
    expect(selectedIso()).toBe(today)
  })
})
