import { defaultKeymap } from '@codemirror/commands'
import type { KeyBinding } from '@codemirror/view'

/**
 * macOS-only Vim keymap conflict (`Ctrl-d` deletes instead of half-page-down).
 *
 * `@codemirror/commands`' `defaultKeymap` folds in the emacs-style control
 * chords as **mac-only** bindings (each entry's `mac` field). On macOS that
 * makes the editor bind, among others:
 *
 *   Ctrl-d → deleteCharForward     Ctrl-a → cursorLineStart
 *   Ctrl-e → cursorLineEnd         Ctrl-f → cursorCharRight
 *   Ctrl-b → cursorCharLeft        Ctrl-v → cursorPageDown   …
 *
 * These collide with Vim's own normal/visual-mode chords (`<C-d>` half-page
 * down, `<C-a>` increment, `<C-v>` visual-block, `<C-f>`/`<C-b>` page, …).
 * Because the keymap's key handler runs at higher precedence than the Vim
 * plugin's, the emacs action wins — so in Vim mode on macOS `Ctrl-d` deletes a
 * character instead of scrolling. (Linux/Windows are unaffected: these bindings
 * are mac-only. `Ctrl-u`, which has no emacs binding, already worked — hence the
 * up/down asymmetry users notice.)
 *
 * The fix is to drop these chords from the editor keymap while Vim mode is on,
 * so Vim receives them and handles them natively. When Vim is off we keep them —
 * they're standard macOS text-editing keys.
 */
const MAC_EMACS_CHORDS = new Set([
  'Ctrl-b',
  'Ctrl-f',
  'Ctrl-p',
  'Ctrl-n',
  'Ctrl-a',
  'Ctrl-e',
  'Ctrl-d',
  'Ctrl-h',
  'Ctrl-k',
  'Ctrl-Alt-h',
  'Ctrl-o',
  'Ctrl-t',
  'Ctrl-v'
])

const isMacEmacsChord = (binding: KeyBinding): boolean =>
  typeof binding.mac === 'string' && MAC_EMACS_CHORDS.has(binding.mac)

/** `defaultKeymap` with the macOS emacs-style control chords removed. */
const defaultKeymapWithoutMacEmacs: readonly KeyBinding[] = defaultKeymap.filter(
  (binding) => !isMacEmacsChord(binding)
)

/**
 * CodeMirror's `defaultKeymap`, made Vim-aware: in Vim mode the macOS
 * emacs-style control chords are stripped so Vim's `<C-d>`/`<C-a>`/`<C-v>`/…
 * bindings work; with Vim off the full keymap (including those chords) is used.
 */
export function vimAwareDefaultKeymap(vimMode: boolean): readonly KeyBinding[] {
  return vimMode ? defaultKeymapWithoutMacEmacs : defaultKeymap
}
