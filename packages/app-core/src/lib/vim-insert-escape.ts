import { Vim } from '@replit/codemirror-vim'

/**
 * Maps a key sequence (e.g. `jk`) to `<Esc>` in vim insert mode, so users can
 * leave insert mode without reaching for Escape. `Vim` is a per-renderer global,
 * so every window that hosts a vim editor calls this with the current pref.
 *
 * The last-applied sequence is tracked per renderer so changing or clearing the
 * pref cleanly unmaps the previous binding.
 */
let applied: string | null = null

export function applyVimInsertEscape(sequence: string): void {
  const seq = (sequence ?? '').trim()
  if (seq === (applied ?? '')) return

  if (applied) {
    try {
      Vim.unmap(applied, 'insert')
    } catch {
      /* ignore */
    }
    applied = null
  }

  if (seq) {
    try {
      Vim.map(seq, '<Esc>', 'insert')
      applied = seq
    } catch {
      /* ignore */
    }
  }
}
