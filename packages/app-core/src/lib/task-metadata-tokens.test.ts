import { describe, expect, it } from 'vitest'
import { fieldChip, priorityLevel, scanTaskMetadata } from './task-metadata-tokens'

const kinds = (text: string): string[] =>
  scanTaskMetadata(text).map((t) => `${t.kind}:${t.text}`)

describe('scanTaskMetadata (#454, #479)', () => {
  it('finds the three token kinds in document order', () => {
    expect(kinds('Ship it !high due:2026-07-20 @waiting')).toEqual([
      'priority:!high',
      'due:due:2026-07-20',
      'field:@waiting'
    ])
  })

  it('maps every priority spelling onto its level', () => {
    expect(['!high', '!h', '!HIGH'].map(priorityLevel)).toEqual(['high', 'high', 'high'])
    expect(['!med', '!medium', '!m'].map(priorityLevel)).toEqual(['med', 'med', 'med'])
    expect(['!low', '!l'].map(priorityLevel)).toEqual(['low', 'low'])
  })

  it('only matches tokens that start a word', () => {
    // Glued to a preceding word these are not metadata, they are prose.
    expect(scanTaskMetadata('wow!high and mail@waiting and overdue:2026-01-01')).toEqual([])
  })

  it('ignores a due token whose date is not a real ISO date', () => {
    expect(kinds('Bad date due:soon and due:2026-13')).toEqual([])
    expect(kinds('Good due:2026-01-31')).toEqual(['due:due:2026-01-31'])
  })

  it('reports offsets that bracket the token text exactly', () => {
    const text = 'Ship it !high now'
    const [token] = scanTaskMetadata(text)
    expect(text.slice(token.start, token.end)).toBe('!high')
  })

  it('carries the ISO date on due tokens for the overdue decision', () => {
    const [due] = scanTaskMetadata('Renew due:2026-07-20')
    expect(due.kind).toBe('due')
    expect(due.date).toBe('2026-07-20')
  })
})

// #1119: the planned day wears its own color in the editor and the reading
// view, and a value that is not a date draws dimmed, since it plans nothing.
describe('fieldChip for the planned day (#1119)', () => {
  const chip = (text: string) => fieldChip(scanTaskMetadata(text)[0])

  it('marks a dated @scheduled: as the planned day and says which', () => {
    const planned = chip('@scheduled:2026-12-02')
    expect(planned).toMatchObject({ variant: 'scheduled', invalid: false })
    expect(planned.title).toMatch(/^Planned for .*2/)
  })

  it('dims a value that is not a date', () => {
    expect(chip('@scheduled:friday')).toMatchObject({ variant: 'scheduled', invalid: true })
    expect(chip('@Scheduled:2026-12-02-14h00')).toMatchObject({ variant: 'scheduled', invalid: true })
  })

  it('leaves every other field plain', () => {
    expect(chip('@sprint:24')).toEqual({ variant: null, invalid: false })
  })
})
