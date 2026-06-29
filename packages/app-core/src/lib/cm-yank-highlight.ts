/**
 * Brief highlight over the just-yanked text, like Neovim's
 * `vim.highlight.on_yank()`. codemirror-vim sets the editor selection to the
 * operator range while a yank runs, so the range is read from the active view's
 * selection at yank time (see cm-vim-clipboard's yank hook) and flashed here.
 */
import { StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view'
import { useStore } from '../store'
import { setVimYankHandler } from './cm-vim-clipboard'

const FLASH_MS = 160

const setYankHighlight = StateEffect.define<readonly { from: number; to: number }[] | null>()

const yankMark = Decoration.mark({ class: 'cm-yank-highlight' })

const yankHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const effect of tr.effects) {
      if (!effect.is(setYankHighlight)) continue
      deco = effect.value
        ? Decoration.set(effect.value.map((r) => yankMark.range(r.from, r.to)))
        : Decoration.none
    }
    return deco
  },
  provide: (f) => EditorView.decorations.from(f)
})

const yankHighlightTheme = EditorView.baseTheme({
  '.cm-yank-highlight': {
    backgroundColor: 'rgb(var(--z-accent) / 0.3)',
    borderRadius: '2px'
  }
})

export const yankHighlightExtension: Extension = [yankHighlightField, yankHighlightTheme]

const clearTimers = new WeakMap<EditorView, ReturnType<typeof setTimeout>>()

/**
 * Flash a highlight over `ranges`, then clear it after a short delay. The
 * dispatch is deferred because the yank runs inside codemirror-vim's own update,
 * where a synchronous re-dispatch would throw.
 */
function flashYankHighlight(
  view: EditorView,
  ranges: readonly { from: number; to: number }[]
): void {
  const doc = view.state.doc
  const trimmed = ranges
    .map((r) => {
      let to = Math.min(r.to, doc.length)
      const from = Math.min(r.from, to)
      // Drop trailing newlines so a linewise yank doesn't bleed into the next line.
      while (to > from && doc.sliceString(to - 1, to) === '\n') to--
      return { from, to }
    })
    .filter((r) => r.to > r.from)
  if (trimmed.length === 0) return
  setTimeout(() => {
    try {
      view.dispatch({ effects: setYankHighlight.of(trimmed) })
    } catch {
      return
    }
    const prev = clearTimers.get(view)
    if (prev) clearTimeout(prev)
    clearTimers.set(
      view,
      setTimeout(() => {
        clearTimers.delete(view)
        try {
          view.dispatch({ effects: setYankHighlight.of(null) })
        } catch {
          /* view already destroyed */
        }
      }, FLASH_MS)
    )
  }, 0)
}

let wired = false

/**
 * Install the yank handler that flashes the active editor on every Vim yank.
 * Idempotent — safe to call from each editor pane's mount.
 */
export function wireYankHighlight(): void {
  if (wired) return
  wired = true
  setVimYankHandler(() => {
    const view = useStore.getState().editorViewRef
    if (!view) return
    const ranges = view.state.selection.ranges.map((r) => ({ from: r.from, to: r.to }))
    flashYankHighlight(view, ranges)
  })
}
