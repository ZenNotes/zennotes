function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/["\\]/g, '\\$&')
}

export function dispatchKeyboardContextMenu(el: HTMLElement): void {
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  const rect = el.getBoundingClientRect()
  const clientX = Math.min(
    window.innerWidth - 12,
    Math.max(12, rect.left + Math.min(28, Math.max(12, rect.width * 0.25)))
  )
  const clientY = Math.min(window.innerHeight - 12, Math.max(12, rect.top + rect.height / 2))
  el.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 2,
      buttons: 2,
      clientX,
      clientY
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
