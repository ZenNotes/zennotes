// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

describe('renderMarkdown', () => {
  it('sanitizes raw HTML and javascript URLs', () => {
    const html = renderMarkdown(
      [
        '<script>alert(1)</script>',
        '<img src="x" onerror="alert(1)">',
        '<a href="javascript:alert(1)">bad</a>'
      ].join('\n')
    )

    expect(html).not.toContain('<script')
    expect(html).not.toContain('onerror=')
    expect(html).not.toContain('javascript:alert(1)')
  })

  it('preserves GFM table column alignment through render + sanitize', () => {
    const html = renderMarkdown(
      ['| L | C | R |', '|:--|:-:|--:|', '| 1 | 2 | 3 |'].join('\n')
    )

    // remark-gfm emits the `align` attribute on aligned cells; the sanitizer
    // must keep it so the CSS attribute selectors can honor the alignment.
    expect(html).toContain('align="center"')
    expect(html).toContain('align="right"')
  })

  it('preserves task checkboxes, wikilink metadata, and diagram placeholders', () => {
    const html = renderMarkdown(
      [
        '- [x] done',
        '',
        '[[Course Map]]',
        '',
        '```mermaid',
        'graph TD; A-->B',
        '```'
      ].join('\n')
    )

    expect(html).toContain('type="checkbox"')
    expect(html).toContain('checked')
    expect(html).toContain('data-wikilink="Course Map"')
    expect(html).toContain('class="mermaid"')
    expect(html).toContain('graph TD; A--&gt;B')
  })

  it('renders Obsidian image embeds as local image nodes', () => {
    const html = renderMarkdown('![[CleanShot 2026-04-13 at 14.31.31@2x.png]]')

    expect(html).toContain('<img')
    expect(html).toContain('src="CleanShot%202026-04-13%20at%2014.31.31@2x.png"')
    expect(html).toContain('alt="CleanShot 2026-04-13 at 14.31.31@2x.png"')
  })

  it('renders ==text== as <mark> (and survives the sanitizer)', () => {
    expect(renderMarkdown('==highlighted==')).toContain('<mark>highlighted</mark>')
    const two = renderMarkdown('==a== and ==b==')
    expect(two).toContain('<mark>a</mark>')
    expect(two).toContain('<mark>b</mark>')
    // Unicode content (the #218 examples).
    expect(renderMarkdown('Научное применение ==Fortran==')).toContain('<mark>Fortran</mark>')
    expect(renderMarkdown('==важно==')).toContain('<mark>важно</mark>')
  })

  it('does not treat spaced == or code-span == as a highlight', () => {
    expect(renderMarkdown('x == y == z')).not.toContain('<mark>')
    expect(renderMarkdown('`==nothighlight==`')).not.toContain('<mark>')
  })

  it('keeps colored <mark class="hl-..."> highlights through the sanitizer', () => {
    const html = renderMarkdown('<mark class="hl-green">green</mark>')
    expect(html).toContain('<mark')
    expect(html).toContain('class="hl-green"')
    expect(html).toContain('green')
  })
})
