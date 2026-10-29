// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../store'
import { ContextMenu } from './ContextMenu'

describe('ContextMenu focus', () => {
  let host: HTMLDivElement
  let root: Root
  let opener: HTMLButtonElement

  const menu = () =>
    createElement(ContextMenu, {
      x: 10,
      y: 10,
      items: [{ label: "Move into Sep 25's note", onSelect: () => {} }],
      onClose: () => {}
    })

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    opener.remove()
  })

  it('holds the keyboard as soon as it mounts, not a frame later (#850)', async () => {
    await act(async () => root.render(menu()))
    expect(document.activeElement?.closest('[data-ctx-menu]')).toBeTruthy()
  })

  it('hands focus back to what held it when it closes', async () => {
    await act(async () => root.render(menu()))
    await act(async () => root.render(createElement('div')))
    expect(document.activeElement).toBe(opener)
  })
})

describe('ContextMenu picking one of a set (#1016)', () => {
  let host: HTMLDivElement
  let root: Root
  let picked: string[]

  const items = () =>
    ['Note', 'Tip', 'Danger (Error)', 'Warning'].map((label) => ({
      label,
      checked: label === 'Tip',
      keywords: label === 'Warning' ? ['caution'] : [],
      onSelect: () => {
        picked.push(label)
      }
    }))

  const menuEl = (): HTMLElement => document.querySelector('[data-ctx-menu]') as HTMLElement
  const press = (key: string): void => {
    menuEl().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  }
  const active = (): string | undefined =>
    [...menuEl().querySelectorAll('button')].find((b) => b.className.includes('bg-paper-200 '))
      ?.textContent ?? undefined

  beforeEach(async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    picked = []
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () =>
      root.render(
        createElement(ContextMenu, { x: 10, y: 10, title: 'Callout type', items: items(), onClose: () => {} })
      )
    )
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('shows its title and names the menu by it', () => {
    expect(menuEl().getAttribute('aria-label')).toBe('Callout type')
    expect(menuEl().textContent).toContain('Callout type')
  })

  it('starts on the checked item and marks it for assistive tech', () => {
    expect(active()).toBe('Tip')
    const tip = [...menuEl().querySelectorAll('button')].find((b) => b.textContent === 'Tip')
    expect(tip?.getAttribute('role')).toBe('menuitemradio')
    expect(tip?.getAttribute('aria-checked')).toBe('true')
  })

  it('finds an item by its label or by a keyword', async () => {
    await act(async () => {
      for (const ch of 'error') press(ch)
    })
    expect([...menuEl().querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Danger (Error)'])
    await act(async () => {
      for (let i = 0; i < 5; i++) press('Backspace')
      for (const ch of 'caution') press(ch)
    })
    expect([...menuEl().querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Warning'])
    await act(async () => press('Enter'))
    expect(picked).toEqual(['Warning'])
  })
})

describe('ContextMenu letters with Vim mode on and off', () => {
  let host: HTMLDivElement
  let root: Root

  const render = async (): Promise<void> => {
    await act(async () =>
      root.render(
        createElement(ContextMenu, {
          x: 10,
          y: 10,
          items: [{ label: 'Note' }, { label: 'Tip' }, { label: 'Quote' }].map((i) => ({
            ...i,
            onSelect: () => {}
          })),
          onClose: () => {}
        })
      )
    )
  }
  const menuEl = (): HTMLElement => document.querySelector('[data-ctx-menu]') as HTMLElement
  const press = (key: string): void => {
    menuEl().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  }
  const labels = (): Array<string | null> =>
    [...menuEl().querySelectorAll('button')].map((b) => b.textContent)
  const active = (): string | null | undefined =>
    [...menuEl().querySelectorAll('button')].find((b) => b.className.includes('bg-paper-200 '))
      ?.textContent

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    useStore.setState({ vimMode: false })
  })

  it('moves with j and k in Vim mode', async () => {
    useStore.setState({ vimMode: true })
    await render()
    await act(async () => press('j'))
    expect(active()).toBe('Tip')
    await act(async () => press('k'))
    expect(active()).toBe('Note')
  })

  it('reads j and k as filter letters with Vim mode off; the arrows still move', async () => {
    useStore.setState({ vimMode: false })
    await render()
    await act(async () => press('ArrowDown'))
    expect(active()).toBe('Tip')
    await act(async () => press('k'))
    expect(labels()).toEqual([])
    expect(menuEl().textContent).toContain('No matches')
  })
})

describe('ContextMenu with a find field (#1014)', () => {
  let host: HTMLDivElement
  let root: Root
  let picked: string[]

  const names = ['Text (plain)', 'Brainfuck', 'C', 'C++', 'Java', 'JavaScript', 'JSON', 'Kotlin', 'Python']
  const render = async (): Promise<void> => {
    await act(async () =>
      root.render(
        createElement(ContextMenu, {
          x: 10,
          y: 10,
          title: 'Code block language',
          findPlaceholder: 'Find a language',
          items: names.map((label) => ({
            label,
            checked: label === 'Text (plain)',
            keywords: label === 'JavaScript' ? ['js'] : label === 'Python' ? ['py'] : [],
            onSelect: () => {
              picked.push(label)
            }
          })),
          onClose: () => {}
        })
      )
    )
  }
  const menuEl = (): HTMLElement => document.querySelector('[data-ctx-menu]') as HTMLElement
  const field = (): HTMLInputElement => menuEl().querySelector('input') as HTMLInputElement
  const keydown = (target: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
    target.dispatchEvent(event)
    return event
  }
  const typeInField = (text: string): void => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    for (const ch of text) {
      if (keydown(field(), ch).defaultPrevented) continue
      setValue.call(field(), field().value + ch)
      field().dispatchEvent(new Event('input', { bubbles: true }))
    }
  }
  const rows = (): Array<string | null> => [...menuEl().querySelectorAll('button')].map((b) => b.textContent)
  const active = (): string | null | undefined =>
    [...menuEl().querySelectorAll('button')].find((b) => b.hasAttribute('data-ctx-active'))?.textContent

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    picked = []
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    useStore.setState({ vimMode: false })
    vi.unstubAllGlobals()
  })

  it('gives the field the keyboard with Vim off, and every letter is text there', async () => {
    await render()
    expect(document.activeElement).toBe(field())
    expect(active()).toBe('Text (plain)')
    await act(async () => typeInField('j'))
    expect(field().value).toBe('j')
    expect(rows()).toEqual(['Java', 'JavaScript', 'JSON'])
  })

  it('puts the exact match first, so a letter and Enter pick it', async () => {
    await render()
    await act(async () => typeInField('c'))
    expect(rows()[0]).toBe('C')
    expect(active()).toBe('C')
    await act(async () => keydown(field(), 'Enter'))
    expect(picked).toEqual(['C'])
  })

  it('finds by keyword and moves with the arrows and Ctrl+N / Ctrl+P from the field', async () => {
    await render()
    await act(async () => typeInField('py'))
    expect(rows()).toEqual(['Python'])
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setValue.call(field(), 'ja')
      field().dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(active()).toBe('Java')
    await act(async () => keydown(field(), 'ArrowDown'))
    expect(active()).toBe('JavaScript')
    await act(async () => keydown(field(), 'p', { ctrlKey: true }))
    expect(active()).toBe('Java')
    await act(async () => keydown(field(), 'n', { ctrlKey: true }))
    expect(active()).toBe('JavaScript')
  })

  it('clears the field on the first Escape and closes on the second', async () => {
    let closed = 0
    await act(async () =>
      root.render(
        createElement(ContextMenu, {
          x: 10,
          y: 10,
          findPlaceholder: 'Find a language',
          items: names.map((label) => ({ label, onSelect: () => {} })),
          onClose: () => {
            closed++
          }
        })
      )
    )
    await act(async () => typeInField('ko'))
    await act(async () => keydown(field(), 'Escape'))
    expect(field().value).toBe('')
    expect(closed).toBe(0)
    await act(async () => keydown(field(), 'Escape'))
    expect(closed).toBe(1)
  })

  it('keeps the list in charge with Vim on: j and k move, / goes to the field', async () => {
    useStore.setState({ vimMode: true })
    await render()
    expect(document.activeElement).toBe(menuEl())
    await act(async () => keydown(menuEl(), 'j'))
    expect(active()).toBe('Brainfuck')
    await act(async () => keydown(menuEl(), 'k'))
    expect(active()).toBe('Text (plain)')
    await act(async () => keydown(menuEl(), '/'))
    expect(document.activeElement).toBe(field())
    await act(async () => typeInField('j'))
    expect(field().value).toBe('j')
    expect(rows()).toEqual(['Java', 'JavaScript', 'JSON'])
  })

  it('opens on the list on a touch screen, so no keyboard covers it', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(pointer: coarse)' }))
    await render()
    expect(document.activeElement).toBe(menuEl())
    expect(field()).not.toBeNull()
  })
})
