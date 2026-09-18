import type { KeyboardEvent } from 'react'
import { describe, expect, it } from 'vitest'
import {
  isSettingsFindKey,
  settingsSearchFieldAction,
  settingsSearchStep
} from './settings-search-keys'

const key = (init: Partial<KeyboardEvent<HTMLElement>>): KeyboardEvent<HTMLElement> =>
  ({ key: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init }) as KeyboardEvent<HTMLElement>

describe('settings search field keys (#108)', () => {
  it('opens the highlighted result on a bare Enter', () => {
    expect(settingsSearchFieldAction(key({ key: 'Enter' }))).toBe('open')
    expect(settingsSearchFieldAction(key({ key: 'Enter', shiftKey: true }))).toBeNull()
    expect(settingsSearchFieldAction(key({ key: 'Enter', metaKey: true }))).toBeNull()
  })

  it('moves through the results with the same keys as the palettes', () => {
    for (const next of [{ key: 'ArrowDown' }, { key: 'n', ctrlKey: true }, { key: 'j', ctrlKey: true }]) {
      expect(settingsSearchFieldAction(key(next))).toBe('next')
    }
    for (const previous of [{ key: 'ArrowUp' }, { key: 'p', ctrlKey: true }, { key: 'k', ctrlKey: true }]) {
      expect(settingsSearchFieldAction(key(previous))).toBe('previous')
    }
  })

  it('leaves ordinary typing alone', () => {
    for (const typed of ['f', 'j', 'k', '/', ' ', 'Backspace', 'Tab', 'Escape']) {
      expect(settingsSearchFieldAction(key({ key: typed }))).toBeNull()
    }
  })

  it('steps through the list and stops at its ends instead of wrapping', () => {
    expect(settingsSearchStep('next', 0, 3)).toBe(1)
    expect(settingsSearchStep('next', 2, 3)).toBe(2)
    expect(settingsSearchStep('previous', 0, 3)).toBe(0)
    expect(settingsSearchStep('previous', 2, 3)).toBe(1)
    // Enter opens whatever is highlighted; with nothing highlighted yet, the first.
    expect(settingsSearchStep('open', 1, 3)).toBe(1)
    expect(settingsSearchStep('open', -1, 3)).toBe(0)
    expect(settingsSearchStep('next', -1, 3)).toBe(1)
    expect(settingsSearchStep('open', 0, 0)).toBe(-1)
  })
})

describe('jumping to the settings search (#108)', () => {
  const mac = { vimMode: false, mac: true, typing: false }
  const other = { vimMode: false, mac: false, typing: false }

  it('takes Mod+F on every platform, from a field or not', () => {
    expect(isSettingsFindKey(key({ key: 'f', metaKey: true }), mac)).toBe(true)
    expect(isSettingsFindKey(key({ key: 'f', metaKey: true }), { ...mac, typing: true })).toBe(true)
    expect(isSettingsFindKey(key({ key: 'f', ctrlKey: true }), other)).toBe(true)
    // The other platform's modifier is not Mod here.
    expect(isSettingsFindKey(key({ key: 'f', ctrlKey: true }), mac)).toBe(false)
    expect(isSettingsFindKey(key({ key: 'f', metaKey: true }), other)).toBe(false)
    expect(isSettingsFindKey(key({ key: 'f', metaKey: true, shiftKey: true }), mac)).toBe(false)
    expect(isSettingsFindKey(key({ key: 'f' }), mac)).toBe(false)
  })

  // Single-key shortcuts are a Vim-mode thing; with Vim off `/` does nothing.
  it('takes / only in Vim mode, and never while typing in a field', () => {
    expect(isSettingsFindKey(key({ key: '/' }), { ...mac, vimMode: true })).toBe(true)
    expect(isSettingsFindKey(key({ key: '/' }), mac)).toBe(false)
    expect(isSettingsFindKey(key({ key: '/' }), { ...mac, vimMode: true, typing: true })).toBe(false)
    expect(isSettingsFindKey(key({ key: '/', ctrlKey: true }), { ...mac, vimMode: true })).toBe(false)
  })
})
