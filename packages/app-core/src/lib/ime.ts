import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

/**
 * True while an IME (Japanese / Chinese / Korean, etc.) composition is in
 * progress. The keystroke that confirms an IME conversion is usually Enter (and
 * Space/Arrows/Tab navigate candidates), so our own keydown handlers must ignore
 * those keys while composing — otherwise pressing Enter to accept a conversion
 * also submits the rename, selects the search result, blurs the field, and so
 * on.
 *
 * `isComposing` is the standard signal; `keyCode === 229` is the legacy fallback
 * some browsers/IMEs still report during composition. (#183)
 */
export function isImeComposing(e: ReactKeyboardEvent | KeyboardEvent): boolean {
  const composing = 'nativeEvent' in e ? e.nativeEvent.isComposing : e.isComposing
  return composing || e.keyCode === 229
}
