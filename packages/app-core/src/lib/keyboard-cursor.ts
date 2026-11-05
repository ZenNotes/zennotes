import { useSyncExternalStore } from 'react'
import { isTouchPrimaryDevice } from './cm-vim-ime-guard'

// A tablet in a keyboard case with no trackpad still reports a coarse pointer, and
// its keys move the cursor. So a key outside a text field says a keyboard is there,
// and a finger on the screen says we are back to touch. A text field does not count:
// that is where an on-screen keyboard types.
let keysInUse = false
const listeners = new Set<() => void>()

function setKeysInUse(next: boolean): void {
  if (next === keysInUse) return
  keysInUse = next
  listeners.forEach((listener) => listener())
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return !!target.closest('input, textarea, select, [contenteditable="true"]')
}

function onKeyDown(event: KeyboardEvent): void {
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Unidentified', 'Dead'].includes(event.key)) return
  if (!isTextEntry(event.target)) setKeysInUse(true)
}

function onPointerDown(event: PointerEvent): void {
  if (event.pointerType === 'touch') setKeysInUse(false)
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('pointerdown', onPointerDown, true)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('pointerdown', onPointerDown, true)
      keysInUse = false
    }
  }
}

/**
 * Whether to draw the keyboard's cursor: the tint, ring or key hints on the
 * row, card or cell the keys act on. A touch-first device has no keyboard to move
 * it until one shows up, so lists, boards and grids there draw none until a key
 * is pressed. Only the drawing depends on this; the cursor itself, its refs and the
 * scroll that follows it stay as they are.
 */
export function useKeyboardCursor(): boolean {
  return useSyncExternalStore(subscribe, () => keysInUse || !isTouchPrimaryDevice())
}
