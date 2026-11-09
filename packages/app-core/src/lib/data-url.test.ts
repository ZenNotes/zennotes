import { describe, expect, it } from 'vitest'
import { dataUrlBytes, dataUrlMimeType } from './data-url'

describe('dataUrlBytes', () => {
  it('decodes base64 payloads byte for byte', () => {
    const bytes = dataUrlBytes('data:image/png;base64,iVBORw0KGgo=')
    expect(Array.from(bytes)).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  })

  it('decodes percent-encoded text payloads', () => {
    expect(new TextDecoder().decode(dataUrlBytes('data:image/svg+xml,%3Csvg%2F%3E'))).toBe('<svg/>')
  })
})

describe('dataUrlMimeType', () => {
  it('reads the declared type', () => {
    expect(dataUrlMimeType('data:image/PNG;base64,AAAA')).toBe('image/png')
  })

  it('falls back when no type is declared', () => {
    expect(dataUrlMimeType('data:;base64,AAAA', 'image/png')).toBe('image/png')
  })
})
