/**
 * True when a blocking overlay — a prompt/confirm modal or a context menu — is
 * open. The built-in list views (Trash, Archive, Tasks, Tags, Quick Notes)
 * register global capture-phase keydown handlers; they must bail while an
 * overlay is open so it owns the keyboard. Otherwise keys fire *through* the
 * overlay: e.g. the Trash delete-confirm dialog would be bypassed by Enter and
 * repeated Enter would keep deleting. Both PromptModal and ConfirmModal carry
 * `data-prompt-modal`; ContextMenu carries `data-ctx-menu`.
 */
export function isAppOverlayOpen(): boolean {
  if (typeof document === 'undefined') return false
  return !!(
    document.querySelector('[data-prompt-modal]') || document.querySelector('[data-ctx-menu]')
  )
}
