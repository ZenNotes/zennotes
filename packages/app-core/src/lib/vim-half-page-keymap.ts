import type { KeyBinding } from '@codemirror/view'
import { Vim, getCM } from '@replit/codemirror-vim'
import { getKeymapBinding, type KeymapOverrides } from './keymaps'
import { toVimSequence } from './vim-key-sequence'

export function toCodeMirrorKey(binding: string): string {
  const parts = binding.split('+')
  const base = parts.pop() ?? ''
  const modifiers = parts.join('-')
  const key = base.length === 1 ? base.toLowerCase() : base
  return modifiers ? `${modifiers}-${key}` : key
}

export function vimHalfPageKeymap(
  vimMode: boolean,
  overrides: KeymapOverrides
): KeyBinding[] {
  if (!vimMode) return []
  return (['nav.halfPageDown', 'nav.halfPageUp'] as const).map((keymapId) => {
    const binding = getKeymapBinding(overrides, keymapId)
    const sequence = toVimSequence(binding)
    return {
      key: toCodeMirrorKey(binding),
      run: (view): boolean => {
        const cm = getCM(view)
        const vim = cm?.state.vim
        if (!cm || !vim || vim.insertMode || vim.visualMode || !sequence) return false
        return !!Vim.handleKey(cm, sequence, 'user')
      }
    }
  })
}
