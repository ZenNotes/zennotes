import { describe, expect, it } from 'vitest'
import { parseStandaloneImageLine } from './cm-live-preview'

// #199: Zettlr writes a markdown title after every image path. The title
// must not become part of the href, or the picture turns into an attachment
// chip in edit mode while the preview draws it.
describe('parseStandaloneImageLine', () => {
  it('drops a double-quoted title from the destination', () => {
    expect(
      parseStandaloneImageLine('![Maße im Möbelbau](inbox/99_Bilder/Maße-im-Möbelbau.png "Maße-im-Möbelbau.png")')
    ).toEqual({ alt: 'Maße im Möbelbau', href: 'inbox/99_Bilder/Maße-im-Möbelbau.png' })
  })

  it('drops single-quoted and parenthesised titles too', () => {
    expect(parseStandaloneImageLine("![a](x.png 'title')")).toEqual({ alt: 'a', href: 'x.png' })
    expect(parseStandaloneImageLine('![a](x.png (title))')).toEqual({ alt: 'a', href: 'x.png' })
  })

  it('keeps an angle-bracketed path with spaces, with or without a title', () => {
    expect(parseStandaloneImageLine('![a](<my chart.png>)')).toEqual({ alt: 'a', href: 'my chart.png' })
    expect(parseStandaloneImageLine('![a](<my chart.png> "t")')).toEqual({ alt: 'a', href: 'my chart.png' })
  })

  it('still tolerates a bare path with a space when no title follows', () => {
    expect(parseStandaloneImageLine('![a](my chart.png)')).toEqual({ alt: 'a', href: 'my chart.png' })
  })

  it('leaves relative parents alone (the resolver decides what they mean)', () => {
    expect(parseStandaloneImageLine('![a](../../99_Bilder/x.png "x.png")')).toEqual({
      alt: 'a',
      href: '../../99_Bilder/x.png'
    })
  })

  it('is null for anything that is not a standalone image line', () => {
    expect(parseStandaloneImageLine('text ![a](x.png)')).toBeNull()
    expect(parseStandaloneImageLine('[a](x.png "t")')).toBeNull()
  })
})
