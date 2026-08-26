import { describe, expect, it } from 'vitest'
import { collectEmailImageRefs, renderNoteEmailHtml } from './note-email-html'

describe('renderNoteEmailHtml', () => {
  it('states the title and styles headings inline', () => {
    const { html, title } = renderNoteEmailHtml('---\ntitle: Weekly Update\n---\n\nHello.\n', 'file')
    expect(title).toBe('Weekly Update')
    expect(html).toContain('<h1 style="')
    expect(html).toContain('Weekly Update')
  })

  it('styles tables cell by cell, since mail clients drop classes', () => {
    const { html } = renderNoteEmailHtml('| a | b |\n| - | - |\n| 1 | 2 |\n', 'T')
    expect(html).toContain('<table style="border-collapse:collapse')
    expect(html).toContain('<th style="border:1px solid')
    expect(html).toContain('<td style="border:1px solid')
  })

  it('keeps inline code and code fences readable without app CSS', () => {
    const { html } = renderNoteEmailHtml('Use `zn open` here.\n\n```sh\necho hi\n```\n', 'T')
    expect(html).toMatch(/<code style="[^"]*ui-monospace/)
    expect(html).toContain('<pre style="')
  })

  it('degrades an image it has no bytes for to its alt text, and checkboxes to glyphs', () => {
    const { html } = renderNoteEmailHtml('![the chart](a.png)\n\n- [x] done\n- [ ] open\n', 'T')
    expect(html).toContain('<em>[the chart]</em>')
    expect(html).not.toContain('<img')
    expect(html).toContain('☒')
    expect(html).toContain('☐')
    expect(html).not.toContain('<input')
  })

  it('a body with its own H1 is not doubled', () => {
    const { html } = renderNoteEmailHtml('# Already Titled\n\nBody.\n', 'file-name')
    expect(html.match(/<h1/g)).toHaveLength(1)
  })

  // #628: the images the caller could read travel as data: URIs, for both the
  // markdown and the `![[…]]` forms the app itself writes.
  it('embeds supplied images as data URIs, wikilink embeds included, keeping the size hint', () => {
    const images = new Map([
      ['assets/chart.png', 'data:image/png;base64,AAAA'],
      ['chart.png', 'data:image/png;base64,BBBB']
    ])
    const { html } = renderNoteEmailHtml(
      '![Quarterly chart](assets/chart.png "chart.png")\n\n![[chart.png|320]]\n',
      'T',
      { images }
    )
    expect(html).toContain('<img src="data:image/png;base64,AAAA" alt="Quarterly chart" style="max-width:100%')
    expect(html).toContain('<img src="data:image/png;base64,BBBB" alt="" style="max-width:100%;height:auto;display:block;margin:0.6em 0;width:320px"')
    expect(html).not.toContain('![[')
    expect(html).not.toContain('<em>[')
  })

  it('keeps remote images by URL and leaves note embeds as text', () => {
    const { html } = renderNoteEmailHtml('![logo](https://example.com/logo.png)\n\n![[Some note]]\n', 'T')
    expect(html).toContain('<img src="https://example.com/logo.png"')
    expect(html).toContain('![[Some note]]')
  })

  it('lists the local image refs a caller has to read, titles dropped', () => {
    expect(
      collectEmailImageRefs(
        '![a](assets/chart.png "chart.png")\n![b](<my pic.png>)\n![c](https://x/y.png)\n![[chart.png|320]]\n![[Some note]]\n'
      )
    ).toEqual(['assets/chart.png', 'my pic.png', 'chart.png'])
  })
})
