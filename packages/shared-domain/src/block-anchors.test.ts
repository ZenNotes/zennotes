import { describe, expect, it } from 'vitest'
import {
  extractBlock,
  findBlockAnchor,
  parseBlockAnchors,
  stripBlockAnchorMarkers
} from './block-anchors'

describe('stripBlockAnchorMarkers (#601 review)', () => {
  it('leaves mid-line carets alone: only what the parser accepts is stripped', () => {
    const src = 'See note ^ref *below* for details'
    expect(stripBlockAnchorMarkers(src)).toBe(src)
    expect(stripBlockAnchorMarkers('| 10 ^2 |')).toBe('| 10 ^2 |')
    expect(stripBlockAnchorMarkers('x ^ y')).toBe('x ^ y')
  })

  it('strips a genuine anchor even on a non-final paragraph line', () => {
    expect(stripBlockAnchorMarkers('first line ^mid\nsecond line')).toBe(
      'first line\nsecond line'
    )
  })

  it('never touches code fences or frontmatter', () => {
    const code = '```bash\nkill %1 ^Z2\n```'
    expect(stripBlockAnchorMarkers(code)).toBe(code)
    const fm = '---\nalias: ^my-alias\n---\nbody text'
    expect(stripBlockAnchorMarkers(fm)).toBe(fm)
  })

  it('blanks a standalone marker line without changing the line count', () => {
    const src = 'A paragraph.\n\n^tag\n\nNext.'
    const out = stripBlockAnchorMarkers(src)
    expect(out.split('\n').length).toBe(src.split('\n').length)
    expect(out).toBe('A paragraph.\n\n\n\nNext.')
  })
})

describe('standalone markers respect frontmatter and fences (#601 review)', () => {
  it('a marker directly after frontmatter does not anchor the YAML', () => {
    const body = '---\ntitle: X\n---\n^intro\n\nReal content.'
    const anchor = parseBlockAnchors(body)[0]
    expect(anchor.id).toBe('intro')
    // Nothing markdown-owned sits above, so the anchor stays on its own line.
    expect(anchor.line).toBe(4)
    expect(extractBlock(body, 'intro')).toBeNull()
  })

  it('a marker after a fenced block tags the whole fence, markers included', () => {
    const body = 'Intro.\n\n```js\nconst a = 1\n```\n^snippet'
    const anchor = findBlockAnchor(body, 'snippet')
    expect(anchor?.line).toBe(3)
    expect(extractBlock(body, 'snippet')).toBe('```js\nconst a = 1\n```')
  })
})

describe('extractBlock walks (#601 review)', () => {
  it('carries loose children and whole fences under a marked list item', () => {
    const body = [
      '- Parent ^id',
      '    ```txt',
      '    inside',
      '',
      '    still inside',
      '    ```',
      '',
      '    loose child paragraph',
      '- Sibling'
    ].join('\n')
    expect(extractBlock(body, 'id')).toBe(
      [
        '- Parent',
        '    ```txt',
        '    inside',
        '',
        '    still inside',
        '    ```',
        '',
        '    loose child paragraph'
      ].join('\n')
    )
  })

  it('stops a paragraph at a fence boundary instead of climbing into it', () => {
    const body = '```\ncode line\n```\ntext ^id'
    expect(extractBlock(body, 'id')).toBe('text')
  })
})
