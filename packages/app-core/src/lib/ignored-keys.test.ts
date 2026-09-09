// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_IGNORED_KEYS,
  ignoredKeyTokenFromEvent,
  installIgnoredKeysGuard,
  isIgnoredKeyEvent,
  normalizeIgnoredKeys,
  setIgnoredKeysRecorderActive
} from './ignored-keys'

describe('normalizeIgnoredKeys', () => {
  it('keeps trimmed unique names, ignoring case, and caps the list', () => {
    expect(normalizeIgnoredKeys([' KanaMode ', 'kanamode', 'F24', '', 3, null])).toEqual(['KanaMode', 'F24'])
    expect(normalizeIgnoredKeys('KanaMode')).toEqual([])
    const many = Array.from({ length: MAX_IGNORED_KEYS + 5 }, (_, i) => `F${i + 1}`)
    expect(normalizeIgnoredKeys(many)).toHaveLength(MAX_IGNORED_KEYS)
  })
})

describe('key matching', () => {
  it('matches by key or by physical code, case-insensitively', () => {
    const list = ['KanaMode', 'lang1']
    expect(isIgnoredKeyEvent({ key: 'KanaMode', code: 'KanaMode' }, list)).toBe(true)
    expect(isIgnoredKeyEvent({ key: 'Unidentified', code: 'Lang1' }, list)).toBe(true)
    expect(isIgnoredKeyEvent({ key: 'j', code: 'KeyJ' }, list)).toBe(false)
    expect(isIgnoredKeyEvent({ key: 'KanaMode', code: 'KanaMode' }, [])).toBe(false)
  })

  it('names a key by its DOM key, falling back to the code for unidentified keys', () => {
    expect(ignoredKeyTokenFromEvent(new KeyboardEvent('keydown', { key: 'KanaMode', code: 'KanaMode' }))).toBe('KanaMode')
    expect(ignoredKeyTokenFromEvent(new KeyboardEvent('keydown', { key: 'Unidentified', code: 'Lang1' }))).toBe('Lang1')
    expect(ignoredKeyTokenFromEvent(new KeyboardEvent('keydown', { key: 'Dead', code: 'Quote' }))).toBe('Quote')
  })
})

describe('installIgnoredKeysGuard', () => {
  let uninstall: (() => void) | null = null
  afterEach(() => {
    uninstall?.()
    uninstall = null
    setIgnoredKeysRecorderActive(false)
  })

  function press(target: EventTarget, key: string, type = 'keydown'): KeyboardEvent {
    const event = new KeyboardEvent(type, { key, code: key, bubbles: true, cancelable: true })
    target.dispatchEvent(event)
    return event
  }

  it('swallows listed keys before element listeners and leaves other keys alone', () => {
    const list: string[] = ['KanaMode']
    uninstall = installIgnoredKeysGuard(() => list)
    const editor = document.createElement('div')
    document.body.appendChild(editor)
    const seen: string[] = []
    editor.addEventListener('keydown', (e) => seen.push(`el:${e.key}`))
    document.addEventListener('keydown', (e) => seen.push(`doc:${e.key}`), true)
    window.addEventListener('keydown', (e) => seen.push(`win:${e.key}`), true)

    const noop = press(editor, 'KanaMode')
    expect(noop.defaultPrevented).toBe(true)
    expect(seen).toEqual([])

    const j = press(editor, 'j')
    expect(j.defaultPrevented).toBe(false)
    expect(seen).toEqual(['win:j', 'doc:j', 'el:j'])

    // keyup goes the same way, so a held-key tracker never sees half a pair.
    expect(press(editor, 'KanaMode', 'keyup').defaultPrevented).toBe(true)
    editor.remove()
  })

  it('reads the list live and stands aside while the recorder is capturing', () => {
    const list: string[] = []
    uninstall = installIgnoredKeysGuard(() => list)
    const target = document.createElement('div')
    document.body.appendChild(target)
    expect(press(target, 'KanaMode').defaultPrevented).toBe(false)
    list.push('KanaMode')
    expect(press(target, 'KanaMode').defaultPrevented).toBe(true)
    setIgnoredKeysRecorderActive(true)
    expect(press(target, 'KanaMode').defaultPrevented).toBe(false)
    setIgnoredKeysRecorderActive(false)
    expect(press(target, 'KanaMode').defaultPrevented).toBe(true)
    target.remove()
  })

  it('installs once', () => {
    const spy = vi.spyOn(window, 'addEventListener')
    uninstall = installIgnoredKeysGuard(() => [])
    const again = installIgnoredKeysGuard(() => [])
    expect(again).toBe(uninstall)
    expect(spy.mock.calls.filter((c) => c[0] === 'keydown').length).toBe(1)
    spy.mockRestore()
  })
})
