import type { KeyboardEvent } from 'react'
import { isPaletteNextKey, isPalettePreviousKey } from './palette-nav'

/**
 * Keys for the settings search. Settings already took the keyboard when it
 * opened, but its search could only be driven with the mouse: Enter in the
 * field did nothing, the arrows did not move through the results, and once
 * focus had moved on there was no key to get back to it. (#108)
 */

/** What a key pressed in the search field asks for. Same keys as the palettes. */
export function settingsSearchFieldAction(
  event: KeyboardEvent<HTMLElement>
): 'open' | 'next' | 'previous' | null {
  if (isPaletteNextKey(event)) return 'next'
  if (isPalettePreviousKey(event)) return 'previous'
  const bare = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
  return event.key === 'Enter' && bare ? 'open' : null
}

/** The result to land on, clamped to the list instead of wrapping past it. */
export function settingsSearchStep(
  action: 'open' | 'next' | 'previous',
  current: number,
  count: number
): number {
  if (count <= 0) return -1
  const at = Math.min(Math.max(current, 0), count - 1)
  if (action === 'next') return Math.min(at + 1, count - 1)
  if (action === 'previous') return Math.max(at - 1, 0)
  return at
}

/**
 * Whether a key pressed anywhere in Settings should jump to its search field:
 * Mod+F always, and `/` in Vim mode, the key that searches everywhere else in
 * the app. The single key stays Vim-only, and a `/` typed into a field is text.
 */
export function isSettingsFindKey(
  event: Pick<KeyboardEvent<HTMLElement>, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  context: { vimMode: boolean; mac: boolean; typing: boolean }
): boolean {
  const mod = context.mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') return true
  const bare = !event.metaKey && !event.ctrlKey && !event.altKey
  return context.vimMode && !context.typing && bare && event.key === '/'
}
