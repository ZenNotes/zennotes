import { describe, expect, it } from 'vitest'
import { vimAwareDefaultKeymap } from './cm-vim-default-keymap'

// Regression guard for the macOS Vim `Ctrl-d` bug: defaultKeymap's emacs-style
// mac chords used to shadow Vim's <C-d> (half-page down) and delete a char.
describe('vimAwareDefaultKeymap', () => {
  it('strips the macOS emacs chords in Vim mode so Vim handles them', () => {
    const macs = new Set(
      vimAwareDefaultKeymap(true)
        .map((b) => b.mac)
        .filter(Boolean)
    )
    for (const chord of ['Ctrl-d', 'Ctrl-a', 'Ctrl-e', 'Ctrl-f', 'Ctrl-b', 'Ctrl-v', 'Ctrl-h']) {
      expect(macs.has(chord)).toBe(false)
    }
  })

  it('keeps the emacs chords when Vim is off (standard macOS editing keys)', () => {
    const macs = new Set(vimAwareDefaultKeymap(false).map((b) => b.mac))
    expect(macs.has('Ctrl-d')).toBe(true)
    expect(macs.has('Ctrl-e')).toBe(true)
  })

  it('never drops non-emacs bindings (Mod-a, arrows survive in Vim mode)', () => {
    const vim = vimAwareDefaultKeymap(true)
    expect(vim.some((b) => b.key === 'Mod-a')).toBe(true)
    expect(vim.some((b) => b.key === 'ArrowDown')).toBe(true)
    expect(vim.some((b) => b.key === 'Enter')).toBe(true)
  })

  it('removes exactly the 13 documented emacs chords, nothing more', () => {
    expect(vimAwareDefaultKeymap(false).length - vimAwareDefaultKeymap(true).length).toBe(13)
  })
})
