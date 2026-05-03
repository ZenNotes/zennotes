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
})
