import { Vim } from '@replit/codemirror-vim'
import { useStore } from '../store'

/**
 * `:set wrap` / `:set nowrap` / `:set wrap?` (and `:set wrap!` to flip it),
 * the ex twin of Settings, Editor, Word wrap (#1084). It drives the same
 * preference as that switch, the Toggle Word Wrap command and Alt+Z, so all of
 * them and `[editor].word_wrap` in config.toml always agree.
 *
 * No default value: codemirror-vim applies a truthy default through the
 * callback the moment the option is defined, which would turn wrapping back
 * on at every launch over a saved `word_wrap = false`.
 */
export function defineWrapOption(): void {
  Vim.defineOption('wrap', undefined, 'boolean', null, (value?: boolean) => {
    const state = useStore.getState()
    if (value === undefined) return state.wordWrap
    // `:set` runs the callback twice (global, then for the editor): the
    // equality check keeps that to one write of the preference.
    if (state.wordWrap !== !!value) state.setWordWrap(!!value)
    return undefined
  })
}
