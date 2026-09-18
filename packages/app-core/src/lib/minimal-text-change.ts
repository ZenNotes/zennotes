/**
 * The smallest single replacement that turns `before` into `after`: whatever
 * sits between their common prefix and common suffix.
 *
 * The editor uses it when a note's text changes underneath it (another pane
 * typed, a rename rewrote the title heading or a link, the file changed on
 * disk). Replacing the whole document would say "everything changed", and
 * CodeMirror would then map the caret and every stored undo step through
 * "everything": the caret can only be clamped and the undo steps collapse to
 * nothing. A small change says what really happened, so the caret stays on its
 * text and undo keeps working around the edit.
 */
export interface TextChange {
  from: number
  to: number
  insert: string
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff

/** `null` when the two texts are the same. Positions are in `before`. */
export function minimalTextChange(before: string, after: string): TextChange | null {
  if (before === after) return null
  const shorter = Math.min(before.length, after.length)
  let prefix = 0
  while (prefix < shorter && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++
  // Never cut an astral character in half: a change boundary inside a
  // surrogate pair would leave the caret able to land between its halves.
  if (prefix > 0 && isHighSurrogate(before.charCodeAt(prefix - 1))) prefix--
  let suffix = 0
  while (
    suffix < shorter - prefix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix++
  }
  if (suffix > 0 && isLowSurrogate(before.charCodeAt(before.length - suffix))) suffix--
  return {
    from: prefix,
    to: before.length - suffix,
    insert: after.slice(prefix, after.length - suffix)
  }
}
