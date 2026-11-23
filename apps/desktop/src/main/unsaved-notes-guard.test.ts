import { describe, expect, it } from 'vitest'
import { UnsavedNotesLedger, unsavedNotesPrompt } from './unsaved-notes-guard'

describe('unsaved notes guard (#1108)', () => {
  it('counts per window and drops a window that reports zero or closes', () => {
    const ledger = new UnsavedNotesLedger()
    ledger.report(1, 2)
    ledger.report(2, 1)
    expect(ledger.total()).toBe(3)
    ledger.report(1, 0)
    expect(ledger.countFor(1)).toBe(0)
    ledger.forget(2)
    expect(ledger.total()).toBe(0)
  })

  it('treats a malformed renderer payload as nothing to guard', () => {
    const ledger = new UnsavedNotesLedger()
    for (const bad of ['3', null, NaN, -4, Infinity, { n: 1 }]) ledger.report(1, bad)
    expect(ledger.total()).toBe(0)
  })

  it('asks with keep-open first and names the action', () => {
    const one = unsavedNotesPrompt(1, 'quit')
    expect(one.message).toBe('1 note has changes that are not saved.')
    expect(one.buttons).toEqual(['Keep ZenNotes Open', 'Quit Anyway'])
    const many = unsavedNotesPrompt(3, 'close')
    expect(many.message).toBe('3 notes have changes that are not saved.')
    expect(many.buttons[1]).toBe('Close Anyway')
    expect(`${one.detail}${many.detail}`).not.toMatch(/\u2014/)
  })
})
