function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/["\\]/g, '\\$&')
}

export const ZEN_OPEN_EDITOR_CONTEXT_MENU_EVENT = 'zen:open-editor-context-menu'

type MenuKeyEvent = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey'>

/** Shift+F10 or the Context Menu key: the keyboard's right-click. */
export function isKeyboardContextMenuKey(e: MenuKeyEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false
  return e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')
}

/**
 * Whether the editor opens its own right-click menu for this key. Off macOS
 * Chromium turns the key into a contextmenu event at the caret, which the
 * editor's contextmenu handler answers like a right-click; on macOS it sends
 * none, so with Vim mode off the keys did nothing in the editor there. With
 * Vim mode on VimNav decides (the editor's menu over a selection, the tab's
 * otherwise), on every platform.
 */
export function editorOpensKeyboardContextMenu(
  e: MenuKeyEvent,
  host: { vimMode: boolean; mac: boolean }
): boolean {
  return !host.vimMode && host.mac && isKeyboardContextMenuKey(e)
}

/**
 * Where a keyboard-opened menu anchors on an element: just inside its left
 * edge, vertically centred, clamped to the viewport so a row at the screen's
 * edge cannot push the menu off it.
 */
export function keyboardMenuPosition(rect: DOMRect): { x: number; y: number } {
  const x = Math.min(
    window.innerWidth - 12,
    Math.max(12, rect.left + Math.min(28, Math.max(12, rect.width * 0.25)))
  )
  const y = Math.min(window.innerHeight - 12, Math.max(12, rect.top + rect.height / 2))
  return { x, y }
}

export function dispatchKeyboardContextMenu(el: HTMLElement): void {
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  const { x, y } = keyboardMenuPosition(el.getBoundingClientRect())
  el.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 2,
      buttons: 2,
      clientX: x,
      clientY: y
    })
  )
}

export function findTabContextMenuTarget(
  paneId: string,
  path: string
): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    [
      '[data-tab-menu-target="true"]',
      `[data-tab-pane-id="${cssEscape(paneId)}"]`,
      `[data-tab-path="${cssEscape(path)}"]`
    ].join('')
  )
}
