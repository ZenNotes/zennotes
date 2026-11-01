import { useMemo } from 'react'
import { isTouchPrimaryDevice } from './cm-vim-ime-guard'

/**
 * Whether to draw the keyboard's cursor: the tint, ring or key hints on the
 * row, card or cell the keys act on. A touch-first device (a phone) has no
 * keyboard to move it, so lists, boards and grids there draw none. Only the
 * drawing depends on this; the cursor itself, its refs and the scroll that
 * follows it stay as they are. Read once per mount.
 */
export function useKeyboardCursor(): boolean {
  return useMemo(() => !isTouchPrimaryDevice(), [])
}
