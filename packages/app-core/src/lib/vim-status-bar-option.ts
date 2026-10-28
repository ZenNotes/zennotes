import { Vim } from '@replit/codemirror-vim'
import { useStore } from '../store'

/**
 * `:set statusbar` / `:set nostatusbar` / `:set statusbar?` (alias `stb`), the
 * ex twin of Settings, Appearance, Chrome, Status bar, under the `:set` a Vim
 * user reaches for. The palette command (`:view_status_bar`) toggles it too.
 *
 * No default value: codemirror-vim applies a truthy default through the
 * callback the moment the option is defined, which turned the bar back on at
 * every launch over a saved `show_status_bar = false`.
 */
export function defineStatusBarOption(): void {
  Vim.defineOption('statusbar', undefined, 'boolean', ['stb'], (value?: boolean) => {
    const state = useStore.getState()
    if (value === undefined) return state.showStatusBar
    if (state.showStatusBar !== !!value) state.setShowStatusBar(!!value)
    return undefined
  })
}
