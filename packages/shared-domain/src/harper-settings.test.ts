import { describe, expect, it } from 'vitest'
import {
  harperIgnoredLintHashes,
  harperIgnoredLintsJson,
  isHarperDialect,
  mergeHarperVaultState,
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

describe('mergeHarperVaultState (#829)', () => {
  it('keeps every entry of both sides, the base order first, new ones appended', () => {
    expect(
      mergeHarperVaultState(
        { words: ['Zennotez', 'Kanata'], ignoredLints: ['12'] },
        { words: ['Kanata', 'Flurbish'], ignoredLints: ['9722060015410969502', '12'] }
      )
    ).toEqual({
      words: ['Zennotez', 'Kanata', 'Flurbish'],
      ignoredLints: ['12', '9722060015410969502']
    })
  })

  it('never shrinks to the side that holds less', () => {
    const vault = { words: ['Zennotez', 'Kanata'], ignoredLints: ['12'] }
    // A session that lost its imports exports one freshly added word.
    expect(mergeHarperVaultState(vault, { words: ['Flurbish'], ignoredLints: [] })).toEqual({
      words: ['Zennotez', 'Kanata', 'Flurbish'],
      ignoredLints: ['12']
    })
    expect(mergeHarperVaultState(vault, { words: [], ignoredLints: [] })).toEqual(vault)
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
