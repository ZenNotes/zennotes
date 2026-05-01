import { describe, expect, it } from 'vitest'
import { shortcutBindingFromEvent, sequenceTokenFromEvent } from './keymaps'

interface FakeEventInit {
  key: string
  code: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

function fakeEvent(init: FakeEventInit): KeyboardEvent {
  return {
    key: init.key,
    code: init.code,
    ctrlKey: !!init.ctrlKey,
    metaKey: !!init.metaKey,
    altKey: !!init.altKey,
    shiftKey: !!init.shiftKey
  } as KeyboardEvent
}

describe('shortcutBindingFromEvent', () => {
  it('uses the typed character on Colemak (Cmd+P fires on the key that types p)', () => {
    // On Colemak the 'p' character lives at the QWERTY-R position.
    const event = fakeEvent({ key: 'p', code: 'KeyR', metaKey: true })
    expect(shortcutBindingFromEvent(event)).toBe('Mod+P')
  })

  it('preserves Hyper+J on QWERTY when event.key is the Alt-mangled glyph', () => {
    // ⌃⌥⇧⌘+J on US QWERTY produces 'Ô' in event.key.
    const event = fakeEvent({
      key: 'Ô',
      code: 'KeyJ',
      ctrlKey: true,
      altKey: true,
      shiftKey: true,
      metaKey: true
    })
    expect(shortcutBindingFromEvent(event)).toBe('Ctrl+Alt+Shift+Mod+J')
  })

  it('falls back to event.code for Alt+digit when event.key is non-ASCII', () => {
    // Alt+1 on US Mac produces '¡' (codepoint 0xA1, outside ASCII).
    const event = fakeEvent({ key: '¡', code: 'Digit1', altKey: true, metaKey: true })
    expect(shortcutBindingFromEvent(event)).toBe('Alt+Mod+1')
  })

  it('records plain Cmd+1 as Mod+1', () => {
    const event = fakeEvent({ key: '1', code: 'Digit1', metaKey: true })
    expect(shortcutBindingFromEvent(event)).toBe('Mod+1')
  })

  it('records Shift+digit as the typed symbol (Shift+Mod+!)', () => {
    const event = fakeEvent({ key: '!', code: 'Digit1', shiftKey: true, metaKey: true })
    expect(shortcutBindingFromEvent(event)).toBe('Shift+Mod+!')
  })

  it('handles named keys via the event.key fallback path', () => {
    const event = fakeEvent({ key: 'Escape', code: 'Escape' })
    expect(shortcutBindingFromEvent(event)).toBe('Escape')
  })

  it('returns null for modifier-only events', () => {
    const event = fakeEvent({ key: 'Shift', code: 'ShiftLeft', shiftKey: true })
    expect(shortcutBindingFromEvent(event)).toBeNull()
  })

  it('records Shift+Cmd+= as Shift+Mod+= (event.key="+" must not collide with the binding separator)', () => {
    // Shift+= on QWERTY types '+'; emitting the literal '+' would
    // produce "Mod+Shift++" which the parser strips back to "Shift",
    // dropping the key. The fast path must skip '+' so we fall back
    // to event.code='Equal' -> '='.
    const event = fakeEvent({ key: '+', code: 'Equal', shiftKey: true, metaKey: true })
    expect(shortcutBindingFromEvent(event)).toBe('Shift+Mod+=')
  })
})

describe('sequenceTokenFromEvent', () => {
  it('records the typed character for unmodified letters on Colemak', () => {
    // Colemak user pressing the key that types 'j' (QWERTY-N position).
    const event = fakeEvent({ key: 'j', code: 'KeyN' })
    expect(sequenceTokenFromEvent(event)).toBe('j')
  })

  it('preserves Shift+letter case', () => {
    const event = fakeEvent({ key: 'G', code: 'KeyG', shiftKey: true })
    expect(sequenceTokenFromEvent(event)).toBe('G')
  })

  it('falls back to event.code when event.key is mangled by Alt', () => {
    const event = fakeEvent({ key: 'ˆ', code: 'KeyI', altKey: true, ctrlKey: true })
    expect(sequenceTokenFromEvent(event)).toBe('Ctrl+Alt+I')
  })

  it('handles dead-key composition by falling back to event.code', () => {
    const event = fakeEvent({ key: 'Dead', code: 'KeyE' })
    expect(sequenceTokenFromEvent(event)).toBe('e')
  })

  it('records Shift+= as a sequence token of "=" (event.key="+" falls back to code)', () => {
    const event = fakeEvent({ key: '+', code: 'Equal', shiftKey: true })
    expect(sequenceTokenFromEvent(event)).toBe('=')
  })
})
