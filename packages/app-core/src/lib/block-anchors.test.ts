import { describe, expect, it } from 'vitest'
import { extractBlock, findBlockAnchor, parseBlockAnchors } from './block-anchors'

const body = [
  '---',
  'title: Daily Note',
  'alias: ^frontmatter-id',
  '---',
  '',
  '# Daily Note',
  '',
  '## Notes',
  '',
  '- First note',
  '- Second note ^note-two',
  '- Third note',
  '',
  'A standalone marker follows this paragraph.',
  '',
  '^standalone',
  '',
  '```md',
  '- Fenced example ^not-an-anchor',
  '```',
  '',
  'Math stays prose: 2^3 and x ^ y are not ids.',
  ''
].join('\n')

describe('parseBlockAnchors (#601)', () => {
  it('finds a trailing ^id and a marker on its own line, in document order', () => {
    expect(parseBlockAnchors(body).map((a) => a.id)).toEqual(['note-two', 'standalone'])
  })

  it('ignores ids inside frontmatter and fenced code', () => {
    const ids = parseBlockAnchors(body).map((a) => a.id)
    expect(ids).not.toContain('frontmatter-id')
    expect(ids).not.toContain('not-an-anchor')
  })

  it('does not treat a caret operator as an id', () => {
    expect(parseBlockAnchors('Exponent 2^3\n').map((a) => a.id)).toEqual([])
    expect(parseBlockAnchors('Spaced x ^ y\n').map((a) => a.id)).toEqual([])
  })

  it('only accepts a marker that ends its line', () => {
    expect(parseBlockAnchors('- Note ^mid-line and more text\n').map((a) => a.id)).toEqual([])
    expect(parseBlockAnchors('- Note ^trailing   \n').map((a) => a.id)).toEqual(['trailing'])
  })

  it('points from at the start of the marked line and brackets the marker itself', () => {
    const anchor = parseBlockAnchors(body).find((a) => a.id === 'note-two')
    expect(anchor).toBeDefined()
    expect(body.slice(anchor!.from).startsWith('- Second note ^note-two')).toBe(true)
    expect(body.slice(anchor!.markerFrom, anchor!.markerTo)).toBe('^note-two')
    expect(body.split('\n')[anchor!.line - 1]).toBe('- Second note ^note-two')
  })

  it('points a standalone marker at the paragraph it names while retaining marker coordinates', () => {
    const anchor = parseBlockAnchors(body).find((a) => a.id === 'standalone')
    expect(anchor).toBeDefined()
    expect(anchor!.line).toBe(14)
    expect(body.slice(anchor!.from)).toMatch(/^A standalone marker follows this paragraph\./)
    expect(anchor!.markerLine).toBe(16)
    expect(body.slice(anchor!.markerFrom, anchor!.markerTo)).toBe('^standalone')
  })
})

describe('findBlockAnchor (#601)', () => {
  it('resolves an id to its block', () => {
    expect(findBlockAnchor(body, 'note-two')?.line).toBe(11)
  })

  it('matches case-insensitively and tolerates a leading caret', () => {
    expect(findBlockAnchor(body, 'NOTE-TWO')?.id).toBe('note-two')
    expect(findBlockAnchor(body, '^note-two')?.id).toBe('note-two')
  })

  it('returns null for an unknown or empty id', () => {
    expect(findBlockAnchor(body, 'nope')).toBeNull()
    expect(findBlockAnchor(body, '   ')).toBeNull()
  })

  it('resolves a repeated id to the first occurrence', () => {
    const repeated = '- One ^dup\n- Two ^dup\n'
    expect(findBlockAnchor(repeated, 'dup')?.line).toBe(1)
  })
})

describe('extractBlock (#601)', () => {
  it('takes the list item, without the marker', () => {
    expect(extractBlock(body, 'note-two')).toBe('- Second note')
  })

  it('brings the item children along', () => {
    const nested = ['- Parent ^parent', '  - Child one', '  - Child two', '- Sibling', ''].join('\n')
    expect(extractBlock(nested, 'parent')).toBe('- Parent\n  - Child one\n  - Child two')
  })

  it('takes the whole paragraph for a marker on an ordinary line', () => {
    const prose = ['First line of the paragraph', 'and its second line. ^para', '', 'Elsewhere.'].join('\n')
    expect(extractBlock(prose, 'para')).toBe('First line of the paragraph\nand its second line.')
  })

  it('takes the paragraph above a marker sitting on its own line', () => {
    const standalone = ['Intro.', '', 'The block being tagged.', '', '^standalone', '', 'After.'].join('\n')
    expect(extractBlock(standalone, 'standalone')).toBe('The block being tagged.')
  })

  it('is null for an id the note does not carry', () => {
    expect(extractBlock(body, 'nope')).toBeNull()
  })
})
