import { describe, expect, it } from 'vitest'
import { printHeadingLook } from './heading-styles'

describe('printHeadingLook', () => {
  it('leaves an export alone when nothing is styled', () => {
    expect(printHeadingLook({}, false)).toEqual([])
    expect(printHeadingLook(undefined, false)).toEqual([])
  })

  it('prints the preset in the print shades while Color headings by level is on', () => {
    const look = printHeadingLook({}, true)
    expect(look).toHaveLength(6)
    expect(look[0]).toEqual({ level: 1, color: 'D1242F' })
    expect(look[3]).toEqual({ level: 4, color: '1B7C83' })
  })

  it('lets a pick for one level win over the preset, hex as Word takes it', () => {
    const look = printHeadingLook({ 'h1.color': '#e06c75', 'h2.font': 'Georgia', 'h3.color': 'accent' }, true)
    expect(look[0]).toEqual({ level: 1, color: 'E06C75' })
    expect(look[1]).toEqual({ level: 2, color: '9A6700', font: 'Georgia' })
    expect(look[2]).toEqual({ level: 3, color: '0969DA' })
  })

  it('prints a font with no color when only the font is picked', () => {
    expect(printHeadingLook({ 'h5.font': 'Inter' }, false)).toEqual([{ level: 5, font: 'Inter' }])
  })
})
