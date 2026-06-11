import type { KeyboardEvent } from 'react'
import { describe, expect, it } from 'vitest'
import { isPaletteNextKey, isPalettePreviousKey } from './palette-nav'

function key(init: Partial<KeyboardEvent<HTMLElement>>): KeyboardEvent<HTMLElement> {
  return {
    key: '',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...init
  } as KeyboardEvent<HTMLElement>
}

describe('isPaletteNextKey', () => {
  it('matches ArrowDown', () => {
    expect(isPaletteNextKey(key({ key: 'ArrowDown' }))).toBe(true)
  })

  it('matches Ctrl+N and the vim-style Ctrl+J', () => {
    expect(isPaletteNextKey(key({ key: 'n', ctrlKey: true }))).toBe(true)
    expect(isPaletteNextKey(key({ key: 'j', ctrlKey: true }))).toBe(true)
    expect(isPaletteNextKey(key({ key: 'J', ctrlKey: true }))).toBe(true)
  })

  it('ignores the chord when Meta or Alt is also held', () => {
    expect(isPaletteNextKey(key({ key: 'j', ctrlKey: true, metaKey: true }))).toBe(false)
    expect(isPaletteNextKey(key({ key: 'n', ctrlKey: true, altKey: true }))).toBe(false)
  })

  it('does not match the previous-item keys', () => {
    expect(isPaletteNextKey(key({ key: 'k', ctrlKey: true }))).toBe(false)
    expect(isPaletteNextKey(key({ key: 'p', ctrlKey: true }))).toBe(false)
    expect(isPaletteNextKey(key({ key: 'ArrowUp' }))).toBe(false)
  })

  it('requires Ctrl for the letter chords', () => {
    expect(isPaletteNextKey(key({ key: 'j' }))).toBe(false)
    expect(isPaletteNextKey(key({ key: 'n' }))).toBe(false)
  })
})

describe('isPalettePreviousKey', () => {
  it('matches ArrowUp', () => {
    expect(isPalettePreviousKey(key({ key: 'ArrowUp' }))).toBe(true)
  })

  it('matches Ctrl+P and the vim-style Ctrl+K', () => {
    expect(isPalettePreviousKey(key({ key: 'p', ctrlKey: true }))).toBe(true)
    expect(isPalettePreviousKey(key({ key: 'k', ctrlKey: true }))).toBe(true)
    expect(isPalettePreviousKey(key({ key: 'K', ctrlKey: true }))).toBe(true)
  })

  it('ignores the chord when Meta or Alt is also held', () => {
    expect(isPalettePreviousKey(key({ key: 'k', ctrlKey: true, metaKey: true }))).toBe(false)
    expect(isPalettePreviousKey(key({ key: 'p', ctrlKey: true, altKey: true }))).toBe(false)
  })

  it('does not match the next-item keys', () => {
    expect(isPalettePreviousKey(key({ key: 'j', ctrlKey: true }))).toBe(false)
    expect(isPalettePreviousKey(key({ key: 'n', ctrlKey: true }))).toBe(false)
    expect(isPalettePreviousKey(key({ key: 'ArrowDown' }))).toBe(false)
  })
})
