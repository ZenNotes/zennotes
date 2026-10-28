import { describe, expect, it } from 'vitest'
import type { NoteMeta } from '@shared/ipc'
import { resolveQuickNoteTitle } from './quick-note-title'

const at = new Date(2026, 9, 28, 9, 5)

function quick(title: string): NoteMeta {
  return { path: `quick/${title}.md`, title, folder: 'quick' } as NoteMeta
}

describe('resolveQuickNoteTitle', () => {
  it('puts the prefix in front of the timestamp', () => {
    expect(resolveQuickNoteTitle([], false, 'Quick Note', at)).toBe('Quick Note 2026-10-28 0905')
    expect(resolveQuickNoteTitle([], false, 'Scratch pad', at)).toBe('Scratch pad 2026-10-28 0905')
  })

  // A cleared Settings field is stored as null; it must not come back as the
  // old "Quick Note" default (#1008).
  it('titles with the bare timestamp when the prefix was cleared', () => {
    expect(resolveQuickNoteTitle([], false, null, at)).toBe('2026-10-28 0905')
    expect(resolveQuickNoteTitle([], false, '', at)).toBe('2026-10-28 0905')
    expect(resolveQuickNoteTitle([], false, '   ', at)).toBe('2026-10-28 0905')
  })

  it('titles with the bare date when date titles are on and the prefix was cleared', () => {
    expect(resolveQuickNoteTitle([], true, null, at)).toBe('2026-10-28')
    expect(resolveQuickNoteTitle([quick('2026-10-28')], true, null, at)).toBe('2026-10-28 (2)')
    expect(
      resolveQuickNoteTitle([quick('2026-10-28'), quick('2026-10-28 (2)')], true, null, at)
    ).toBe('2026-10-28 (3)')
  })

  it('numbers a prefixed date title the same way', () => {
    expect(resolveQuickNoteTitle([], true, 'Quick Note', at)).toBe('Quick Note 2026-10-28')
    expect(resolveQuickNoteTitle([quick('Quick Note 2026-10-28')], true, 'Quick Note', at)).toBe(
      'Quick Note 2026-10-28 (2)'
    )
  })
})
