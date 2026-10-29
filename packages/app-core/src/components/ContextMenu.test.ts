// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
