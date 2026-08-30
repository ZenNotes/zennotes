import { describe, expect, it } from 'vitest'
import {
  isImageEmbedTarget,
  parseEmbedSizeHint,
  rewriteWikilinkImageEmbeds,
  readEmbedWidth,
  splitEmbedLabel,
  withEmbedWidth
} from './embed-size'

describe('parseEmbedSizeHint', () => {
  it('reads width and width x height', () => {
    expect(parseEmbedSizeHint('600')).toEqual({ width: 600, height: undefined })
    expect(parseEmbedSizeHint('600x400')).toEqual({ width: 600, height: 400 })
  })
  it('rejects captions and zero sizes', () => {
    expect(parseEmbedSizeHint('caption')).toBeNull()
    expect(parseEmbedSizeHint('0')).toBeNull()
    expect(parseEmbedSizeHint('0x300')).toBeNull()
  })
})

describe('splitEmbedLabel', () => {
  it('takes a whole-label size only for wikilinks', () => {
    expect(splitEmbedLabel('600', 'wikilink')).toEqual({ alt: '', size: { width: 600, height: undefined } })
    expect(splitEmbedLabel('2024', 'markdown')).toEqual({ alt: '2024', size: null })
  })
  it('splits a trailing size from a caption with pipes', () => {
    expect(splitEmbedLabel('a|b|300x200', 'markdown')).toEqual({ alt: 'a|b', size: { width: 300, height: 200 } })
  })
})

describe('rewriteWikilinkImageEmbeds', () => {
  it('turns image embeds into standard markdown and keeps the size in the alt', () => {
    expect(rewriteWikilinkImageEmbeds('![[chart.png]]')).toBe('![](chart.png)')
    expect(rewriteWikilinkImageEmbeds('![[chart.png|320]]')).toBe('![|320](chart.png)')
    expect(rewriteWikilinkImageEmbeds('![[chart.png|Quarter|600x400]]')).toBe('![Quarter|600x400](chart.png)')
    expect(rewriteWikilinkImageEmbeds('![[assets/my chart.png]]')).toBe('![](<assets/my chart.png>)')
  })
  it('leaves note embeds and fenced code alone', () => {
    const doc = '![[Some note]]\n\n```md\n![[chart.png]]\n```\n\n![[chart.png]]'
    expect(rewriteWikilinkImageEmbeds(doc)).toBe('![[Some note]]\n\n```md\n![[chart.png]]\n```\n\n![](chart.png)')
  })
  it('knows what counts as an image', () => {
    expect(isImageEmbedTarget('a.PNG')).toBe(true)
    expect(isImageEmbedTarget('deck.pdf')).toBe(false)
    expect(isImageEmbedTarget('note')).toBe(false)
  })
})

describe('readEmbedWidth', () => {
  it('reads the hint width from either form', () => {
    expect(readEmbedWidth('![[pic.png|Team photo|300]]')).toBe(300)
    expect(readEmbedWidth('![[pic.png|600x400]]')).toBe(600)
    expect(readEmbedWidth('![chart|480](assets/chart.png "t")')).toBe(480)
    expect(readEmbedWidth('![[pic.png]]')).toBeNull()
    expect(readEmbedWidth('![2024](chart.png)')).toBeNull()
    expect(readEmbedWidth('![[Some note|300]]')).toBeNull()
  })
})

describe('withEmbedWidth', () => {
  it('adds, replaces, and strips the hint on a wikilink embed', () => {
    expect(withEmbedWidth('![[pic.png]]', 480)).toBe('![[pic.png|480]]')
    expect(withEmbedWidth('![[pic.png|300]]', 480)).toBe('![[pic.png|480]]')
    expect(withEmbedWidth('![[pic.png|480]]', null)).toBe('![[pic.png]]')
  })
  it('keeps the caption and drops an explicit height', () => {
    expect(withEmbedWidth('![[pic.png|Team photo|300]]', 480)).toBe('![[pic.png|Team photo|480]]')
    expect(withEmbedWidth('![[pic.png|600x400]]', 480)).toBe('![[pic.png|480]]')
    expect(withEmbedWidth('![[pic.png|Team photo|480]]', null)).toBe('![[pic.png|Team photo]]')
  })
  it('rewrites the alt of a markdown image and copies the target and title verbatim', () => {
    expect(withEmbedWidth('![chart](assets/chart.png "chart.png")', 480)).toBe(
      '![chart|480](assets/chart.png "chart.png")'
    )
    expect(withEmbedWidth('![chart|300](<my chart.png>)', 480)).toBe('![chart|480](<my chart.png>)')
    // A bare number in markdown alt is a caption, so the size keeps its pipe.
    expect(withEmbedWidth('![](pic.png)', 320)).toBe('![|320](pic.png)')
    expect(withEmbedWidth('![2024](chart.png)', 320)).toBe('![2024|320](chart.png)')
    expect(withEmbedWidth('![|320](pic.png)', null)).toBe('![](pic.png)')
  })
  it('preserves indentation and trailing whitespace', () => {
    expect(withEmbedWidth('  ![[pic.png]]  ', 200)).toBe('  ![[pic.png|200]]  ')
  })
  it('refuses non-image lines and bad widths', () => {
    expect(withEmbedWidth('![[Some note]]', 480)).toBeNull()
    expect(withEmbedWidth('Text with ![[pic.png]] inline', 480)).toBeNull()
    expect(withEmbedWidth('![[pic.png]]', 0)).toBeNull()
    expect(withEmbedWidth('![[pic.png]]', 12.5)).toBeNull()
  })
})
