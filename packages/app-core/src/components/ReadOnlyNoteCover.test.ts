// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gradientCoverDataUrl, NOTE_COVER_GRADIENTS } from '@shared/note-cover-gradients'
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

  it('draws no cover for a source it refuses', () => {
    act(() => root.render(createElement(ReadOnlyNoteCover, { url: 'javascript:alert(1)', y: 0.5 })))
    expect(host.querySelector('[data-note-cover]')).toBeNull()
  })
})
