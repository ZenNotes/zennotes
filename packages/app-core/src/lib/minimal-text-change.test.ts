import { describe, expect, it } from 'vitest'
import { minimalTextChange } from './minimal-text-change'

const apply = (before: string, after: string): string => {
  const change = minimalTextChange(before, after)
  if (!change) return before
  return before.slice(0, change.from) + change.insert + before.slice(change.to)
}

describe('minimalTextChange', () => {
  it('is nothing when the texts are the same', () => {
    expect(minimalTextChange('same', 'same')).toBeNull()
    expect(minimalTextChange('', '')).toBeNull()
  })

  it('touches only what differs', () => {
    expect(minimalTextChange('# Roadmap\n\nBody.', '# Roadmap 2027\n\nBody.')).toEqual({
      from: 9,
      to: 9,
      insert: ' 2027'
    })
    expect(minimalTextChange('# Roadmap 2027\n\nBody.', '# Roadmap\n\nBody.')).toEqual({
      from: 9,
      to: 14,
      insert: ''
    })
    expect(minimalTextChange('see [[Old]] here', 'see [[New name]] here')).toEqual({
      from: 6,
      to: 9,
      insert: 'New name'
    })
  })

  it('always reproduces the new text', () => {
    const cases: Array<[string, string]> = [
      ['', 'added'],
      ['removed', ''],
      ['aaa', 'aaaa'],
      ['aaaa', 'aaa'],
      ['abcabc', 'abc'],
      ['abc', 'abcabc'],
      ['start middle end', 'start end'],
      ['one\ntwo\nthree', 'one\n2\nthree'],
      ['completely', 'different']
    ]
    for (const [before, after] of cases) expect(apply(before, after)).toBe(after)
  })

  // When the texts repeat, prefix and suffix could claim the same characters.
  it('never lets the prefix and the suffix overlap', () => {
    const change = minimalTextChange('aaa', 'aaaa')
    expect(change).not.toBeNull()
    expect(change!.from).toBeLessThanOrEqual(change!.to)
    expect(change!.insert).toBe('a')
  })

  it('keeps an astral character whole on both sides of the change', () => {
    // 😀 is d83d de00 and 😁 is d83d de01: they share the high surrogate.
    const grin = minimalTextChange('a😀b', 'a😁b')
    expect(grin).toEqual({ from: 1, to: 3, insert: '😁' })
    // U+1F600 (d83d de00) and U+1FA00 (d83e de00) share the LOW surrogate.
    const low = minimalTextChange('a\u{1F600}b', 'a\u{1FA00}b')
    expect(low).toEqual({ from: 1, to: 3, insert: '\u{1FA00}' })
    expect(apply('a\u{1F600}b', 'a\u{1FA00}b')).toBe('a\u{1FA00}b')
  })
})
