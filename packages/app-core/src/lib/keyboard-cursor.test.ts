// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { useKeyboardCursor } from './keyboard-cursor'

const original = Object.getOwnPropertyDescriptor(window, 'matchMedia')

function pointer(coarse: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: coarse && query === '(pointer: coarse)' })
  })
}

async function read(): Promise<boolean> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  let seen: boolean | undefined
  function Probe(): null {
    seen = useKeyboardCursor()
    return null
  }
  const host = document.createElement('div')
  const root = createRoot(host)
  await act(async () => root.render(createElement(Probe)))
  act(() => root.unmount())
  return seen!
}

describe('useKeyboardCursor', () => {
  afterEach(() => {
    if (original) Object.defineProperty(window, 'matchMedia', original)
    else delete (window as { matchMedia?: unknown }).matchMedia
  })

  it('draws the cursor where there is a keyboard', async () => {
    pointer(false)
    expect(await read()).toBe(true)
  })

  it('draws none on a touch-first device, a phone', async () => {
    pointer(true)
    expect(await read()).toBe(false)
  })
})
