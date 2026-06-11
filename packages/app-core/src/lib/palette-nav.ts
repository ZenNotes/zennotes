import type { KeyboardEvent } from 'react'

// Palettes accept three flavours of "move selection": the arrow keys,
// the Emacs-style Ctrl+N/Ctrl+P, and the vim-style Ctrl+J/Ctrl+K. The
// vim pair matters because ZenNotes is keyboard-first and j/k is
// "down/up" everywhere else in the app.
export function isPaletteNextKey(event: KeyboardEvent<HTMLElement>): boolean {
  const key = event.key.toLowerCase()
  return (
    event.key === 'ArrowDown' ||
    (event.ctrlKey && !event.metaKey && !event.altKey && (key === 'n' || key === 'j'))
  )
}

export function isPalettePreviousKey(event: KeyboardEvent<HTMLElement>): boolean {
  const key = event.key.toLowerCase()
  return (
    event.key === 'ArrowUp' ||
    (event.ctrlKey && !event.metaKey && !event.altKey && (key === 'p' || key === 'k'))
  )
}
