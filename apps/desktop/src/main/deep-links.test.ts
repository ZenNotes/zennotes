import { describe, expect, it } from 'vitest'
import {
  buildOpenNoteDeepLink,
  cloudSignInUsesLoopback,
  parseCloudAuthDeepLink,
  parseOpenNoteDeepLink,
  parseQuickCaptureDeepLink,
  registersDeepLinkSchemeAtLaunch
} from './deep-links'

describe('parseOpenNoteDeepLink', () => {
  it('parses encoded vault-relative paths', () => {
    expect(
      parseOpenNoteDeepLink('zennotes://open?path=hellointerview%2Fsystem%20design.md')
    ).toEqual({ target: 'tab', path: 'hellointerview/system design.md' })
  })

  it('parses floating window note links', () => {
    expect(
      parseOpenNoteDeepLink('zennotes://open-window?path=hellointerview%2Fsystem%20design.md')
    ).toEqual({ target: 'window', path: 'hellointerview/system design.md' })
  })

  it('parses single-slash action URLs', () => {
    expect(parseOpenNoteDeepLink('zennotes:/open?path=inbox%2Fdaily.md')).toEqual({
      target: 'tab',
      path: 'inbox/daily.md'
    })
  })

  it('normalizes duplicate separators', () => {
    expect(parseOpenNoteDeepLink('zennotes://open?path=inbox//daily.md')).toEqual({
      target: 'tab',
      path: 'inbox/daily.md'
    })
  })

  it('rejects unsupported schemes and actions', () => {
    expect(parseOpenNoteDeepLink('https://open?path=note.md')).toBeNull()
    expect(parseOpenNoteDeepLink('zennotes://settings')).toBeNull()
  })

  it('rejects empty or unsafe paths', () => {
    expect(parseOpenNoteDeepLink('zennotes://open')).toBeNull()
    expect(parseOpenNoteDeepLink('zennotes://open?path=%2Fetc%2Fpasswd')).toBeNull()
    expect(parseOpenNoteDeepLink('zennotes://open?path=..%2Fsecret.md')).toBeNull()
    expect(parseOpenNoteDeepLink('zennotes://open?path=notes%2F..%2Fsecret.md')).toBeNull()
    expect(parseOpenNoteDeepLink('zennotes://open?path=C%3A%2FUsers%2Fnote.md')).toBeNull()
  })
})

describe('buildOpenNoteDeepLink', () => {
  it('percent-encodes segments and keeps slashes readable', () => {
    expect(buildOpenNoteDeepLink('inbox/GitHub/Rename -master- branch.md')).toBe(
      'zennotes://open?path=inbox/GitHub/Rename%20-master-%20branch.md'
    )
  })

  it('encodes markdown-hostile and query-hostile characters', () => {
    expect(buildOpenNoteDeepLink('inbox/Meeting (draft).md')).toBe(
      'zennotes://open?path=inbox/Meeting%20%28draft%29.md'
    )
    expect(buildOpenNoteDeepLink('inbox/Q&A #5.md')).toBe(
      'zennotes://open?path=inbox/Q%26A%20%235.md'
    )
  })

  it('round-trips through the parser, unicode included', () => {
    for (const rel of [
      'inbox/Dune.md',
      'inbox/GitHub/Rename -master- branch to -main- using GitHub UI.md',
      'quick/Meeting (draft) für Q&A? #5.md',
      'archive/日本語のノート.md'
    ]) {
      expect(parseOpenNoteDeepLink(buildOpenNoteDeepLink(rel))).toEqual({
        target: 'tab',
        path: rel
      })
    }
  })
})

describe('parseQuickCaptureDeepLink', () => {
  it('parses quick capture links', () => {
    expect(parseQuickCaptureDeepLink('zennotes://quick-capture')).toBe(true)
    expect(parseQuickCaptureDeepLink('zennotes:/quick-capture')).toBe(true)
  })

  it('rejects other links', () => {
    expect(parseQuickCaptureDeepLink('zennotes://open?path=note.md')).toBe(false)
    expect(parseQuickCaptureDeepLink('https://quick-capture')).toBe(false)
  })
})

describe('parseCloudAuthDeepLink', () => {
  it('accepts the one-time code and state callback', () => {
    expect(
      parseCloudAuthDeepLink('zennotes://auth?code=AbC123&state=state_123-abc.xyz')
    ).toEqual({ code: 'AbC123', state: 'state_123-abc.xyz' })
  })

  it('rejects malformed callbacks and unrelated actions', () => {
    expect(parseCloudAuthDeepLink('zennotes://auth?code=abc')).toBeNull()
    expect(parseCloudAuthDeepLink('zennotes://auth?code=abc%2Fdef&state=state')).toBeNull()
    expect(parseCloudAuthDeepLink('zennotes://open?code=abc&state=state')).toBeNull()
    expect(parseCloudAuthDeepLink('https://zennotes.org/auth?code=abc&state=state')).toBeNull()
  })
})

describe('registersDeepLinkSchemeAtLaunch', () => {
  it('registers on Windows, where no installer writes the scheme (#509)', () => {
    expect(registersDeepLinkSchemeAtLaunch('win32', true)).toBe(true)
    // A dev build passes its own path and app folder, which Windows honors.
    expect(registersDeepLinkSchemeAtLaunch('win32', false)).toBe(true)
  })

  it('registers a packaged app on macOS, never an unpackaged run', () => {
    expect(registersDeepLinkSchemeAtLaunch('darwin', true)).toBe(true)
    // macOS would register the bare Electron.app, which opens no vault.
    expect(registersDeepLinkSchemeAtLaunch('darwin', false)).toBe(false)
  })

  it('leaves Linux to the package desktop file and the user choice', () => {
    expect(registersDeepLinkSchemeAtLaunch('linux', true)).toBe(false)
    expect(registersDeepLinkSchemeAtLaunch('linux', false)).toBe(false)
  })
})

describe('cloudSignInUsesLoopback', () => {
  it('returns Windows and Linux sign-ins through the loopback page (#509)', () => {
    expect(cloudSignInUsesLoopback(true, 'win32')).toBe(true)
    expect(cloudSignInUsesLoopback(true, 'linux')).toBe(true)
  })

  it('keeps the zennotes:// link for packaged macOS', () => {
    expect(cloudSignInUsesLoopback(true, 'darwin')).toBe(false)
  })

  it('uses the loopback in development builds everywhere, as before', () => {
    expect(cloudSignInUsesLoopback(false, 'darwin')).toBe(true)
    expect(cloudSignInUsesLoopback(false, 'win32')).toBe(true)
  })
})
