import { describe, expect, it } from 'vitest'
import { quickLookCover } from './cover'

const shown = { noteCoverPlacement: 'scroll' } as const

describe('quickLookCover', () => {
  it('draws a cover the extension already found as an embed, at its focal point', () => {
    const payload = {
      markdown: '---\nbanner: "![[assets/lisbon.jpg]]"\nbanner_y: 0.3\n---\n# Lisbon\n',
      assets: { 'assets/lisbon.jpg': 'zenql://app/asset/0/lisbon.jpg' }
    }
    expect(quickLookCover(payload, shown)).toEqual({ url: 'zenql://app/asset/0/lisbon.jpg', y: 0.3 })
  })

  it('asks the extension for any other form of cover by its decoded reference', () => {
    expect(quickLookCover({ markdown: '---\nbanner: "[[pics/a b.png]]"\n---\n', assets: {} }, shown)).toEqual({
      url: 'zenql://app/cover/pics%2Fa%20b.png',
      y: 0.5
    })
    expect(quickLookCover({ markdown: '---\ncover: "![x](pics/a%20b.png)"\n---\n', assets: {} }, shown)?.url).toBe(
      'zenql://app/cover/pics%2Fa%20b.png'
    )
  })

  it('leaves out a cover from the web, the hidden setting, and a note without one', () => {
    expect(quickLookCover({ markdown: '---\nbanner: https://example.com/a.jpg\n---\n', assets: {} }, shown)).toBeNull()
    const payload = {
      markdown: '---\nbanner: "![[a.png]]"\n---\n',
      assets: { 'a.png': 'zenql://app/asset/0/a.png' }
    }
    expect(quickLookCover(payload, { noteCoverPlacement: 'hidden' })).toBeNull()
    expect(quickLookCover({ markdown: '# Plain note\n\n![[a.png]]\n', assets: payload.assets }, shown)).toBeNull()
  })
})
