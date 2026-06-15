import { describe, expect, it } from 'vitest'
import { completionNavDirection } from './cm-completion-nav'

function key(init: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: '',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...init
  } as KeyboardEvent
}

describe('completionNavDirection', () => {
  it('maps Ctrl+N and Ctrl+J to next when Vim mode is enabled', () => {
    expect(completionNavDirection(key({ key: 'n', ctrlKey: true }))).toBe('next')
    expect(completionNavDirection(key({ key: 'j', ctrlKey: true }))).toBe('next')
    expect(completionNavDirection(key({ key: 'J', ctrlKey: true }))).toBe('next')
  })

  it('ignores Ctrl+J when Vim mode is disabled', () => {
    expect(completionNavDirection(key({ key: 'n', ctrlKey: true }), false)).toBe('next')
    expect(completionNavDirection(key({ key: 'j', ctrlKey: true }), false)).toBeNull()
  })

  it('maps Ctrl+P and Ctrl+K to previous when Vim mode is enabled', () => {
    expect(completionNavDirection(key({ key: 'p', ctrlKey: true }))).toBe('previous')
    expect(completionNavDirection(key({ key: 'k', ctrlKey: true }))).toBe('previous')
    expect(completionNavDirection(key({ key: 'K', ctrlKey: true }))).toBe('previous')
  })

  it('ignores Ctrl+K when Vim mode is disabled', () => {
    expect(completionNavDirection(key({ key: 'p', ctrlKey: true }), false)).toBe('previous')
    expect(completionNavDirection(key({ key: 'k', ctrlKey: true }), false)).toBeNull()
  })

  it('only fires for a bare Ctrl chord', () => {
    expect(completionNavDirection(key({ key: 'p' }))).toBeNull()
    expect(completionNavDirection(key({ key: 'p', ctrlKey: true, metaKey: true }))).toBeNull()
    expect(completionNavDirection(key({ key: 'p', ctrlKey: true, altKey: true }))).toBeNull()
    // Shift is left alone so Ctrl+Shift+P still reaches the command palette.
    expect(completionNavDirection(key({ key: 'p', ctrlKey: true, shiftKey: true }))).toBeNull()
  })

  it('ignores keys it does not own', () => {
    expect(completionNavDirection(key({ key: 'a', ctrlKey: true }))).toBeNull()
    expect(completionNavDirection(key({ key: 'ArrowDown' }))).toBeNull()
    expect(completionNavDirection(key({ key: 'ArrowUp' }))).toBeNull()
  })
})
