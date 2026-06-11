type PaletteKeyboardEvent = Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'
>

export function isPaletteNavShortcutKey(event: PaletteKeyboardEvent): boolean {
  return (
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    ['n', 'p', 'j', 'k'].includes(event.key.toLowerCase())
  )
}

export function shouldBlockGlobalPaletteNavShortcut(event: KeyboardEvent, doc: Document = document): boolean {
  if (!isPaletteNavShortcutKey(event)) return false
  const active = doc.activeElement
  if (!(active instanceof HTMLElement)) return false
  if (active.closest('.cm-editor') === null) return false
  return doc.querySelector('.cm-tooltip-autocomplete') !== null
}
