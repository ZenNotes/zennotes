import { describe, expect, it } from 'vitest'
import {
  harperIgnoredLintHashes,
  harperIgnoredLintsJson,
  isHarperDialect,
  normalizeHarperLintConfig,
  normalizeHarperVaultState
} from './harper-settings'

describe('normalizeHarperVaultState', () => {
  it('keeps trimmed, unique words and digit-only hashes', () => {
    expect(
      normalizeHarperVaultState({
        words: [' zennotes ', 'zennotes', '', 42, 'Kanata'],
        ignoredLints: ['9722060015410969502', '9722060015410969502', 'abc', '12', 7]
      })
    ).toEqual({ words: ['zennotes', 'Kanata'], ignoredLints: ['9722060015410969502', '12'] })
  })

  it('is undefined when there is nothing to store', () => {
    expect(normalizeHarperVaultState(undefined)).toBeUndefined()
    expect(normalizeHarperVaultState({ words: [], ignoredLints: [] })).toBeUndefined()
    expect(normalizeHarperVaultState({ words: 'nope' })).toBeUndefined()
  })
})

describe('ignored lint hashes', () => {
  it('round-trips a 64-bit hash without parsing it as a number', () => {
    const exported = '{"context_hashes":[9722060015410969502,18446744073709551615]}'
    const hashes = harperIgnoredLintHashes(exported)
    expect(hashes).toEqual(['9722060015410969502', '18446744073709551615'])
    expect(harperIgnoredLintsJson(hashes)).toBe(exported)
  })

  it('imports nothing when no valid hash remains', () => {
    expect(harperIgnoredLintsJson([])).toBeNull()
    expect(harperIgnoredLintsJson(['not-a-hash'])).toBeNull()
  })
})

describe('preferences', () => {
  it('accepts only the dialects Harper knows', () => {
    expect(isHarperDialect('british')).toBe(true)
    expect(isHarperDialect('scottish')).toBe(false)
  })

  it('keeps only boolean or null rule overrides', () => {
    expect(
      normalizeHarperLintConfig({ SpellCheck: false, SameAs: null, Other: 'yes', '': true })
    ).toEqual({ SpellCheck: false, SameAs: null })
    expect(normalizeHarperLintConfig(['SpellCheck'])).toEqual({})
  })
})
