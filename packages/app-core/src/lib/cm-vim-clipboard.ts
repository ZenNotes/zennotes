/**
 * Central hook for Vim yank side effects. codemirror-vim funnels every
 * yank/delete/change through the register controller's `pushText`, so we wrap it
 * once (the controller is created a single time at module load, via
 * `resetVimGlobalState`) and from there drive two features:
 *
 *  - `clipboard=unnamed` emulation: copy the unnamed register to the system
 *    clipboard. codemirror-vim only syncs the explicit `"+` register natively.
 *  - a yank handler other modules register (used for highlight-on-yank), invoked
 *    on yank so the active view can flash the yanked range.
 */
import { Vim } from '@replit/codemirror-vim'

interface PatchableRegisterController {
  pushText: (
    registerName: string,
    operator: string,
    text: string,
    linewise?: boolean,
    blockwise?: boolean
  ) => void
  unnamedRegister?: { toString(): string }
}

let clipboardEnabled = false
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
