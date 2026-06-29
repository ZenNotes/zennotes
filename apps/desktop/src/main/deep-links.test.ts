import { describe, expect, it } from 'vitest'
import { parseOpenNoteDeepLink, parseQuickCaptureDeepLink } from './deep-links'

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
