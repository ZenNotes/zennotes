// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  applyHeadingStyles,
  headingColorCss,
  headingColorLabel,
  normalizeHeadingStyles,
  parseHeadingColor,
  parseHeadingFont,
  withHeadingStyle
} from './heading-styles'

describe('parseHeadingColor', () => {
  it('reads a swatch by name, in any case, with the other spellings', () => {
    expect(parseHeadingColor('Red')).toBe('red')
    expect(parseHeadingColor(' aqua ')).toBe('teal')
    expect(parseHeadingColor('grey')).toBe('gray')
    expect(parseHeadingColor('accent')).toBe('accent')
  })

  it('reads a hex color as six lower-case digits', () => {
    expect(parseHeadingColor('#E06C75')).toBe('#e06c75')
    expect(parseHeadingColor('#e6c')).toBe('#ee66cc')
  })

  it('refuses anything else', () => {
    expect(parseHeadingColor('')).toBeNull()
    expect(parseHeadingColor('orange')).toBeNull()
    expect(parseHeadingColor('#12345')).toBeNull()
    expect(parseHeadingColor('red; background: url(x)')).toBeNull()
    expect(parseHeadingColor(3)).toBeNull()
  })
})

describe('parseHeadingFont', () => {
  it('drops quotes and backslashes so the name stays one CSS string', () => {
    expect(parseHeadingFont('  Georgia ')).toBe('Georgia')
    expect(parseHeadingFont('Evil", serif; color: red')).toBe('Evil, serif; color: red')
    expect(parseHeadingFont('   ')).toBeNull()
  })
})

describe('normalizeHeadingStyles', () => {
  it('keeps the known keys with usable values and drops the rest', () => {
    expect(
      normalizeHeadingStyles({
        'h1.color': 'Red',
        'h2.color': 'orange',
        'h3.font': 'Georgia',
        'h7.color': 'blue',
        theme: 'x'
      })
    ).toEqual({ 'h1.color': 'red', 'h3.font': 'Georgia' })
    expect(normalizeHeadingStyles({ h2: { color: 'blue', font: 'Inter' } })).toEqual({
      'h2.color': 'blue',
      'h2.font': 'Inter'
    })
    expect(normalizeHeadingStyles(null)).toEqual({})
    expect(normalizeHeadingStyles(['h1.color'])).toEqual({})
  })
})

describe('withHeadingStyle', () => {
  it('sets one entry and removes it again with null', () => {
    const set = withHeadingStyle({}, 2, 'color', '#E5C07B')
    expect(set).toEqual({ 'h2.color': '#e5c07b' })
    expect(withHeadingStyle(set, 2, 'color', null)).toEqual({})
  })
})

describe('headingColorCss and headingColorLabel', () => {
  it('reads a swatch from the theme, with the text color behind it', () => {
    expect(headingColorCss('teal')).toBe('rgb(var(--z-aqua, var(--z-fg)))')
    expect(headingColorCss('#e06c75')).toBe('#e06c75')
    expect(headingColorLabel('teal')).toBe('Teal')
    expect(headingColorLabel('#e06c75')).toBe('#e06c75')
    expect(headingColorLabel(undefined)).toBe('Default')
  })
})

describe('applyHeadingStyles', () => {
  it('sets a variable and an attribute per styled level, and clears them', () => {
    const root = document.createElement('html')
    applyHeadingStyles(root, { 'h1.color': 'red', 'h3.font': 'Georgia' })
    expect(root.style.getPropertyValue('--z-heading-1-color')).toBe('rgb(var(--z-red, var(--z-fg)))')
    expect(root.hasAttribute('data-heading-1-color')).toBe(true)
    expect(root.style.getPropertyValue('--z-heading-3-font')).toContain('"Georgia"')
    expect(root.hasAttribute('data-heading-3-font')).toBe(true)
    expect(root.hasAttribute('data-heading-2-color')).toBe(false)

    applyHeadingStyles(root, {})
    expect(root.hasAttribute('data-heading-1-color')).toBe(false)
    expect(root.style.getPropertyValue('--z-heading-1-color')).toBe('')
    expect(root.hasAttribute('data-heading-3-font')).toBe(false)
  })
})
