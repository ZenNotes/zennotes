import { describe, expect, it } from 'vitest'
import {
  MAX_SAVED_TASK_FILTERS,
  findSavedTaskFilterName,
  normalizeSavedTaskFilters,
  renameSavedTaskFilter,
  savedTaskFilterNameForQuery,
  savedTaskFilterQuery,
  withSavedTaskFilter,
  withoutSavedTaskFilter
} from './saved-task-filters'

const filters = { 'Project alpha': '@project:alpha', Blocked: '@status:blocked', 'This week': 'due:' }

describe('normalizeSavedTaskFilters', () => {
  it('keeps string entries in their order and trims them', () => {
    expect(
      normalizeSavedTaskFilters({ ' Blocked ': ' @status:blocked ', Alpha: '@project:alpha' })
    ).toEqual({ Blocked: '@status:blocked', Alpha: '@project:alpha' })
    expect(Object.keys(normalizeSavedTaskFilters(filters))).toEqual([
      'Project alpha',
      'Blocked',
      'This week'
    ])
  })

  it('drops blanks, non-strings, duplicates by case, and anything that is not a table', () => {
    expect(normalizeSavedTaskFilters(null)).toEqual({})
    expect(normalizeSavedTaskFilters(['a'])).toEqual({})
    expect(normalizeSavedTaskFilters('x')).toEqual({})
    expect(
      normalizeSavedTaskFilters({ '': 'q', a: '', b: 3, Blocked: 'one', blocked: 'two' })
    ).toEqual({ Blocked: 'one' })
  })

  it('caps the number of entries', () => {
    const many: Record<string, string> = {}
    for (let i = 0; i < MAX_SAVED_TASK_FILTERS + 5; i += 1) many[`f${i}`] = `q${i}`
    expect(Object.keys(normalizeSavedTaskFilters(many))).toHaveLength(MAX_SAVED_TASK_FILTERS)
  })
})

describe('lookups', () => {
  it('finds a name and its query regardless of case', () => {
    expect(findSavedTaskFilterName(filters, 'blocked')).toBe('Blocked')
    expect(findSavedTaskFilterName(filters, ' PROJECT ALPHA ')).toBe('Project alpha')
    expect(findSavedTaskFilterName(filters, 'nope')).toBeNull()
    expect(findSavedTaskFilterName(filters, '')).toBeNull()
    expect(savedTaskFilterQuery(filters, 'BLOCKED')).toBe('@status:blocked')
    expect(savedTaskFilterQuery(filters, 'nope')).toBeNull()
  })

  it('maps the current query back to the chip it came from', () => {
    expect(savedTaskFilterNameForQuery(filters, '@status:blocked')).toBe('Blocked')
    expect(savedTaskFilterNameForQuery(filters, ' @STATUS:blocked ')).toBe('Blocked')
    expect(savedTaskFilterNameForQuery(filters, '@status:block')).toBeNull()
    expect(savedTaskFilterNameForQuery(filters, '')).toBeNull()
  })
})

describe('edits keep the display order', () => {
  it('adds a new filter at the end', () => {
    const next = withSavedTaskFilter(filters, 'Urgent', '!high')
    expect(Object.keys(next)).toEqual(['Project alpha', 'Blocked', 'This week', 'Urgent'])
    expect(next.Urgent).toBe('!high')
    expect(filters).not.toHaveProperty('Urgent')
  })

  it('overwrites an existing name in place, adopting the new spelling', () => {
    const next = withSavedTaskFilter(filters, 'BLOCKED', '@status:waiting')
    expect(Object.keys(next)).toEqual(['Project alpha', 'BLOCKED', 'This week'])
    expect(next.BLOCKED).toBe('@status:waiting')
  })

  it('refuses blanks and a full list', () => {
    expect(withSavedTaskFilter(filters, ' ', 'q')).toBe(filters)
    expect(withSavedTaskFilter(filters, 'x', ' ')).toBe(filters)
    const full: Record<string, string> = {}
    for (let i = 0; i < MAX_SAVED_TASK_FILTERS; i += 1) full[`f${i}`] = `q${i}`
    expect(withSavedTaskFilter(full, 'one more', 'q')).toBe(full)
    expect(Object.keys(withSavedTaskFilter(full, 'F3', 'changed'))).toHaveLength(MAX_SAVED_TASK_FILTERS)
  })

  it('removes by name in any case and ignores unknown names', () => {
    expect(Object.keys(withoutSavedTaskFilter(filters, 'blocked'))).toEqual(['Project alpha', 'This week'])
    expect(withoutSavedTaskFilter(filters, 'nope')).toBe(filters)
  })

  it('renames in place and refuses a taken or blank name', () => {
    const next = renameSavedTaskFilter(filters, 'blocked', 'Waiting on others')
    expect(Object.keys(next)).toEqual(['Project alpha', 'Waiting on others', 'This week'])
    expect(next['Waiting on others']).toBe('@status:blocked')
    expect(renameSavedTaskFilter(filters, 'Blocked', 'this WEEK')).toBe(filters)
    expect(renameSavedTaskFilter(filters, 'Blocked', '  ')).toBe(filters)
    expect(renameSavedTaskFilter(filters, 'nope', 'x')).toBe(filters)
    // Re-casing a name is a rename onto itself.
    expect(Object.keys(renameSavedTaskFilter(filters, 'Blocked', 'BLOCKED'))).toEqual([
      'Project alpha',
      'BLOCKED',
      'This week'
    ])
  })
})
