// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useKeyboardCursor } from './keyboard-cursor'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Probe(): JSX.Element {
  return createElement('output', null, useKeyboardCursor() ? 'drawn' : 'hidden')
}

let coarse = true
let host: HTMLDivElement
let root: Root

const shown = (): string | null => host.textContent

function press(key: string, target: EventTarget = document.body): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

function touch(pointerType: string): void {
  act(() => {
    const event = new MouseEvent('pointerdown', { bubbles: true })
    Object.defineProperty(event, 'pointerType', { value: pointerType })
    document.body.dispatchEvent(event)
  })
}

beforeEach(() => {
  coarse = true
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: coarse && query === '(pointer: coarse)', media: query })
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(createElement(Probe)))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('useKeyboardCursor', () => {
  it('draws where the pointer is fine, whatever happens', () => {
    act(() => root.unmount())
    coarse = false
    root = createRoot(host)
    act(() => root.render(createElement(Probe)))
    expect(shown()).toBe('drawn')
    touch('touch')
    expect(shown()).toBe('drawn')
  })

  it('stays hidden on touch alone', () => {
    expect(shown()).toBe('hidden')
    touch('touch')
    expect(shown()).toBe('hidden')
  })

  it('draws once a key is pressed on a tablet with a keyboard, until a finger comes back', () => {
    press('j')
    expect(shown()).toBe('drawn')
    touch('mouse')
    expect(shown()).toBe('drawn')
    touch('touch')
    expect(shown()).toBe('hidden')
  })

  it.each(['Shift', 'Meta', 'Unidentified'])('takes no notice of %s', (key) => {
    press(key)
    expect(shown()).toBe('hidden')
  })

  it.each(['input', 'textarea'])('takes no notice of typing in a %s', (tag) => {
    const field = document.createElement(tag)
    document.body.append(field)
    press('a', field)
    field.remove()
    expect(shown()).toBe('hidden')
  })

  it('takes no notice of typing in the editor', () => {
    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    const line = document.createElement('div')
    editor.append(line)
    document.body.append(editor)
    press('a', line)
    editor.remove()
    expect(shown()).toBe('hidden')
  })
})
