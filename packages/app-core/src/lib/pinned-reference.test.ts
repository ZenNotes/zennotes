import { describe, expect, it } from 'vitest'
import { activeReferencePath } from './pinned-reference'

const NOTE = 'inbox/The trip.md'

describe('activeReferencePath', () => {
  it("prefers the open note's own pin", () => {
    expect(
      activeReferencePath({
        selectedPath: NOTE,
        noteRefs: { [NOTE]: { path: 'assets/Tourtickets.pdf' } },
        pinnedRefPath: 'inbox/Global.md'
      })
    ).toBe('assets/Tourtickets.pdf')
  })

  it('falls back to the global pin, also with no note open', () => {
    expect(
      activeReferencePath({ selectedPath: NOTE, noteRefs: {}, pinnedRefPath: 'inbox/Global.md' })
    ).toBe('inbox/Global.md')
    expect(
      activeReferencePath({
        selectedPath: null,
        noteRefs: { [NOTE]: { path: 'assets/Tourtickets.pdf' } },
        pinnedRefPath: null
      })
    ).toBeNull()
  })
})
