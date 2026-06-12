import { describe, expect, it } from 'vitest'
import { canReturnToCommandList } from './command-palette-mode'

describe('canReturnToCommandList', () => {
  it('steps back when a sub-mode was entered from the command list', () => {
    expect(canReturnToCommandList('vault', 'main')).toBe(true)
    expect(canReturnToCommandList('theme', 'main')).toBe(true)
  })

  it('closes when the palette was opened straight into a sub-mode (#119)', () => {
    // `<leader>v` opens vault mode directly — Esc must close it, not reveal
    // the command list the user never opened.
    expect(canReturnToCommandList('vault', 'vault')).toBe(false)
  })

  it('closes from the main command list', () => {
    expect(canReturnToCommandList('main', 'main')).toBe(false)
  })
})
