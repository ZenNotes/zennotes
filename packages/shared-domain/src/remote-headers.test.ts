import { describe, expect, it } from 'vitest'
import {
  applyRemoteHeaders,
  formatRemoteHeaders,
  parseRemoteHeaders,
  remoteHeadersFromEnv,
  sanitizeRemoteHeaders
} from './remote-headers'

const CLOUDFLARE = 'CF-Access-Client-Id: abc123.access\nCF-Access-Client-Secret: s3cr3t'

describe('parseRemoteHeaders', () => {
  it('reads a Cloudflare Access service token', () => {
    expect(parseRemoteHeaders(CLOUDFLARE)).toEqual({
      ok: true,
      headers: [
        { name: 'CF-Access-Client-Id', value: 'abc123.access' },
        { name: 'CF-Access-Client-Secret', value: 's3cr3t' }
      ]
    })
  })

  it('skips blank lines and comments, trims, and keeps colons inside the value', () => {
    const parsed = parseRemoteHeaders('\n# gateway\n  X-Trace :  a:b:c  \r\n\n')
    expect(parsed).toEqual({ ok: true, headers: [{ name: 'X-Trace', value: 'a:b:c' }] })
  })

  it('reads an empty box as no headers', () => {
    expect(parseRemoteHeaders('  \n ')).toEqual({ ok: true, headers: [] })
  })

  it('names the line that is wrong', () => {
    expect(parseRemoteHeaders('X-A: 1\nno colon here')).toEqual({
      ok: false,
      error: 'Line 2: write each header as Name: value.'
    })
    expect(parseRemoteHeaders('Bad Name: 1')).toMatchObject({ ok: false })
    expect(parseRemoteHeaders('X-Empty:')).toEqual({ ok: false, error: 'Line 1: X-Empty has no value.' })
  })

  it('refuses names the connection or the auth token own', () => {
    expect(parseRemoteHeaders('Authorization: Bearer x')).toEqual({
      ok: false,
      error: 'Line 1: use the Auth token field for Authorization.'
    })
    for (const name of ['Host', 'content-length', 'Upgrade', 'Sec-WebSocket-Key', 'Connection']) {
      expect(parseRemoteHeaders(`${name}: x`).ok).toBe(false)
    }
  })

  it('refuses a name given twice, in any case', () => {
    expect(parseRemoteHeaders('X-A: 1\nx-a: 2')).toEqual({
      ok: false,
      error: 'Line 2: x-a is listed twice.'
    })
  })

  it('refuses a control character that would split the request', () => {
    expect(parseRemoteHeaders('X-A: one\u0000two').ok).toBe(false)
  })

  it('round-trips through formatRemoteHeaders', () => {
    const parsed = parseRemoteHeaders(CLOUDFLARE)
    if (!parsed.ok) throw new Error(parsed.error)
    expect(formatRemoteHeaders(parsed.headers)).toBe(CLOUDFLARE)
  })
})

describe('sanitizeRemoteHeaders', () => {
  it('keeps a valid stored list', () => {
    expect(sanitizeRemoteHeaders([{ name: 'X-A', value: '1' }])).toEqual([{ name: 'X-A', value: '1' }])
  })

  it('drops a damaged list whole instead of sending part of it', () => {
    expect(sanitizeRemoteHeaders([{ name: 'X-A', value: '1' }, { name: 'Host', value: 'x' }])).toEqual([])
    expect(sanitizeRemoteHeaders([{ name: 'X-A' }])).toEqual([])
    expect(sanitizeRemoteHeaders('X-A: 1')).toEqual([])
    expect(sanitizeRemoteHeaders(null)).toEqual([])
  })
})

describe('remoteHeadersFromEnv', () => {
  it('is empty when the variable is unset or blank', () => {
    expect(remoteHeadersFromEnv({})).toEqual([])
    expect(remoteHeadersFromEnv({ ZENNOTES_REMOTE_HEADERS: '  ' })).toEqual([])
  })

  it('reads real line breaks and the two characters \\n from a JSON env block', () => {
    const expected = [
      { name: 'CF-Access-Client-Id', value: 'abc123.access' },
      { name: 'CF-Access-Client-Secret', value: 's3cr3t' }
    ]
    expect(remoteHeadersFromEnv({ ZENNOTES_REMOTE_HEADERS: CLOUDFLARE })).toEqual(expected)
    expect(
      remoteHeadersFromEnv({ ZENNOTES_REMOTE_HEADERS: CLOUDFLARE.replace('\n', '\\n') })
    ).toEqual(expected)
  })

  it('throws with the variable name when the value does not parse', () => {
    expect(() => remoteHeadersFromEnv({ ZENNOTES_REMOTE_HEADERS: 'nonsense' })).toThrow(
      'ZENNOTES_REMOTE_HEADERS: Line 1: write each header as Name: value.'
    )
  })
})

describe('applyRemoteHeaders', () => {
  it('adds the headers without replacing one the request already set', () => {
    const headers = new Headers({ 'Content-Type': 'application/json', 'X-A': 'kept' })
    applyRemoteHeaders(headers, [
      { name: 'X-A', value: 'ignored' },
      { name: 'CF-Access-Client-Id', value: 'id' }
    ])
    expect(headers.get('X-A')).toBe('kept')
    expect(headers.get('CF-Access-Client-Id')).toBe('id')
  })
})
