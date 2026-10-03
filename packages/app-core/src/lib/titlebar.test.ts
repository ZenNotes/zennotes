import { describe, expect, it } from 'vitest'
import { shouldShowWindowControls } from './titlebar'

describe('shouldShowWindowControls — hidden on mac and in the web runtime', () => {
  it('shows controls on desktop, non-mac', () => {
    expect(shouldShowWindowControls('win32', 'desktop')).toBe(true)
    expect(shouldShowWindowControls('linux', 'desktop')).toBe(true)
  })

  it('hides controls in the web runtime, regardless of platform', () => {
    expect(shouldShowWindowControls('win32', 'web')).toBe(false)
    expect(shouldShowWindowControls('linux', 'web')).toBe(false)
  })

  it('hides controls on mac, regardless of runtime', () => {
    expect(shouldShowWindowControls('darwin', 'desktop')).toBe(false)
    expect(shouldShowWindowControls('darwin', 'web')).toBe(false)
  })
})