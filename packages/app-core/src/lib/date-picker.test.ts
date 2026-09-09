import { describe, expect, it } from 'vitest'
import {
  addMonths,
  buildMonthGrid,
  datePickerMoveForKey,
  formatISODate,
  moveDate,
  parseISODate,
  startOfWeek
} from './date-picker'

describe('parseISODate', () => {
  it('round-trips a real local calendar day', () => {
    const date = parseISODate('2026-09-08')
    expect(date).not.toBeNull()
    expect(date!.getFullYear()).toBe(2026)
    expect(date!.getMonth()).toBe(8)
    expect(date!.getDate()).toBe(8)
    expect(date!.getHours()).toBe(0)
    expect(formatISODate(date!)).toBe('2026-09-08')
  })

  it('accepts a leap day and rejects a day the month does not have', () => {
    expect(formatISODate(parseISODate('2028-02-29')!)).toBe('2028-02-29')
    expect(parseISODate('2026-02-29')).toBeNull()
    expect(parseISODate('2026-02-30')).toBeNull()
    expect(parseISODate('2026-13-01')).toBeNull()
    expect(parseISODate('2026-00-10')).toBeNull()
  })

  it('wants the strict YYYY-MM-DD shape', () => {
    expect(parseISODate('2026-9-8')).toBeNull()
    expect(parseISODate('08/09/2026')).toBeNull()
    expect(parseISODate('2026-09-08T10:00')).toBeNull()
    expect(parseISODate('')).toBeNull()
  })
})

describe('addMonths', () => {
  it('clamps the day to the target month instead of rolling over', () => {
    expect(formatISODate(addMonths(parseISODate('2026-01-31')!, 1))).toBe('2026-02-28')
    expect(formatISODate(addMonths(parseISODate('2028-01-31')!, 1))).toBe('2028-02-29')
    expect(formatISODate(addMonths(parseISODate('2026-03-31')!, -1))).toBe('2026-02-28')
    expect(formatISODate(addMonths(parseISODate('2026-12-15')!, 1))).toBe('2027-01-15')
    expect(formatISODate(addMonths(parseISODate('2028-02-29')!, 12))).toBe('2029-02-28')
  })
})

describe('buildMonthGrid', () => {
  it('lays out six weeks starting on the configured weekday', () => {
    const monday = buildMonthGrid(parseISODate('2026-09-01')!, 1)
    expect(monday).toHaveLength(42)
    expect(monday[0].getDay()).toBe(1)
    // September 2026 starts on a Tuesday: one leading day from August.
    expect(formatISODate(monday[0])).toBe('2026-08-31')
    expect(formatISODate(monday[1])).toBe('2026-09-01')
    expect(formatISODate(monday[41])).toBe('2026-10-11')

    const sunday = buildMonthGrid(parseISODate('2026-09-20')!, 0)
    expect(sunday[0].getDay()).toBe(0)
    expect(formatISODate(sunday[0])).toBe('2026-08-30')
  })
})

describe('moveDate', () => {
  const firstDay = 1
  const at = (iso: string): Date => parseISODate(iso)!

  it('moves by day, week, month and year', () => {
    expect(formatISODate(moveDate(at('2026-09-08'), 'prev-day', firstDay))).toBe('2026-09-07')
    expect(formatISODate(moveDate(at('2026-09-08'), 'next-day', firstDay))).toBe('2026-09-09')
    expect(formatISODate(moveDate(at('2026-09-08'), 'prev-week', firstDay))).toBe('2026-09-01')
    expect(formatISODate(moveDate(at('2026-09-08'), 'next-week', firstDay))).toBe('2026-09-15')
    expect(formatISODate(moveDate(at('2026-09-30'), 'prev-month', firstDay))).toBe('2026-08-30')
    expect(formatISODate(moveDate(at('2026-01-31'), 'next-month', firstDay))).toBe('2026-02-28')
    expect(formatISODate(moveDate(at('2026-09-08'), 'prev-year', firstDay))).toBe('2025-09-08')
    expect(formatISODate(moveDate(at('2026-09-08'), 'next-year', firstDay))).toBe('2027-09-08')
  })

  it('crosses month and year boundaries a day at a time', () => {
    expect(formatISODate(moveDate(at('2026-12-31'), 'next-day', firstDay))).toBe('2027-01-01')
    expect(formatISODate(moveDate(at('2026-03-01'), 'prev-day', firstDay))).toBe('2026-02-28')
  })

  it('finds the ends of the week for the configured first day', () => {
    // 2026-09-10 is a Thursday.
    expect(formatISODate(moveDate(at('2026-09-10'), 'week-start', 1))).toBe('2026-09-07')
    expect(formatISODate(moveDate(at('2026-09-10'), 'week-end', 1))).toBe('2026-09-13')
    expect(formatISODate(moveDate(at('2026-09-10'), 'week-start', 0))).toBe('2026-09-06')
    expect(formatISODate(moveDate(at('2026-09-10'), 'week-end', 0))).toBe('2026-09-12')
    expect(formatISODate(startOfWeek(at('2026-09-07'), 1))).toBe('2026-09-07')
  })

  it('jumps to today at local midnight', () => {
    const today = new Date(2026, 8, 8, 17, 45)
    const moved = moveDate(at('2020-01-01'), 'today', firstDay, today)
    expect(formatISODate(moved)).toBe('2026-09-08')
    expect(moved.getHours()).toBe(0)
  })
})

describe('datePickerMoveForKey', () => {
  it('follows the ARIA date-grid keys with any editing mode', () => {
    const off = { shift: false, vimMode: false }
    expect(datePickerMoveForKey('ArrowLeft', off)).toBe('prev-day')
    expect(datePickerMoveForKey('ArrowRight', off)).toBe('next-day')
    expect(datePickerMoveForKey('ArrowUp', off)).toBe('prev-week')
    expect(datePickerMoveForKey('ArrowDown', off)).toBe('next-week')
    expect(datePickerMoveForKey('PageUp', off)).toBe('prev-month')
    expect(datePickerMoveForKey('PageDown', off)).toBe('next-month')
    expect(datePickerMoveForKey('PageUp', { ...off, shift: true })).toBe('prev-year')
    expect(datePickerMoveForKey('PageDown', { ...off, shift: true })).toBe('next-year')
    expect(datePickerMoveForKey('Home', off)).toBe('week-start')
    expect(datePickerMoveForKey('End', off)).toBe('week-end')
  })

  it('adds h/j/k/l and t only while Vim mode is on', () => {
    const on = { shift: false, vimMode: true }
    expect(datePickerMoveForKey('h', on)).toBe('prev-day')
    expect(datePickerMoveForKey('l', on)).toBe('next-day')
    expect(datePickerMoveForKey('k', on)).toBe('prev-week')
    expect(datePickerMoveForKey('j', on)).toBe('next-week')
    expect(datePickerMoveForKey('t', on)).toBe('today')
    const off = { shift: false, vimMode: false }
    for (const key of ['h', 'j', 'k', 'l', 't']) {
      expect(datePickerMoveForKey(key, off)).toBeNull()
    }
    expect(datePickerMoveForKey('x', on)).toBeNull()
  })
})
