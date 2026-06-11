import type { KeyboardEvent } from 'react'
import { completionStatus, moveCompletionSelection } from '@codemirror/autocomplete'
import { useStore, type PaletteNavKeys } from '../store'
import { isPaletteNavShortcutKey } from './palette-nav-shortcuts'

type PaletteKeyboardEvent = Pick<
  KeyboardEvent<HTMLElement> | globalThis.KeyboardEvent,
  'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey' | 'stopPropagation'
>

export function paletteNavHintLabel(keys: PaletteNavKeys): string {
  if (keys === 'ctrl-jk') return 'Ctrl+J/K'
  if (keys === 'ctrl-np') return 'Ctrl+N/P'
  return 'Ctrl+N/P or J/K'
}

export function paletteNavModeClass(keys: PaletteNavKeys): string {
  return `palette-nav-${keys}`
}

function paletteNavKeys(): PaletteNavKeys {
  return useStore.getState().paletteNavKeys
}

export { isPaletteNavShortcutKey } from './palette-nav-shortcuts'

function isPlainCtrlKey(event: PaletteKeyboardEvent, key: string): boolean {
  return isPaletteNavShortcutKey(event) && event.key.toLowerCase() === key
}

export function isPaletteNextKey(event: PaletteKeyboardEvent): boolean {
  const keys = paletteNavKeys()
  const match =
    event.key === 'ArrowDown' ||
    ((keys === 'ctrl-np' || keys === 'both') && isPlainCtrlKey(event, 'n')) ||
    ((keys === 'ctrl-jk' || keys === 'both') && isPlainCtrlKey(event, 'j'))
  if (match) event.stopPropagation()
  return match
}

export function isPalettePreviousKey(event: PaletteKeyboardEvent): boolean {
  const keys = paletteNavKeys()
  const match =
    event.key === 'ArrowUp' ||
    ((keys === 'ctrl-np' || keys === 'both') && isPlainCtrlKey(event, 'p')) ||
    ((keys === 'ctrl-jk' || keys === 'both') && isPlainCtrlKey(event, 'k'))
  if (match) event.stopPropagation()
  return match
}

function completionMove(forward: boolean, key: PaletteNavKeys) {
  return (view: import('@codemirror/view').EditorView): boolean => {
    const keys = paletteNavKeys()
    const active = completionStatus(view.state) === 'active'
    if (keys !== key && keys !== 'both') return active
    if (!active) return false
    return moveCompletionSelection(forward)(view)
  }
}

export function paletteCompletionKeymaps(): { key: string; run: (view: import('@codemirror/view').EditorView) => boolean }[] {
  return [
    { key: 'Ctrl-n', run: completionMove(true, 'ctrl-np') },
    { key: 'Ctrl-p', run: completionMove(false, 'ctrl-np') },
    { key: 'Ctrl-j', run: completionMove(true, 'ctrl-jk') },
    { key: 'Ctrl-k', run: completionMove(false, 'ctrl-jk') }
  ]
}
