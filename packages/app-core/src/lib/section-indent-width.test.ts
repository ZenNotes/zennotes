// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SECTION_INDENT_WIDTH,
  applySectionIndent,
  normalizeSectionIndentWidth
} from './section-indent-width'

describe('normalizeSectionIndentWidth', () => {
  it('keeps a whole number of spaces from 1 through 8', () => {
    expect(normalizeSectionIndentWidth(2)).toBe(2)
    expect(normalizeSectionIndentWidth('6')).toBe(6)
    expect(normalizeSectionIndentWidth(4.4)).toBe(4)
    expect(normalizeSectionIndentWidth(0)).toBe(1)
    expect(normalizeSectionIndentWidth(40)).toBe(8)
  })

  it('falls back to the default for a missing or broken value', () => {
    expect(normalizeSectionIndentWidth(undefined)).toBe(DEFAULT_SECTION_INDENT_WIDTH)
    expect(normalizeSectionIndentWidth('')).toBe(DEFAULT_SECTION_INDENT_WIDTH)
    expect(normalizeSectionIndentWidth('wide')).toBe(DEFAULT_SECTION_INDENT_WIDTH)
    expect(normalizeSectionIndentWidth(Number.NaN)).toBe(DEFAULT_SECTION_INDENT_WIDTH)
  })
})

describe('applySectionIndent', () => {
  it('sets the switch and the width on the root together', () => {
    const root = document.createElement('div')
    applySectionIndent(root, true, 6)
    expect(root.hasAttribute('data-indent-sections')).toBe(true)
    expect(root.style.getPropertyValue('--z-section-indent-width')).toBe('6')
    applySectionIndent(root, false, 99)
    expect(root.hasAttribute('data-indent-sections')).toBe(false)
    expect(root.style.getPropertyValue('--z-section-indent-width')).toBe('8')
  })
})
