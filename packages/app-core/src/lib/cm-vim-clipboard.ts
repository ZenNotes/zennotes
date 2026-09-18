/**
 * Central hook for Vim yank side effects. codemirror-vim funnels every
 * yank/delete/change through the register controller's `pushText`, so we wrap it
 * once (the controller is created a single time at module load, via
 * `resetVimGlobalState`) and from there drive three features:
 *
 *  - `clipboard=unnamed` emulation (write side): copy the unnamed register to the
 *    system clipboard. codemirror-vim only syncs the explicit `"+` register
 *    natively.
 *  - `clipboard=unnamed` emulation (read side): `vimClipboardPasteExtension`
 *    makes `p` / `P` load the system clipboard into the unnamed register before
 *    Vim runs its paste. codemirror-vim never reads the OS clipboard on `p`.
 *  - a yank handler other modules register (used for highlight-on-yank), invoked
 *    on yank so the active view can flash the yanked range.
 */
import { ViewPlugin, type EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { Vim, getCM } from '@replit/codemirror-vim'

interface PatchableRegisterController {
  pushText: (
    registerName: string,
    operator: string,
    text: string,
    linewise?: boolean,
    blockwise?: boolean
  ) => void
  unnamedRegister?: {
    toString(): string
    setText?: (text: string, linewise?: boolean, blockwise?: boolean) => void
  }
}

let clipboardEnabled = false
let pasteEnabled = false
let yankHandler: (() => void) | null = null
let patched = false

function ensurePatched(): void {
  if (patched) return
  const controller = Vim.getRegisterController() as unknown as PatchableRegisterController | null
  if (!controller || typeof controller.pushText !== 'function') return
  const original = controller.pushText.bind(controller)
  controller.pushText = (registerName, operator, text, linewise, blockwise): void => {
    original(registerName, operator, text, linewise, blockwise)

    // Fire the yank handler (highlight-on-yank) regardless of the clipboard
    // setting. The handler reads the live editor selection, which is still the
    // yank range at this point.
    if (operator === 'yank' && yankHandler) {
      try {
        yankHandler()
      } catch {
        /* never let a handler break the yank */
      }
    }

    if (!clipboardEnabled) return
    // Only the unnamed/default register mirrors the clipboard. Explicit named
    // registers (e.g. `"ay`) and the black hole register (`"_`) are left alone;
    // the `"+` register already writes to the clipboard natively.
    if (registerName && registerName !== '"') return
    // Read back the unnamed register so linewise yanks keep their trailing
    // newline; fall back to the raw text if it is unavailable.
    const out = controller.unnamedRegister?.toString() ?? text
    if (out) void navigator.clipboard?.writeText(out).catch(() => {})
  }
  patched = true
}

/**
 * Toggle whether Vim yank/delete/change also copy to the system clipboard.
 * Safe to call repeatedly; the underlying patch is installed at most once.
 */
export function setYankToClipboardEnabled(on: boolean): void {
  clipboardEnabled = on
  if (on) ensurePatched()
}

/** Register a handler invoked on every Vim yank (used for highlight-on-yank). */
export function setVimYankHandler(handler: (() => void) | null): void {
  yankHandler = handler
  ensurePatched()
}

/**
 * Toggle whether Vim `p` / `P` in normal/visual mode paste from the system
 * clipboard. Bound to the same setting as yank-to-clipboard so the clipboard
 * and the unnamed register stay in sync in both directions.
 */
export function setPasteFromClipboardEnabled(on: boolean): void {
  pasteEnabled = on
}

/**
 * Editor extension that makes Vim `p` / `P` paste the *system* clipboard.
 *
 * codemirror-vim keeps its own in-memory registers and never reads the OS
 * clipboard on `p` (it only reads it for the explicit `"+`/`"*` registers). To
 * make `p` feel native when yank-to-clipboard is on, we intercept `p`/`P` in
 * normal/visual mode, load the clipboard text into the unnamed register, then
 * hand the key back to Vim so all of its paste behaviour (linewise handling,
 * counts, visual-mode replace) runs unchanged.
 */
export const vimClipboardPasteExtension: Extension = ViewPlugin.fromClass(
  class {
    private readonly view: EditorView
    private readonly onKeyDown: (e: KeyboardEvent) => void

    constructor(view: EditorView) {
      this.view = view
      this.onKeyDown = (e: KeyboardEvent): void => {
        if (!pasteEnabled) return
        if (e.key !== 'p' && e.key !== 'P') return
        // Leave OS/editor chords (Ctrl/Cmd/Alt) alone; only bare p / P.
        if (e.ctrlKey || e.metaKey || e.altKey) return
        // Only act when the main editor content itself has the key, not a nested
        // focusable widget (a table cell runs its own modal Vim). Otherwise this
        // capture-phase listener would steal `p` from the cell and replay the
        // paste on the main editor, dropping the clipboard into the document at
        // the widget's position instead of the cell. (reported by D. Hellinger)
        if (e.target !== view.contentDOM) return

        const cm = getCM(view)
        const vimState = (cm as unknown as { state?: { vim?: { insertMode?: boolean } } } | null)
          ?.state?.vim
        // Only act while Vim is active and out of insert mode; in insert mode a
        // literal "p" must be typed.
        if (!cm || !vimState || vimState.insertMode) return

        // Take over from Vim's own keymap for this event, then replay the key
        // after the async clipboard read resolves.
        e.preventDefault()
        e.stopImmediatePropagation()

        const key = e.key
        const replay = (): void => {
          try {
            Vim.handleKey(cm, key, 'user')
          } catch {
            /* ignore: nothing sensible to do if the paste fails */
          }
        }

        const clipboard = navigator.clipboard
        if (!clipboard?.readText) {
          replay()
          return
        }
        void clipboard
          .readText()
          .then((text) => {
            if (text) {
              const controller = Vim.getRegisterController() as unknown as PatchableRegisterController | null
              // Linewise when the clipboard ends in a newline, matching how a
              // linewise yank is stored, so `p` opens a new line as expected.
              controller?.unnamedRegister?.setText?.(text, /\n$/.test(text))
            }
            replay()
          })
          .catch(() => {
            replay()
          })
      }
      // Capture phase so we run before CodeMirror's own key handling and can
      // stop the event from reaching the Vim keymap.
      view.contentDOM.addEventListener('keydown', this.onKeyDown, true)
    }

    destroy(): void {
      this.view.contentDOM.removeEventListener('keydown', this.onKeyDown, true)
    }
  }
)
