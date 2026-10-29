import { describe, expect, it } from 'vitest'
import { createFocusHealGate } from './focus-heal'

describe('the focus heal gate', () => {
  it('always heals on desktop, which does not open notes to read', () => {
    const gate = createFocusHealGate()
    expect(gate.returned(false)).toBe(true)
    gate.left(false)
    expect(gate.returned(false)).toBe(true)
  })

  it('on a host that opens notes to read, heals only for someone who was typing', () => {
    const gate = createFocusHealGate()
    // A fresh page left nothing: reading.
    expect(gate.returned(true)).toBe(false)
    // Reading a note, the app goes away (blur, then hidden) and comes back
    // (visible, then focus): the keyboard stays down for both returns.
    gate.left(false)
    gate.left(false)
    expect(gate.returned(true)).toBe(false)
    expect(gate.returned(true)).toBe(false)
    // Typing as the app was left: any of the leave events seeing the editor
    // focused counts, and the heal brings the keyboard back.
    gate.left(true)
    gate.left(false)
    expect(gate.returned(true)).toBe(true)
    expect(gate.returned(true)).toBe(true)
    // The next time away starts over.
    gate.left(false)
    expect(gate.returned(true)).toBe(false)
  })
})
