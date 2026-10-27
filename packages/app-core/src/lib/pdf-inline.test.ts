import { describe, expect, it } from 'vitest'
import { canShowPdfInline } from './pdf-inline'

describe('canShowPdfInline', () => {
  it('is false only where the engine says it has no PDF viewer (Android WebView)', () => {
    expect(canShowPdfInline({ pdfViewerEnabled: false })).toBe(false)
  })

  it('is true where the engine has one (desktop Chromium, Safari, Firefox)', () => {
    expect(canShowPdfInline({ pdfViewerEnabled: true })).toBe(true)
  })

  it('keeps the frame on engines too old to answer', () => {
    expect(canShowPdfInline({} as Pick<Navigator, 'pdfViewerEnabled'>)).toBe(true)
    expect(canShowPdfInline(undefined)).toBe(true)
  })
})
