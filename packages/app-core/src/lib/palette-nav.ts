import type { KeyboardEvent } from 'react'

export function isPaletteNextKey(event: KeyboardEvent<HTMLElement>): boolean {
  const key = event.key.toLowerCase()
  return (
    event.key === 'ArrowDown' ||
    (event.ctrlKey && !event.metaKey && !event.altKey && key === 'n')
  )
}

export function isPalettePreviousKey(event: KeyboardEvent<HTMLElement>): boolean {
  const key = event.key.toLowerCase()
  return (
    event.key === 'ArrowUp' ||
    (event.ctrlKey && !event.metaKey && !event.altKey && key === 'p')
  )
}
