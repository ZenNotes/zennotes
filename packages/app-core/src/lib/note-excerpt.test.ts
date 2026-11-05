import { describe, expect, it } from 'vitest'
import { excerptBesideTitle } from './note-excerpt'

describe('excerptBesideTitle', () => {
  it('drops the title a heading put at the start', () => {
    expect(excerptBesideTitle('Old meeting notes', 'Old meeting notes The agenda…')).toBe('The agenda…')
  })

  it('leaves nothing when the note is only its heading', () => {
    expect(excerptBesideTitle('Plan', 'Plan')).toBe('')
  })

  it('leaves a word the title only starts', () => {
    expect(excerptBesideTitle('Plan', 'Planning the week')).toBe('Planning the week')
  })

  it('leaves an excerpt that does not open with the title', () => {
    expect(excerptBesideTitle('Plan', 'Before the Plan')).toBe('Before the Plan')
    expect(excerptBesideTitle('', 'Something')).toBe('Something')
  })
})
