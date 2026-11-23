import { describe, expect, it } from 'vitest'
import { saveRetryDelay, serverBodyIsSafeToOverwrite, serverCopyPath } from './save-retry'

describe('save retry (#1108)', () => {
  it('backs off, then settles at once a minute', () => {
    expect([0, 1, 2, 3, 4, 5, 50].map(saveRetryDelay)).toEqual([
      2_000, 5_000, 15_000, 30_000, 60_000, 60_000, 60_000
    ])
  })

  it('names the server copy beside the note and steps past taken names', () => {
    expect(serverCopyPath('inbox/Plan.md', () => false)).toBe('inbox/Plan (server copy).md')
    const taken = new Set(['Plan (server copy).md', 'Plan (server copy 2).md'])
    expect(serverCopyPath('Plan.md', (p) => taken.has(p))).toBe('Plan (server copy 3).md')
    expect(serverCopyPath('a/.hidden', () => false)).toBe('a/.hidden (server copy)')
  })

  it('overwrites only a server that holds the base or already the buffer', () => {
    expect(serverBodyIsSafeToOverwrite('base', 'base', 'mine')).toBe(true)
    expect(serverBodyIsSafeToOverwrite('mine', 'base', 'mine')).toBe(true)
    expect(serverBodyIsSafeToOverwrite('theirs', 'base', 'mine')).toBe(false)
    expect(serverBodyIsSafeToOverwrite('theirs', undefined, 'mine')).toBe(true)
  })
})
