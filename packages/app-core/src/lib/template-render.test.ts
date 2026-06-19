import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import {
  formatDate,
  getISOWeek,
  getISOWeekYear,
  renderTemplate,
  renderTitle
} from './template-render'

const REF = new Date(2026, 4, 29, 14, 7, 9)

const originalLocaleDateString = Date.prototype.toLocaleDateString
beforeAll(() => {
  Date.prototype.toLocaleDateString = function (
    locales?: Intl.LocalesArgument,
    options?: Intl.DateTimeFormatOptions
  ) {
    return originalLocaleDateString.call(this, 'en-US', options)
  }
})

afterAll(() => {
  Date.prototype.toLocaleDateString = originalLocaleDateString
})

describe('renderTemplate', () => {
  it('substitutes title, date, time and week tokens', () => {
    const { body } = renderTemplate('# {{title}}\n{{date}} (week {{week}}) at {{time}}', {
      title: 'My Note',
      now: REF
    })
    expect(body).toBe('# My Note\n2026-05-29 (week 22) at 14:07')
  })

  it('tolerates whitespace inside braces', () => {
    const { body } = renderTemplate('{{ title }} - {{  date  }}', { title: 'X', now: REF })
    expect(body).toBe('X - 2026-05-29')
  })

  it('passes unknown tokens through unchanged', () => {
    const { body } = renderTemplate('keep {{unknown}} and {{foo:bar}}', {
      title: 'X',
      now: REF
    })
    expect(body).toBe('keep {{unknown}} and {{foo:bar}}')
  })

  it('extracts the cursor offset and strips the marker', () => {
    const { body, cursorOffset } = renderTemplate('# {{title}}\n\n{{cursor}}', {
      title: 'Hi',
      now: REF
    })
    expect(body).toBe('# Hi\n\n')
    expect(cursorOffset).toBe(body.length)
  })

  it('honours the first cursor and strips the rest', () => {
    const { body, cursorOffset } = renderTemplate('a{{cursor}}b{{cursor}}c', {
      title: 'X',
      now: REF
    })
    expect(body).toBe('abc')
    expect(cursorOffset).toBe(1)
  })

  it('returns null cursorOffset when no marker is present', () => {
    const { cursorOffset } = renderTemplate('no cursor here', { title: 'X', now: REF })
    expect(cursorOffset).toBeNull()
  })

  it('computes the cursor offset after other substitutions expand', () => {
    // {{date}} expands to a 10-char string, so the cursor offset must reflect
    // the expanded length, not the token length.
    const { body, cursorOffset } = renderTemplate('{{date}}{{cursor}}!', {
      title: 'X',
      now: REF
    })
    expect(body).toBe('2026-05-29!')
    expect(cursorOffset).toBe(10)
  })
})

describe('formatDate', () => {
  it('handles the full token table', () => {
    expect(formatDate(REF, 'YYYY-MM-DD')).toBe('2026-05-29')
    expect(formatDate(REF, 'YY/M/D')).toBe('26/5/29')
    expect(formatDate(REF, 'dddd, MMMM D, YYYY')).toBe('Friday, May 29, 2026')
    expect(formatDate(REF, 'ddd MMM')).toBe('Fri May')
    expect(formatDate(REF, 'HH:mm:ss')).toBe('14:07:09')
  })

  it('emits bracketed text literally', () => {
    expect(formatDate(REF, '[Week of] MMMM D')).toBe('Week of May 29')
  })
})

describe('renderTitle', () => {
  it('renders and trims a title pattern', () => {
    expect(renderTitle('{{date:YYYY-MM-DD}} -- ', { title: '', now: REF })).toBe('2026-05-29 --')
  })
})

describe('getISOWeek / getISOWeekYear', () => {
  it('treats 2026-01-01 (Thursday) as week 1 of 2026', () => {
    const d = new Date(2026, 0, 1)
    expect(getISOWeek(d)).toBe(1)
    expect(getISOWeekYear(d)).toBe(2026)
  })

  it('treats 2026-12-31 (Thursday) as week 53 of 2026', () => {
    const d = new Date(2026, 11, 31)
    expect(getISOWeek(d)).toBe(53)
    expect(getISOWeekYear(d)).toBe(2026)
  })

  it('rolls 2027-01-01 (Friday) back into week 53 of 2026', () => {
    const d = new Date(2027, 0, 1)
    expect(getISOWeek(d)).toBe(53)
    expect(getISOWeekYear(d)).toBe(2026)
  })

  it('treats 2024-01-01 (Monday) as week 1 of 2024', () => {
    const d = new Date(2024, 0, 1)
    expect(getISOWeek(d)).toBe(1)
    expect(getISOWeekYear(d)).toBe(2024)
  })

  it('rolls 2023-01-01 (Sunday) into week 52 of 2022', () => {
    const d = new Date(2023, 0, 1)
    expect(getISOWeek(d)).toBe(52)
    expect(getISOWeekYear(d)).toBe(2022)
  })
})
