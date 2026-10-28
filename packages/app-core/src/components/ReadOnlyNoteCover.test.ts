// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gradientCoverDataUrl, NOTE_COVER_GRADIENTS } from '@shared/note-cover-gradients'
import { noteCoverCreditLine } from '@shared/unsplash'
import { ReadOnlyNoteCover, readOnlyCoverSource } from './ReadOnlyNoteCover'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('readOnlyCoverSource', () => {
  it('keeps the sources the share page and Quick Look hand over', () => {
    expect(readOnlyCoverSource('https://share.zennotes.org/a/lisbon.jpg')).toBe('https://share.zennotes.org/a/lisbon.jpg')
    expect(readOnlyCoverSource('http://example.com/a.png')).toBe('http://example.com/a.png')
    expect(readOnlyCoverSource('zenql://app/cover/pics%2Fa%20b.png')).toBe('zenql://app/cover/pics%2Fa%20b.png')
    const gradient = gradientCoverDataUrl(NOTE_COVER_GRADIENTS[0])
    expect(readOnlyCoverSource(gradient)).toBe(gradient)
  })

  it('refuses anything else', () => {
    expect(readOnlyCoverSource('javascript:alert(1)')).toBeNull()
    expect(readOnlyCoverSource(' JavaScript:alert(1)')).toBeNull()
    expect(readOnlyCoverSource('data:text/html,<script>alert(1)</script>')).toBeNull()
    expect(readOnlyCoverSource('file:///etc/passwd')).toBeNull()
    expect(readOnlyCoverSource('assets/lisbon.jpg')).toBeNull()
    expect(readOnlyCoverSource('')).toBeNull()
  })
})

describe('ReadOnlyNoteCover', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('draws an allowed source at the focal point', () => {
    act(() => root.render(createElement(ReadOnlyNoteCover, { url: 'https://example.com/a.png', y: 0.25 })))
    const img = host.querySelector('[data-note-cover="read-only"] img') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('https://example.com/a.png')
    expect(img.style.objectPosition).toBe('50% 25%')
  })

  it('keeps an Unsplash credit in view, with both links tagged for Unsplash', () => {
    const url = 'https://images.unsplash.com/photo-1?ixid=x&w=2400&q=80&auto=format'
    const credit = noteCoverCreditLine({
      key: 'banner',
      target: { kind: 'url', url },
      y: 0.5,
      credit: { name: 'Jane Doe', url: 'https://unsplash.com/@janedoe' }
    })
    act(() => root.render(createElement(ReadOnlyNoteCover, { url, y: 0.5, credit })))
    const line = host.querySelector('[data-note-cover-credit]') as HTMLElement
    expect(line.textContent).toBe('Photo by Jane Doe on Unsplash')
    expect(line.className).not.toContain('opacity-0')
    const links = Array.from(line.querySelectorAll('a')).map((a) => [a.textContent, a.getAttribute('href'), a.target])
    expect(links).toEqual([
      ['Jane Doe', 'https://unsplash.com/@janedoe?utm_source=zennotes&utm_medium=referral', '_blank'],
      ['Unsplash', 'https://unsplash.com/?utm_source=zennotes&utm_medium=referral', '_blank']
    ])
  })

  it('draws a plain credit as written, and none without one', () => {
    const credit = noteCoverCreditLine({ key: 'banner', target: { kind: 'vault', href: 'a.png' }, y: 0.5, credit: { name: 'Me', url: null } })
    act(() => root.render(createElement(ReadOnlyNoteCover, { url: 'https://example.com/a.png', y: 0.5, credit })))
    expect(host.querySelector('[data-note-cover-credit]')?.textContent).toBe('Me')
    expect(host.querySelector('[data-note-cover-credit] a')).toBeNull()
    act(() => root.render(createElement(ReadOnlyNoteCover, { url: 'https://example.com/a.png', y: 0.5 })))
    expect(host.querySelector('[data-note-cover-credit]')).toBeNull()
  })

  it('draws no cover for a source it refuses', () => {
    act(() => root.render(createElement(ReadOnlyNoteCover, { url: 'javascript:alert(1)', y: 0.5 })))
    expect(host.querySelector('[data-note-cover]')).toBeNull()
  })
})
