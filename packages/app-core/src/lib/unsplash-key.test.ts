import { describe, expect, it } from 'vitest'
import { unsplashKeyCheckMessage, unsplashKeyPlace, unsplashKeyRefusalMessage } from './unsplash-key'

describe('what Settings says about the Unsplash key', () => {
  it('reports a working key with what is left of the hour', () => {
    expect(unsplashKeyCheckMessage({ ok: true, remaining: 49, limit: 50 }, 'save')).toEqual({
      tone: 'ok',
      text: 'Saved. Unsplash accepted the key: 49 of 50 requests left this hour.'
    })
    expect(unsplashKeyCheckMessage({ ok: true, remaining: null, limit: null }, 'test')).toEqual({
      tone: 'ok',
      text: 'The key works.'
    })
  })

  it('tells a refused key, a spent hour and no connection apart', () => {
    expect(unsplashKeyCheckMessage({ ok: false, reason: 'invalid-key', limit: null }, 'test')).toMatchObject({
      tone: 'error',
      text: expect.stringContaining('Unsplash did not accept this key')
    })
    expect(unsplashKeyCheckMessage({ ok: false, reason: 'rate-limited', limit: 50 }, 'test').text).toBe(
      'Your Unsplash app has used this hour’s requests: a new Unsplash app allows 50 an hour until Unsplash approves it for production.'
    )
    expect(unsplashKeyCheckMessage({ ok: false, reason: 'rate-limited', limit: null }, 'save').text).toMatch(/^Saved\. /)
    expect(unsplashKeyCheckMessage({ ok: false, reason: 'offline', limit: null }, 'save').text).toBe(
      'Saved, but Unsplash could not be reached to check it. The Unsplash tab says so if Unsplash refuses it.'
    )
  })

  it('says why a pasted key was not saved', () => {
    expect(unsplashKeyRefusalMessage('invalid-key', 'system').text).toContain('not the Secret Key')
    expect(unsplashKeyRefusalMessage('malformed', 'system').text).toContain('does not look like an Unsplash Access Key')
    expect(unsplashKeyRefusalMessage('cannot-store', 'system', true).text).toContain('--password-store=gnome-libsecret')
    expect(unsplashKeyRefusalMessage('cannot-store', 'system', false).text).not.toContain('--password-store')
    expect(unsplashKeyRefusalMessage('cannot-store', 'browser').text).toContain('This browser would not keep the key')
  })

  it('names where the key is kept', () => {
    expect(unsplashKeyPlace('system')).toBe('your system’s secure storage')
    expect(unsplashKeyPlace('browser')).toBe('this browser')
  })
})
