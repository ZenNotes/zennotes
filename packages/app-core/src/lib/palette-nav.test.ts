// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isPaletteNavShortcutKey,
  isPaletteNextKey,
  isPalettePreviousKey,
  paletteNavHintLabel,
  paletteNavModeClass
} from './palette-nav'
import { useStore } from '../store'
import { shouldBlockGlobalPaletteNavShortcut } from './palette-nav-shortcuts'

function keyEvent(key: string) {
  return {
    key,
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    stopPropagation: vi.fn()
  }
}

function domKeyEvent(key: string) {
  return new KeyboardEvent('keydown', { key, ctrlKey: true })
}

describe('palette navigation keys', () => {
  beforeEach(() => {
    useStore.setState({ paletteNavKeys: 'both' })
  })

  it('formats the footer hint for each mode', () => {
    expect(paletteNavHintLabel('ctrl-np')).toBe('Ctrl+N/P')
    expect(paletteNavHintLabel('ctrl-jk')).toBe('Ctrl+J/K')
    expect(paletteNavHintLabel('both')).toBe('Ctrl+N/P or J/K')
  })

  it('formats the CSS mode class for wikilink completion hints', () => {
    expect(paletteNavModeClass('ctrl-np')).toBe('palette-nav-ctrl-np')
    expect(paletteNavModeClass('ctrl-jk')).toBe('palette-nav-ctrl-jk')
    expect(paletteNavModeClass('both')).toBe('palette-nav-both')
  })

  it('recognizes unconfigured completion navigation shortcuts for propagation blocking', () => {
    useStore.setState({ paletteNavKeys: 'ctrl-jk' })

    expect(isPalettePreviousKey(keyEvent('p'))).toBe(false)
    expect(isPaletteNavShortcutKey(keyEvent('p'))).toBe(true)
  })

  it('blocks global palette shortcuts only while a CodeMirror autocomplete is active', () => {
    const editor = document.createElement('div')
    editor.className = 'cm-editor'
    editor.tabIndex = -1
    const tooltip = document.createElement('div')
    tooltip.className = 'cm-tooltip-autocomplete'
    document.body.append(editor, tooltip)
    editor.focus()

    expect(shouldBlockGlobalPaletteNavShortcut(domKeyEvent('p'))).toBe(true)

    tooltip.remove()
    expect(shouldBlockGlobalPaletteNavShortcut(domKeyEvent('p'))).toBe(false)

    editor.remove()
  })

  it('uses Ctrl+N/P only when configured', () => {
    useStore.setState({ paletteNavKeys: 'ctrl-np' })

    expect(isPaletteNextKey(keyEvent('n'))).toBe(true)
    expect(isPalettePreviousKey(keyEvent('p'))).toBe(true)
    expect(isPaletteNextKey(keyEvent('j'))).toBe(false)
    expect(isPalettePreviousKey(keyEvent('k'))).toBe(false)
  })

  it('uses Ctrl+J/K only when configured', () => {
    useStore.setState({ paletteNavKeys: 'ctrl-jk' })

    expect(isPaletteNextKey(keyEvent('j'))).toBe(true)
    expect(isPalettePreviousKey(keyEvent('k'))).toBe(true)
    expect(isPaletteNextKey(keyEvent('n'))).toBe(false)
    expect(isPalettePreviousKey(keyEvent('p'))).toBe(false)
  })
})
