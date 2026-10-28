import { describe, expect, it } from 'vitest'
import { statusBarVisible } from './status-bar-visibility'

const base = {
  zenMode: false,
  hasNote: true,
  cloudShown: true,
  showStatusBar: true,
  cloudNeedsUser: false
}

describe('statusBarVisible', () => {
  it('shows by default over a note or a Cloud status', () => {
    expect(statusBarVisible(base)).toBe(true)
    expect(statusBarVisible({ ...base, hasNote: false })).toBe(true)
    expect(statusBarVisible({ ...base, cloudShown: false })).toBe(true)
  })

  it('has nothing to say with no note and no Cloud', () => {
    expect(statusBarVisible({ ...base, hasNote: false, cloudShown: false })).toBe(false)
  })

  it('turned off, it stays away until Cloud needs the user', () => {
    expect(statusBarVisible({ ...base, showStatusBar: false })).toBe(false)
    expect(statusBarVisible({ ...base, showStatusBar: false, cloudNeedsUser: true })).toBe(true)
    expect(
      statusBarVisible({ ...base, showStatusBar: false, cloudNeedsUser: true, hasNote: false })
    ).toBe(true)
  })

  it('Zen mode clears it whatever the setting or Cloud says', () => {
    expect(statusBarVisible({ ...base, zenMode: true })).toBe(false)
    expect(statusBarVisible({ ...base, zenMode: true, cloudNeedsUser: true })).toBe(false)
  })
})
