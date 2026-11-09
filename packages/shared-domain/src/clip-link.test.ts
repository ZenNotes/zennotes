import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildClipLink,
  clipTextSha256Hex,
  encodeClipLinkValue,
  parseClipLink,
  verifiedClipboardText,
  type ClipLinkRejection,
  type ClipLinkRequest
} from './clip-link'

type FixtureLink = string | { prefix: string; repeat: string; times: number; suffix: string }

interface Fixtures {
  accept: { name: string; link: FixtureLink; expect: ClipLinkRequest; canonical: boolean }[]
  reject: { name: string; link: FixtureLink; reason: ClipLinkRejection }[]
  notClip: string[]
  hashes: { text: string; sha256: string }[]
}

// The same file the extension and the phones test against.
const fixtures = JSON.parse(
  readFileSync(new URL('../../../docs/web-clipper-link.fixtures.json', import.meta.url), 'utf8')
) as Fixtures

function linkOf(link: FixtureLink): string {
  return typeof link === 'string' ? link : link.prefix + link.repeat.repeat(link.times) + link.suffix
}

describe('parseClipLink fixtures', () => {
  for (const c of fixtures.accept) {
    it(`accepts: ${c.name}`, () => {
      expect(parseClipLink(linkOf(c.link))).toEqual({ ok: true, request: c.expect })
    })
    if (c.canonical) {
      it(`builds canonically: ${c.name}`, () => {
        expect(buildClipLink(c.expect)).toBe(linkOf(c.link))
      })
    }
    it(`round-trips: ${c.name}`, () => {
      expect(parseClipLink(buildClipLink(c.expect))).toEqual({ ok: true, request: c.expect })
    })
  }

  for (const c of fixtures.reject) {
    it(`rejects: ${c.name}`, () => {
      expect(parseClipLink(linkOf(c.link))).toEqual({ ok: false, reason: c.reason })
    })
  }

  for (const link of fixtures.notClip) {
    it(`leaves other links alone: ${link}`, () => {
      expect(parseClipLink(link)).toBeNull()
    })
  }

  for (const h of fixtures.hashes) {
    it(`hashes ${JSON.stringify(h.text.slice(0, 20))}`, async () => {
      expect(await clipTextSha256Hex(h.text)).toBe(h.sha256)
    })
  }
})

describe('verifiedClipboardText', () => {
  it('files the clipboard only when it holds what the link vouched for', async () => {
    const text = 'line one\nline two\n'
    const hash = await clipTextSha256Hex(text)
    expect(await verifiedClipboardText(text, hash)).toBe(text)
    expect(await verifiedClipboardText('a password', hash)).toBeNull()
    expect(await verifiedClipboardText('', await clipTextSha256Hex(''))).toBeNull()
  })

  it('accepts a Windows clipboard that stored CRLF, and files the LF text', async () => {
    const text = 'line one\nline two\n'
    const hash = await clipTextSha256Hex(text)
    expect(await verifiedClipboardText('line one\r\nline two\r\n', hash)).toBe(text)
    // Text the extension really sent with CRLF keeps its bytes.
    const crlf = 'kept\r\nas sent\r\n'
    expect(await verifiedClipboardText(crlf, await clipTextSha256Hex(crlf))).toBe(crlf)
  })
})

describe('encodeClipLinkValue', () => {
  it('leaves only unreserved characters bare', () => {
    expect(encodeClipLinkValue("a-b_c.d~e !'()*+/&=#?")).toBe(
      'a-b_c.d~e%20%21%27%28%29%2A%2B%2F%26%3D%23%3F'
    )
  })
})

describe('parseClipLink edge cases', () => {
  it('splits at every slash, so a slash inside a title makes a folder', () => {
    // `What: a` becomes a folder, and a colon cannot name one on Windows.
    expect(parseClipLink('zennotes://new?file=Clippings%2FWhat%3A%20a%2Fb%3F&content=x')).toEqual({
      ok: false,
      reason: 'bad-file'
    })
  })

  it('keeps title characters the app sanitizes later', () => {
    expect(parseClipLink('zennotes://new?file=Clippings%2FWhat%3F%20Why%3A&content=x')).toEqual({
      ok: true,
      request: {
        action: 'new',
        vault: null,
        folder: 'Clippings',
        name: 'What? Why:',
        body: { content: 'x' },
        position: 'create',
        silent: false
      }
    })
  })

  it('ignores a fragment', () => {
    expect(parseClipLink('zennotes://new?content=x#ignored')).toEqual({
      ok: true,
      request: {
        action: 'new',
        vault: null,
        folder: '',
        name: null,
        body: { content: 'x' },
        position: 'create',
        silent: false
      }
    })
  })
})
