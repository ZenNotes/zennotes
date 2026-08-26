import { describe, expect, it } from 'vitest'
import {
  isImageEmbedTarget,
  parseEmbedSizeHint,
  rewriteWikilinkImageEmbeds,
  splitEmbedLabel
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
