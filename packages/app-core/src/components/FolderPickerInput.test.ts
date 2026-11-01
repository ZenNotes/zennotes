// @vitest-environment jsdom

import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderChoice } from '../lib/folder-picker'
import { FolderPickerInput } from './FolderPickerInput'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const choices: FolderChoice[] = ['Books', 'Projects', 'Projects/Alpha', 'Journal'].map((value) => ({
  value,
  label: value
}))

describe('FolderPickerInput (#1033)', () => {
  let host: HTMLDivElement
  let root: Root
  let originalScrollIntoView: PropertyDescriptor | undefined
  const onPick = vi.fn()
  const onKeyDown = vi.fn()
  const windowKeys = vi.fn()

  function Harness(): JSX.Element {
    const [text, setText] = useState('')
    return createElement(FolderPickerInput, {
      value: text,
      onChange: setText,
      choices,
      current: 'Projects',
      onPick: (value: string) => {
        setText(value)
        onPick(value)
      },
      onKeyDown,
      'aria-label': 'Folder'
    })
  }

  beforeEach(() => {
    onPick.mockReset()
    onKeyDown.mockReset()
    windowKeys.mockReset()
    window.addEventListener('keydown', windowKeys)
    originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root.render(createElement(Harness)))
  })

  afterEach(() => {
    act(() => root.unmount())
    window.removeEventListener('keydown', windowKeys)
    document.body.innerHTML = ''
    if (originalScrollIntoView) {
      Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView)
    } else {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })

  const field = (): HTMLInputElement => host.querySelector('input')!
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  const type = (text: string): void => {
    act(() => {
      setValue.call(field(), text)
      field().dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const press = (key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
    act(() => {
      field().dispatchEvent(event)
    })
    return event
  }
  const rows = (): string[] =>
    [...document.querySelectorAll<HTMLElement>('[data-folder-picker-option]')].map(
      (row) => row.dataset.folderPickerOption ?? ''
    )
  const highlighted = (): string | null =>
    document.querySelector<HTMLElement>('[data-folder-picker-option][aria-selected="true"]')?.dataset
      .folderPickerOption ?? null

  it('lists every folder on focus, ticks the saved one, and highlights none', () => {
    expect(rows()).toEqual([])
    act(() => field().focus())
    expect(rows()).toEqual(['Books', 'Projects', 'Projects/Alpha', 'Journal'])
    expect(highlighted()).toBeNull()
    expect(field().getAttribute('aria-expanded')).toBe('true')
    const ticked = document.querySelector('[data-folder-picker-option="Projects"] svg')
    expect(ticked).toBeTruthy()
  })

  it('moves with the arrows and with Ctrl+N / Ctrl+P, and letters stay text', () => {
    act(() => field().focus())
    press('ArrowDown')
    expect(highlighted()).toBe('Books')
    press('n', { ctrlKey: true })
    expect(highlighted()).toBe('Projects')
    press('p', { ctrlKey: true })
    expect(highlighted()).toBe('Books')
    press('ArrowUp')
    expect(highlighted()).toBeNull()

    // A bare j is not a motion: it reaches the caller like any other key,
    // and typing it narrows the list as text.
    const j = press('j')
    expect(j.defaultPrevented).toBe(false)
    expect(onKeyDown).toHaveBeenCalledTimes(1)
    type('j')
    expect(rows()).toEqual(['Journal', 'Projects', 'Projects/Alpha'])
  })

  it('typing narrows and highlights the first match, which Enter picks', () => {
    act(() => field().focus())
    type('proj')
    expect(rows()).toEqual(['Projects', 'Projects/Alpha'])
    expect(highlighted()).toBe('Projects')
    press('ArrowDown')
    press('Enter')
    expect(onPick).toHaveBeenCalledWith('Projects/Alpha')
    expect(field().value).toBe('Projects/Alpha')
    expect(rows()).toEqual([])
    expect(onKeyDown).not.toHaveBeenCalled()
  })

  it('hands Enter on a typed path with no row to the caller', () => {
    act(() => field().focus())
    type('New/Folder')
    expect(rows()).toEqual([])
    press('Enter')
    expect(onPick).not.toHaveBeenCalled()
    expect(onKeyDown).toHaveBeenCalledWith(expect.objectContaining({ key: 'Enter' }))
  })

  it('Escape closes the list without reaching the window; the next one is the caller’s', () => {
    act(() => field().focus())
    press('Escape')
    expect(rows()).toEqual([])
    expect(windowKeys).not.toHaveBeenCalled()
    expect(onKeyDown).not.toHaveBeenCalled()
    press('Escape')
    expect(onKeyDown).toHaveBeenCalledWith(expect.objectContaining({ key: 'Escape' }))
    expect(windowKeys).toHaveBeenCalledTimes(1)
  })

  it('a click on a row picks it and keeps focus in the field', () => {
    act(() => field().focus())
    const row = document.querySelector<HTMLButtonElement>('[data-folder-picker-option="Journal"]')!
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    row.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
    act(() => row.click())
    expect(onPick).toHaveBeenCalledWith('Journal')
    expect(document.activeElement).toBe(field())
  })

  it('a window that loses focus and gets it back reopens the narrowed list', () => {
    act(() => field().focus())
    type('proj')
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    act(() => field().blur())
    expect(rows()).toEqual([])
    hasFocus.mockReturnValue(true)
    act(() => field().focus())
    expect(rows()).toEqual(['Projects', 'Projects/Alpha'])

    // Landing in the field anew, the window focused all along, lists
    // everything again.
    act(() => field().blur())
    act(() => field().focus())
    expect(rows()).toEqual(['Books', 'Projects', 'Projects/Alpha', 'Journal'])
    hasFocus.mockRestore()
  })

  it('leaves every key to an IME composition', () => {
    act(() => field().focus())
    const enter = press('Enter', { isComposing: true })
    expect(enter.defaultPrevented).toBe(false)
    const down = press('ArrowDown', { isComposing: true })
    expect(down.defaultPrevented).toBe(false)
    expect(highlighted()).toBeNull()
  })
})
