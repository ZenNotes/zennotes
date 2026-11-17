import { describe, expect, it } from 'vitest'
import { normalizePdfExportFontSize, pdfExportFontSizePx } from './app-config'

// #1078: a PDF export can print at its own text size instead of the editor's.
describe('PDF export font size', () => {
  it('keeps 0, which means the editor size, and anything unreadable becomes 0', () => {
    expect(normalizePdfExportFontSize(0)).toBe(0)
    expect(normalizePdfExportFontSize(undefined)).toBe(0)
    expect(normalizePdfExportFontSize('12')).toBe(0)
    expect(normalizePdfExportFontSize(-4)).toBe(0)
    expect(normalizePdfExportFontSize(Number.NaN)).toBe(0)
  })

  it('rounds a size and holds it inside 8 to 32 px', () => {
    expect(normalizePdfExportFontSize(12.4)).toBe(12)
    expect(normalizePdfExportFontSize(3)).toBe(8)
    expect(normalizePdfExportFontSize(90)).toBe(32)
  })

  it('prints at its own size when set, else at the editor size', () => {
    expect(pdfExportFontSizePx(0, 18)).toBe(18)
    expect(pdfExportFontSizePx(11, 18)).toBe(11)
    expect(pdfExportFontSizePx('junk', 18)).toBe(18)
  })
})
