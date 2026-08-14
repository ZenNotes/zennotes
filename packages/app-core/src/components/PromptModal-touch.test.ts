import { describe, expect, it } from 'vitest'
import { shouldAutofocusPrompt } from './PromptModal'

// Focusing the input pops the soft keyboard, which on a phone covers the very
// suggestion list the prompt is asking the user to choose from (the folder
// picker in Move to… was unusable one-handed). Touch + a list = tap-first.
describe('shouldAutofocusPrompt', () => {
  it('does not autofocus a touch prompt that has suggestions (folder pickers)', () => {
    expect(shouldAutofocusPrompt(true, 1)).toBe(false)
    expect(shouldAutofocusPrompt(true, 12)).toBe(false)
  })

  it('autofocuses a touch prompt with no list — those are pure typing', () => {
    // Rename note / New folder: nothing to tap, so the keyboard is the point.
    expect(shouldAutofocusPrompt(true, 0)).toBe(true)
  })

  it('always autofocuses with a fine pointer, so desktop is unchanged', () => {
    expect(shouldAutofocusPrompt(false, 0)).toBe(true)
    expect(shouldAutofocusPrompt(false, 8)).toBe(true)
  })
})
