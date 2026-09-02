import { defaultKeymap } from '@codemirror/commands'
import { markdownKeymap } from '@codemirror/lang-markdown'
import { Prec, type Extension } from '@codemirror/state'
import { keymap, type EditorView, type KeyBinding } from '@codemirror/view'
import { searchKeymap } from '@codemirror/search'
import { getCM } from '@replit/codemirror-vim'
import { insertNewlineContinueFencedCodeIndent } from './cm-code-fence-indent'
import { isMacPlatform } from './keymaps'

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

const ARROW_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])

/**
 * Keys that Vim maps to motions in normal/visual mode but which `defaultKeymap`
 * (and `markdownKeymap`) bind to *editing* commands: the arrows (issue #287),
 * plus Enter (`<CR>` → `j^`: first non-blank of the next line) and Backspace
 * (`<BS>` → `h`). Without deferral, Enter in normal mode inserts a newline
 * (via `insertNewlineContinueMarkup` / `insertNewlineAndIndent`) and Backspace
 * deletes a character, instead of moving the cursor like real Vim.
 */
const VIM_MOTION_KEYS = new Set([...ARROW_KEYS, 'Enter', 'Backspace'])

/**
 * Vim key conflicts (arrows / Enter / Backspace act as edits, not motions).
 *
 * `defaultKeymap` binds the arrows to caret motions (`cursorCharLeft`/…) with
 * `preventDefault: true`, Enter to `insertNewlineAndIndent`, and Backspace to
 * `deleteCharBackward`; and (like the mac emacs chords above) the keymap's
 * handler runs at higher precedence than the Vim plugin's. So in Vim mode the
 * arrows just move the caret — which in *visual* mode collapses the selection
 * instead of extending it the way `h`/`j`/`k`/`l` do (issue #287) — and Enter/
 * Backspace *edit the text* in normal mode instead of applying Vim's `<CR>`/
 * `<BS>` motions. `hjkl` have no competing keymap binding, so they were never
 * affected — hence the asymmetry users hit.
 *
 * Unlike the emacs chords we can't simply drop these keys: Vim only maps them
 * in normal/visual mode (`<Left>`→`h`, `<CR>`→`j^`, …), not in *insert* mode,
 * so insert-mode caret movement, newline insertion and deletion still rely on
 * these bindings. Instead, in Vim mode each binding defers to the Vim plugin
 * while Vim is in a non-insert mode — returning `false` with no
 * `preventDefault` lets the keypress fall through to the (lower-precedence)
 * Vim plugin, which then applies the motion. Insert mode (and Vim-off) keep
 * the native behavior. Shift-modified handlers are left untouched.
 */
function deferKeysToVim(
  bindings: readonly KeyBinding[],
  keys: ReadonlySet<string>
): KeyBinding[] {
  return bindings.map((binding) => {
    if (!binding.key || !keys.has(binding.key) || !binding.run) return binding
    const native = binding.run
    return {
      ...binding,
      // Must be false: with preventDefault the event is consumed even when the
      // command returns false, which would re-block the Vim plugin.
      preventDefault: false,
      run: (view: EditorView): boolean => {
        const vim = (getCM(view) as { state?: { vim?: { insertMode?: boolean } } } | null)?.state
          ?.vim
        if (vim && !vim.insertMode) return false
        return native(view)
      }
    }
  })
}

/** Vim-mode keymap: emacs chords stripped, motion keys made Vim-aware (see above). */
const vimModeKeymap: readonly KeyBinding[] = deferKeysToVim(
  defaultKeymapWithoutMacEmacs,
  VIM_MOTION_KEYS
)

/**
 * CodeMirror's `defaultKeymap`, made Vim-aware: in Vim mode the macOS
 * emacs-style control chords are stripped so Vim's `<C-d>`/`<C-a>`/`<C-v>`/…
 * bindings work, and the arrow keys defer to Vim in normal/visual mode so they
 * move/extend like `hjkl`; with Vim off the full keymap is used unchanged.
 */
export function vimAwareDefaultKeymap(vimMode: boolean): readonly KeyBinding[] {
  return vimMode ? vimModeKeymap : defaultKeymap
}

/**
 * CodeMirror's `searchKeymap`, made Vim-aware where Mod is Ctrl.
 *
 * The search panel is bound to `Mod-f`. On Linux and Windows that is Ctrl+F,
 * which in Vim is page-forward, and because the keymap handler runs ahead of
 * the Vim plugin the panel won every time while `<C-b>` (page-back) reached
 * Vim: the one motion chord the editor still took from Vim (#510). With Vim
 * mode on, Vim users search with `/`, so the binding is dropped there and
 * Ctrl+F pages like Ctrl+B. macOS keeps it: Cmd+F never collided with Vim.
 * The rest of the keymap (find next, replace, select matches) stays as is.
 */
export function vimAwareSearchKeymap(vimMode: boolean, mac: boolean = isMacPlatform()): readonly KeyBinding[] {
  if (!vimMode || mac) return searchKeymap
  return searchKeymap.filter((binding) => binding.key !== 'Mod-f')
}

/**
 * Vim-aware replacement for `markdown({ addKeymap: true })`'s keymap.
 *
 * The markdown language support binds Enter → `insertNewlineContinueMarkup`
 * and Backspace → `deleteMarkupBackward` at `Prec.high`, which beats both the
 * Vim plugin *and* the deferred bindings above — so in Vim normal mode Enter
 * inserted a newline instead of moving to the first non-blank of the next
 * line (`<CR>` → `j^`). Deferral can't be layered on top (returning `false`
 * would fall through to the original high-precedence binding), so the editors
 * must pass `addKeymap: false` to `markdown()` and add this extension instead:
 * the same `markdownKeymap` at the same precedence, with Enter/Backspace
 * deferring to Vim in non-insert mode. The wrapper checks the live Vim state
 * per keypress (no-op when Vim is off), so this needs no reconfiguration on
 * Vim toggle.
 */
// #405: run our fenced-code indent fix before the markdown Enter command, so
// `` - ```bash `` + Enter indents into the list item instead of escaping to
// column 0. It returns false (falls through) for every case the default
// command already handles. Deferral to Vim applies to it too (same key set).
const fencedCodeIndentEnter: KeyBinding = {
  key: 'Enter',
  run: insertNewlineContinueFencedCodeIndent
}

export const vimAwareMarkdownKeymap: Extension = Prec.high(
  keymap.of(
    deferKeysToVim([fencedCodeIndentEnter, ...markdownKeymap], new Set(['Enter', 'Backspace']))
  )
)
