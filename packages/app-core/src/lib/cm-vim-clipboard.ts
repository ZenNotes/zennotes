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
 *
 * It also makes the `+` and `*` registers read the system clipboard, images
 * included (`installSystemClipboardRegisters`).
 */
import { ViewPlugin, type EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { Vim, getCM } from '@replit/codemirror-vim'
import { editorImagePaste, pasteImageFilesIntoEditor, readSystemClipboard } from './editor-paste-images'
import { lineBelowAnchor } from './cm-fold-line-below'

interface VimRegister {
  toString(): string
  setText?: (text: string, linewise?: boolean, blockwise?: boolean) => void
}

interface PatchableRegisterController {
  pushText: (
    registerName: string,
    operator: string,
    text: string,
    linewise?: boolean,
    blockwise?: boolean
  ) => void
  unnamedRegister?: VimRegister
  getRegister?: (name?: string) => VimRegister | undefined
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

/** Registers that stand for the system clipboard, as both do in Vim on macOS and Windows. */
const SYSTEM_CLIPBOARD_REGISTERS = new Set(['+', '*'])

interface VimEditor {
  cm6?: EditorView
  state?: { vim?: { visualMode?: boolean } }
  replaceSelection(text: string): void
  setCursor?(pos: { line: number; ch: number }): void
}

interface LinewiseRegister extends VimRegister {
  linewise?: boolean
}

/**
 * A linewise `p` on a closed fold puts below the fold's last line, as in Vim
 * (#1066). codemirror-vim puts below the cursor line, which for a folded
 * heading is between the heading and its hidden section: the fold then came
 * loose from the heading and hid the section under the pasted lines. Moving
 * the cursor to the end of the fold's last line first keeps every other part
 * of Vim's put (counts, indentation, where the cursor lands) as it is; the end
 * of a fold is outside it, so the move does not open the fold.
 */
function moveCursorBelowClosedFold(
  cm: VimEditor,
  actionArgs: { after?: boolean },
  vim: unknown,
  register: LinewiseRegister
): void {
  const view = cm.cm6
  if (!view || !actionArgs.after || !register.linewise || !cm.setCursor) return
  if ((vim as { visualMode?: boolean } | null)?.visualMode) return
  const { state } = view
  const line = state.doc.lineAt(state.selection.main.head)
  const anchor = lineBelowAnchor(state, line.number)
  if (anchor === line.to) return
  const target = state.doc.lineAt(anchor)
  cm.setCursor({ line: target.number - 1, ch: anchor - target.from })
}

interface VimPasteActions {
  continuePaste(cm: unknown, actionArgs: unknown, vim: unknown, text: string, register: VimRegister): void
}

type VimActionFn = Parameters<typeof Vim.defineAction>[1]

let systemClipboardRegistersInstalled = false

function registerController(): PatchableRegisterController | null {
  return Vim.getRegisterController() as unknown as PatchableRegisterController | null
}

/**
 * A put lands clipboard images on a line of their own, below the cursor line
 * for `p` and above it for `P`, the way a linewise put lands, rather than
 * splitting the line at the cursor.
 */
function putClipboardImages(cm: VimEditor, images: File[], after: boolean): boolean {
  const view = cm.cm6
  if (!view || images.length === 0 || !view.state.facet(editorImagePaste)) return false
  const line = view.state.doc.lineAt(view.state.selection.main.head)
  if (cm.state?.vim?.visualMode) Vim.exitVisualMode(cm as unknown as Parameters<typeof Vim.exitVisualMode>[0])
  return pasteImageFilesIntoEditor(view, images, after ? line.to : line.from)
}

/**
 * codemirror-vim reads the system clipboard only for `"+p`, and only as text;
 * `"*p` and insert-mode `<C-r>+` / `<C-r>*` read in-memory registers the system
 * clipboard never fills. These overrides make both registers read it, and an
 * image on it lands as an embed through the note's paste import, as Mod+V does.
 * Every other register keeps codemirror-vim's own behaviour.
 */
export function installSystemClipboardRegisters(): void {
  if (systemClipboardRegistersInstalled) return
  systemClipboardRegistersInstalled = true
  Vim.defineAction('paste', function (
    this: VimPasteActions,
    cm: VimEditor,
    actionArgs: { registerName?: string; after?: boolean },
    vim: unknown
  ): void {
    const name = actionArgs.registerName
    const register = registerController()?.getRegister?.(name)
    if (!register) return
    if (!name || !SYSTEM_CLIPBOARD_REGISTERS.has(name)) {
      moveCursorBelowClosedFold(cm, actionArgs, vim, register)
      this.continuePaste(cm, actionArgs, vim, register.toString(), register)
      return
    }
    void readSystemClipboard().then(({ images, text }) => {
      if (putClipboardImages(cm, images, actionArgs.after === true)) return
      // Linewise when the text ends in a newline, as the unnamed-register `p` reads it.
      register.setText?.(text, /\n$/.test(text))
      moveCursorBelowClosedFold(cm, actionArgs, vim, register)
      this.continuePaste(cm, actionArgs, vim, text, register)
    })
  } as unknown as VimActionFn)
  Vim.defineAction('insertRegister', ((cm: VimEditor, actionArgs: { selectedCharacter?: string }) => {
    const name = actionArgs.selectedCharacter
    if (!name || !SYSTEM_CLIPBOARD_REGISTERS.has(name)) {
      const text = registerController()?.getRegister?.(name)?.toString()
      if (text) cm.replaceSelection(text)
      return
    }
    void readSystemClipboard().then(({ images, text }) => {
      if (cm.cm6 && pasteImageFilesIntoEditor(cm.cm6, images)) return
      if (text) cm.replaceSelection(text)
    })
  }) as unknown as VimActionFn)
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
      installSystemClipboardRegisters()
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

        void readSystemClipboard().then(({ images, text }) => {
          if (putClipboardImages(cm as unknown as VimEditor, images, key === 'p')) return
          if (text) {
            // Linewise when the clipboard ends in a newline, matching how a
            // linewise yank is stored, so `p` opens a new line as expected.
            registerController()?.unnamedRegister?.setText?.(text, /\n$/.test(text))
          }
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
