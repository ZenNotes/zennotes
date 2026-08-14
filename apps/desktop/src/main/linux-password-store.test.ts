import { describe, expect, it } from 'vitest'
import { shouldForceGnomeLibsecret } from './linux-password-store'

describe('shouldForceGnomeLibsecret', () => {
  // The report that motivated this: Niri with a healthy gnome-keyring, where
  // Chromium's desktop detection falls back to plaintext and cloud sign-in
  // cannot store its credential.
  it('forces libsecret on compositors Chromium does not recognize', () => {
    expect(shouldForceGnomeLibsecret({ XDG_CURRENT_DESKTOP: 'niri' })).toBe(true)
    expect(shouldForceGnomeLibsecret({ XDG_CURRENT_DESKTOP: 'Hyprland' })).toBe(true)
    expect(shouldForceGnomeLibsecret({ XDG_CURRENT_DESKTOP: 'sway' })).toBe(true)
    expect(shouldForceGnomeLibsecret({ XDG_CURRENT_DESKTOP: 'river' })).toBe(true)
  })

  // Harmless on headless sessions: libsecret init fails without a bus and
  // Chromium falls back to plaintext, the same outcome as without the switch.
  it('forces libsecret when no desktop is declared at all', () => {
    expect(shouldForceGnomeLibsecret({})).toBe(true)
  })

  it('defers to Chromium on desktops it recognizes', () => {
    expect(shouldForceGnomeLibsecret({ XDG_CURRENT_DESKTOP: 'GNOME' })).toBe(false)
    expect(shouldForceGnomeLibsecret({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' })).toBe(false)
    expect(shouldForceGnomeLibsecret({ XDG_CURRENT_DESKTOP: 'KDE' })).toBe(false)
    expect(shouldForceGnomeLibsecret({ XDG_CURRENT_DESKTOP: 'X-Cinnamon' })).toBe(false)
    expect(shouldForceGnomeLibsecret({ XDG_CURRENT_DESKTOP: 'XFCE' })).toBe(false)
    expect(shouldForceGnomeLibsecret({ XDG_CURRENT_DESKTOP: 'LXQt' })).toBe(false)
    expect(shouldForceGnomeLibsecret({ XDG_CURRENT_DESKTOP: 'Unity:Unity7:ubuntu' })).toBe(false)
  })

  it('bails out when the fallback session variables identify a desktop', () => {
    expect(shouldForceGnomeLibsecret({ DESKTOP_SESSION: 'kde-plasma' })).toBe(false)
    expect(shouldForceGnomeLibsecret({ DESKTOP_SESSION: 'mate' })).toBe(false)
    expect(shouldForceGnomeLibsecret({ DESKTOP_SESSION: 'xubuntu' })).toBe(false)
    expect(
      shouldForceGnomeLibsecret({ XDG_CURRENT_DESKTOP: 'weird', GNOME_DESKTOP_SESSION_ID: 'this-is-deprecated' })
    ).toBe(false)
    expect(
      shouldForceGnomeLibsecret({ XDG_CURRENT_DESKTOP: 'weird', KDE_FULL_SESSION: 'true' })
    ).toBe(false)
  })
})
