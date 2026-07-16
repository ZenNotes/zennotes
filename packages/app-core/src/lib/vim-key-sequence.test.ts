import { describe, expect, it } from 'vitest'
import { getKeymapBinding, type KeymapOverrides } from './keymaps'
import { toVimSequence } from './vim-key-sequence'

describe('toVimSequence', () => {
  it('converts default half-page bindings', () => {
    expect(toVimSequence(getKeymapBinding({}, 'nav.halfPageDown'))).toBe('<C-d>')
    expect(toVimSequence(getKeymapBinding({}, 'nav.halfPageUp'))).toBe('<C-u>')
  })

  it('converts configured half-page bindings', () => {
    const overrides: KeymapOverrides = { 'nav.halfPageDown': 'Alt+U' }
    expect(toVimSequence(getKeymapBinding(overrides, 'nav.halfPageDown'))).toBe('<A-u>')
  })

  it('converts multi-key sequences', () => {
    expect(toVimSequence('Ctrl+W h')).toBe('<C-w>h')
  })
})
