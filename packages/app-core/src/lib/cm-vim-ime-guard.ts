import { Compartment, Prec, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'
import { getCM, Vim } from '@replit/codemirror-vim'
import { sequenceTokenFromEvent } from './keymaps'
import { toVimSequence } from './vim-key-sequence'

/**
 * Keep the OS input method out of Vim normal and visual mode (#84, #464).
 *
 * With a Korean, Chinese or Japanese IME active, a key press in normal mode
 * never reaches Vim as a key: the IME starts a composition, the browser reports
 * `key: "Process"`, and what finally lands in the document is the composed
 * text ("ㅓ" for `j`), which codemirror-vim then tries to undo with an Escape.
 * Motions turn into stray syllables, `i` inserts an `i`, and the editor is
 * left in a state the user did not type.
 *
 * An IME only engages on an editable surface, so outside insert mode the
 * content DOM is made non-editable: CodeMirror keeps focus on it (it gets a
 * tabindex), keydown still reaches every keymap and Vim, the fat cursor is
 * drawn by Vim anyway, and commands that change the document (`x`, `dd`, `p`)
 * still run because `readOnly` is untouched. Insert and replace mode flip it
 * back so composition works exactly as before.
 *
 * `enabled` is read on every check, so the Settings toggle applies at once.
 * Touch devices are skipped by the caller: a non-editable surface would
 * dismiss the on-screen keyboard, and the mobile shells have no way back to
 * insert mode without it.
 */
/** Non-editable content is not focusable on its own, and an unfocused editor
 *  hears no keys at all; a tabindex keeps it the keyboard's target. */
function editableConfig(editable: boolean): Extension {
  return editable
    ? EditorView.editable.of(true)
    : [EditorView.editable.of(false), EditorView.contentAttributes.of({ tabindex: '0' })]
}

/**
 * A Vim key bound to a dead-key chord (#1049). On a US Mac layout Option+E, I,
 * N, U and ` start an accent, so the keydown says `key: "Dead"`, and
 * codemirror-vim reads that as `<A-Dead>`: the Settings recorder saved
 * `Alt+I` from the physical key, but the binding never fired. Outside insert
 * mode nothing is being composed, so hand Vim the physical chord. Insert mode
 * keeps the dead key: that is how accents get typed.
 */
const deadKeyChords = Prec.highest(
  EditorView.domEventHandlers({
    keydown(event, view) {
      if (event.key !== 'Dead' || !event.altKey) return false
      const cm = getCM(view)
      if (!cm || cm.state.vim?.insertMode) return false
      const token = sequenceTokenFromEvent(event)
      const key = token ? toVimSequence(token) : null
      if (!key || !Vim.handleKey(cm, key, 'user')) return false
      event.preventDefault()
      return true
    }
  })
)

export function vimImeGuard(enabled: () => boolean): Extension {
  const editable = new Compartment()
  return [
    deadKeyChords,
    editable.of(editableConfig(true)),
    ViewPlugin.define((view) => {
      let current = true
      let scheduled = false
      let disposed = false
      let attached: ReturnType<typeof getCM> | null = null

      const desired = (): boolean => {
        const cm = getCM(view)
        if (!cm || !enabled()) return true
        return Boolean(cm.state.vim?.insertMode)
      }
      const sync = (): void => {
        if (disposed) return
        const next = desired()
        if (next === current) return
        current = next
        const hadFocus = view.hasFocus
        view.dispatch({ effects: editable.reconfigure(editableConfig(next)) })
        // Flipping contenteditable can drop the browser's focus even though
        // the element stays focusable; the user did not leave the editor.
        if (hadFocus && !view.hasFocus) view.focus()
      }
      // Vim signals mode changes from inside its own key handling, where a
      // dispatch is not allowed yet; settle on the next microtask.
      const schedule = (): void => {
        if (scheduled) return
        scheduled = true
        queueMicrotask(() => {
          scheduled = false
          sync()
        })
      }
      const onModeChange = (): void => schedule()
      const attach = (): void => {
        const cm = getCM(view)
        if (cm === attached) return
        attached?.off('vim-mode-change', onModeChange)
        attached = cm
        cm?.on('vim-mode-change', onModeChange)
        schedule()
      }
      attach()
      return {
        // Vim can be switched on or off at runtime through its compartment,
        // and the pref can flip: re-check cheaply on every update.
        update() {
          attach()
          schedule()
        },
        destroy() {
          disposed = true
          attached?.off('vim-mode-change', onModeChange)
        }
      }
    })
  ]
}

/** True on a touch-first device, where hiding the keyboard would strand the
 *  user in normal mode. */
export function isTouchPrimaryDevice(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(pointer: coarse)').matches
  } catch {
    return false
  }
}
