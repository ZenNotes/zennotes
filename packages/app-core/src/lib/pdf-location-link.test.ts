import { describe, expect, it } from 'vitest'
import { hrefFragment } from './local-assets'
import { resolveAssetPathAmong } from './asset-path-resolution'
import { pdfFlashTargetFromFragment, pdfLocationFragment, pdfLocationMarkdownLink } from './pdf-location-link'

describe('pdfLocationMarkdownLink (#1085)', () => {
  const location = { page: 3, zoom: 120, left: 0, top: 410 }

  it('links the vault PDF at the page, zoom and spot', () => {
    expect(pdfLocationFragment(location)).toBe('#page=3&zoom=120,0,410')
    expect(pdfLocationMarkdownLink('assets/papers/paper.pdf', location)).toBe(
      '[paper.pdf, p. 3](assets/papers/paper.pdf#page=3&zoom=120,0,410)'
    )
  })

  it('falls back to a plain link when the spot is unknown', () => {
    expect(pdfLocationMarkdownLink('assets/paper.pdf', null)).toBe('[paper.pdf](assets/paper.pdf)')
  })

  it('keeps a file name with spaces, parens or brackets a valid link that still resolves', () => {
    const path = 'assets/My Paper (draft) [v2].pdf'
    const link = pdfLocationMarkdownLink(path, location)
    expect(link).toBe(
      '[My Paper (draft) \\[v2\\].pdf, p. 3](assets/My%20Paper%20%28draft%29%20%5Bv2%5D.pdf#page=3&zoom=120,0,410)'
    )
    const href = link.slice(link.indexOf('](') + 2, -1)
    expect(hrefFragment(href)).toBe('#page=3&zoom=120,0,410')
    // Pasted into a note in another folder, the link still reaches the file.
    expect(resolveAssetPathAmong([{ path }], 'Projects/Reading/notes.md', href)).toBe(path)
  })
})

describe('pdfFlashTargetFromFragment (#1085)', () => {
  it('reads the page and how far down it a link points', () => {
    expect(pdfFlashTargetFromFragment('#page=4&zoom=150,0,333')).toEqual({ page: 4, top: 333 })
    expect(pdfFlashTargetFromFragment('#page=3&zoom=150')).toEqual({ page: 3, top: 0 })
    expect(pdfFlashTargetFromFragment('#page=2')).toEqual({ page: 2, top: 0 })
  })

  it('has nothing to mark without a page', () => {
    expect(pdfFlashTargetFromFragment('#search=theorem')).toBeNull()
    expect(pdfFlashTargetFromFragment('#zoom=150')).toBeNull()
    expect(pdfFlashTargetFromFragment('')).toBeNull()
    expect(pdfFlashTargetFromFragment(null)).toBeNull()
  })
})
