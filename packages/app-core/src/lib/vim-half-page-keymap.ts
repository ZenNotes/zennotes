import type { Command, KeyBinding } from '@codemirror/view'
import { Vim, getCM } from '@replit/codemirror-vim'
import { getKeymapBinding, isUnboundBinding, type KeymapOverrides } from './keymaps'
import { toVimSequence } from './vim-key-sequence'

export function toCodeMirrorKey(binding: string): string {
  const parts = binding.split('+')
  const base = parts.pop() ?? ''
  const modifiers = parts.join('-')
  const key = base.length === 1 ? base.toLowerCase() : base
  return modifiers ? `${modifiers}-${key}` : key
}

/** The CodeMirror keymap entry for a keymap binding, or none at all for an
 *  unbound action. CodeMirror files an empty key name without complaint and
 *  would run the command on any keydown whose `key` is empty, so an unbound
 *  action never reaches the keymap in the first place. */
export function keyBindingsFor(binding: string, run: Command): KeyBinding[] {
  if (isUnboundBinding(binding)) return []
  return [{ key: toCodeMirrorKey(binding), run }]
}

export function vimHalfPageKeymap(
  vimMode: boolean,
  overrides: KeymapOverrides
): KeyBinding[] {
  if (!vimMode) return []
  return (['nav.halfPageDown', 'nav.halfPageUp'] as const).flatMap((keymapId) => {
    const binding = getKeymapBinding(overrides, keymapId)
    const sequence = toVimSequence(binding)
    if (!sequence) return []
    return keyBindingsFor(binding, (view): boolean => {
      const cm = getCM(view)
      const vim = cm?.state.vim
      if (!cm || !vim || vim.insertMode || vim.visualMode) return false
      return !!Vim.handleKey(cm, sequence, 'user')
    })
  })
}
