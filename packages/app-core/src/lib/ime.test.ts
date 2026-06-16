import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { describe, expect, it } from 'vitest'
import { isImeComposing } from './ime'

// React synthetic events expose composition state on `.nativeEvent`; raw DOM
// listeners (window/document) get a native KeyboardEvent with `.isComposing`.
function reactEvent(isComposing: boolean, keyCode = 13): ReactKeyboardEvent {
  return { nativeEvent: { isComposing } as KeyboardEvent, keyCode } as ReactKeyboardEvent
}
function nativeEvent(isComposing: boolean, keyCode = 13): KeyboardEvent {
  return { isComposing, keyCode } as KeyboardEvent
}

describe('isImeComposing (#183)', () => {
  it('is true while a React synthetic event is composing', () => {
    expect(isImeComposing(reactEvent(true))).toBe(true)
  })

  it('is false for a React Enter that is not composing', () => {
    expect(isImeComposing(reactEvent(false))).toBe(false)
  })

  it('reads composition state from a native KeyboardEvent (no nativeEvent field)', () => {
    expect(isImeComposing(nativeEvent(true))).toBe(true)
    expect(isImeComposing(nativeEvent(false))).toBe(false)
  })

  it('honors the legacy keyCode === 229 fallback for both event shapes', () => {
    expect(isImeComposing(reactEvent(false, 229))).toBe(true)
    expect(isImeComposing(nativeEvent(false, 229))).toBe(true)
  })
})
