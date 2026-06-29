import { describe, expect, it } from 'vitest'
import { matchesSelectedTags } from './tags'

describe('matchesSelectedTags', () => {
  const note = ['project', 'urgent', 'design']

  it('all (AND): requires every selected tag — the #221 fix', () => {
    expect(matchesSelectedTags(note, ['project', 'urgent'], 'all')).toBe(true)
    expect(matchesSelectedTags(note, ['project', 'missing'], 'all')).toBe(false)
    expect(matchesSelectedTags(note, ['project'], 'all')).toBe(true)
  })

  it('any (OR): requires at least one selected tag', () => {
    expect(matchesSelectedTags(note, ['project', 'missing'], 'any')).toBe(true)
    expect(matchesSelectedTags(note, ['nope', 'missing'], 'any')).toBe(false)
  })

  it('is case-insensitive on both sides', () => {
    expect(matchesSelectedTags(['Project', 'URGENT'], ['project', 'urgent'], 'all')).toBe(true)
    expect(matchesSelectedTags(['Project'], ['PROJECT'], 'any')).toBe(true)
  })

  it('no selection never matches', () => {
    expect(matchesSelectedTags(note, [], 'all')).toBe(false)
    expect(matchesSelectedTags(note, [], 'any')).toBe(false)
  })

  it('a note with no tags never matches a non-empty selection', () => {
    expect(matchesSelectedTags([], ['project'], 'all')).toBe(false)
    expect(matchesSelectedTags([], ['project'], 'any')).toBe(false)
  })
})
