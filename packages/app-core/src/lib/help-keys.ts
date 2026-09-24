import { formatKeyToken } from './keymaps'

/** A key (or chord, or ex command) drawn as a keycap, or the quiet mark
 *  between two alternatives. */
export interface HelpKeyPart {
  kind: 'key' | 'separator'
  text: string
}

export interface HelpKeys {
  parts: HelpKeyPart[]
  /** A trailing aside such as "(in Search notes)": it says where the keys
   *  work, so it sits beside the keycaps instead of inside one. */
  context: string | null
}

// The order the keymap recorder stores modifiers in (normalizeModifiers in
// keymaps.ts), which is also the order macOS menus draw them in: ⌃⌥⇧⌘.
const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Mod', 'Meta']
const COMBO = /^(?:(?:Ctrl|Alt|Shift|Mod|Meta)\+)+[^\s+]+$/

// Manual rows that are not tied to a keymap id spell keys the portable way
// (`Shift+Mod+T`). No keyboard has a Mod key, so a combo that uses it is drawn
// the way the rest of the app draws bindings: ⇧⌘T on macOS, Shift+Ctrl+T
// elsewhere. Combos without Mod already name real keys and stay as written,
// which keeps them matching the prose that mentions them.
function formatCombo(token: string, mac: boolean): string {
  if (!COMBO.test(token)) return token
  const modifiers = token.split('+')
  const key = modifiers.pop() as string
  if (!modifiers.includes('Mod')) return token
  const ordered = [...new Set(modifiers)].sort(
    (a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b)
  )
  return formatKeyToken([...ordered, key].join('+'), mac)
}

function formatKeys(text: string, mac: boolean): string {
  return text
    .split(/(\s+)/)
    .map((piece) => formatCombo(piece, mac))
    .join('')
}

/**
 * Splits a manual row's key text into keycaps. `A / B / C` becomes one keycap
 * per alternative only when every alternative has the same shape: shorthand
 * such as `Ctrl-w h / j / k / l` stays a single keycap, because a lone `j`
 * would read as a different key.
 */
export function parseHelpKeys(raw: string, mac: boolean): HelpKeys {
  const aside = /^(.*\S)\s+(\([^()]+\))$/.exec(raw)
  const keys = aside ? aside[1] : raw
  const context = aside ? aside[2] : null
  const pieces = keys.split(/(\s+[/·]\s+)/)
  const alternatives = pieces.filter((_, index) => index % 2 === 0)
  const shapes = new Set(alternatives.map((alt) => alt.trim().split(/\s+/).length))
  if (alternatives.length === 1 || shapes.size !== 1) {
    return { parts: [{ kind: 'key', text: formatKeys(keys, mac) }], context }
  }
  return {
    parts: pieces.map((piece, index) =>
      index % 2 === 0
        ? { kind: 'key', text: formatKeys(piece, mac) }
        : { kind: 'separator', text: piece.trim() }
    ),
    context
  }
}
