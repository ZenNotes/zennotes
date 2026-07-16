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

  it('stamps top-level blocks with data-source-line for split-view scroll sync', () => {
    // Lines: 1 `# Heading`, 3 `First para.`, 5 `- a`, 8 `Last para.`
    const html = renderMarkdown('# Heading\n\nFirst para.\n\n- a\n- b\n\nLast para.')
    expect(html).toContain('data-source-line="1"')
    expect(html).toContain('data-source-line="3"')
    expect(html).toContain('data-source-line="5"')
    expect(html).toContain('data-source-line="8"')
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

  it('renders excalidraw embeds as placeholder divs', () => {
    const html = renderMarkdown('![[diagram.excalidraw]]')

    expect(html).toContain('data-excalidraw-embed="diagram.excalidraw"')
    expect(html).toContain('class="excalidraw-embed-host"')
    expect(html).not.toContain('<img')
  })

  it('parses size hints on excalidraw embeds', () => {
    const html = renderMarkdown('![[diagram.excalidraw|600x400]]')

    expect(html).toContain('data-excalidraw-embed="diagram.excalidraw"')
    expect(html).toContain('data-embed-width="600"')
    expect(html).toContain('data-embed-height="400"')
  })

  it('renders excalidraw embeds without size hint when label is the target', () => {
    const html = renderMarkdown('![[diagram.excalidraw]]')

    expect(html).not.toContain('data-embed-width')
    expect(html).not.toContain('data-embed-height')
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

describe('table column widths (#294)', () => {
  it('renders a <colgroup> from a trailing zen:cols comment', () => {
    const html = renderMarkdown('| A | B |\n| --- | --- |\n| 1 | 2 |\n<!-- zen:cols=120,200 -->\n')
    expect(html).toContain('<colgroup>')
    expect(html).toContain('width:120px')
    expect(html).toContain('zen-has-col-widths')
  })
  it('leaves a plain table (no marker) untouched', () => {
    const html = renderMarkdown('| A | B |\n| --- | --- |\n| 1 | 2 |\n')
    expect(html).not.toContain('colgroup')
    expect(html).not.toContain('zen-has-col-widths')
  })
})

describe('math with raw pipes inside tables (#319)', () => {
  const cell = (formula: string): string =>
    renderMarkdown(`| Formula | Note |\n| --- | --- |\n| ${formula} | x |\n`)

  it('renders raw unescaped pipes in table math', () => {
    // conditional probability, set-builder, absolute value
    expect(cell('$P(A|B)$')).toContain('katex')
    expect(cell('$\\{x | x > 0\\}$')).toContain('katex')
    expect(cell('$|x|$')).toContain('katex')
  })

  it('still keeps simple and escaped-pipe table math working', () => {
    expect(cell('$\\sum_{i=1}^n i$')).toContain('katex')
    expect(cell('$P(A\\|B)$')).toContain('katex')
  })

  it('does not false-escape a currency row (leaves the cells split)', () => {
    const html = renderMarkdown('| Item | Price |\n| --- | --- |\n| Widget $5 | $10 |\n')
    expect(html).toMatch(/<td>\s*Widget \$5\s*<\/td>/)
    expect(html).toMatch(/<td>\s*\$10\s*<\/td>/)
    expect(html).not.toContain('katex')
  })

  it('does not touch math with a pipe OUTSIDE a table', () => {
    const html = renderMarkdown('Norm is $|x|$ inline.')
    expect(html).toContain('katex')
    expect(html).not.toContain('\\|')
  })
})

describe('currency vs inline math (reading view matches the editor)', () => {
  it('leaves a currency line literal instead of rendering it as math', () => {
    const html = renderMarkdown('I paid $5 and got $10 back.')
    expect(html).not.toContain('katex')
    expect(html).toContain('$5 and got $10 back.')
  })

  it('handles several currency amounts on one line', () => {
    const html = renderMarkdown('Prices: $5, $10, and $20 total.')
    expect(html).not.toContain('katex')
    expect(html).toContain('$5,')
    expect(html).toContain('$20 total.')
  })

  it('reverts a padded span the editor would reject ($ x $)', () => {
    // Leading/trailing space just inside the `$` means it is not math to the
    // editor; remark-math strips the padding and would render it, so guard it.
    const html = renderMarkdown('Range $ 5 $ here.')
    expect(html).not.toContain('katex')
    expect(html).toContain('$ 5 $')
  })

  it('still renders genuine inline math', () => {
    expect(renderMarkdown('Euler: $e^{i\\pi}+1=0$ is elegant.')).toContain('katex')
    expect(renderMarkdown('Norm $|x|$ and sum $\\sum_{i=1}^n i$.')).toContain('katex')
  })

  it('keeps inline math sitting next to a lone currency amount', () => {
    // `$x$` is math; the trailing `$5.` has no closing `$`, so it stays text.
    const html = renderMarkdown('The value $x$ costs $5.')
    expect(html).toContain('katex')
    expect(html).toContain('$5.')
  })

  it('still renders block math', () => {
    expect(renderMarkdown('$$\n\\int_0^1 x\\,dx\n$$')).toContain('katex')
  })
})

describe('block math fence normalization (#399, reading view matches the editor)', () => {
  const text = (html: string): string =>
    html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

  it('closes a block whose $$ trails the last content line', () => {
    const html = renderMarkdown('$$\n\\frac{a}{b} = c\nx + y = z$$\n\nAfter paragraph.')
    expect(html).toContain('katex-display')
    expect(text(html)).toContain('After paragraph.')
    expect(text(html)).not.toContain('$$')
  })

  it('accepts content right after the opening $$', () => {
    const html = renderMarkdown('$$\\frac{a}{b} = c\nx = y\n$$\n\nAfter paragraph.')
    expect(html).toContain('katex-display')
    expect(text(html)).toContain('After paragraph.')
    expect(text(html)).not.toContain('$$')
  })

  it('renders a single-line $$x^2$$ as a display block, like the editor', () => {
    const html = renderMarkdown('$$x^2$$\n\nAfter paragraph.')
    expect(html).toContain('katex-display')
    expect(text(html)).toContain('After paragraph.')
  })

  it('leaves canonical fenced blocks byte-identical', () => {
    const canonical = '$$\n\\int_0^1 x\\,dx\n$$\n\nAfter paragraph.'
    const html = renderMarkdown(canonical)
    expect(html).toContain('katex-display')
    expect(text(html)).toContain('After paragraph.')
  })

  it('does not touch $$ inside fenced code', () => {
    const html = renderMarkdown('```\n$$\nx + y = z$$\n```\n\nAfter paragraph.')
    expect(html).not.toContain('katex')
    // rehype-highlight may tokenize the code content; compare tag-stripped text.
    expect(text(html)).toContain('z$$')
    expect(text(html)).toContain('After paragraph.')
  })

  it('passes editor-rejected shapes through unchanged', () => {
    // Mid-line `$$` and empty blocks are not editor-legal blocks; the
    // normalizer must not invent fences for them.
    expect(renderMarkdown('$$a$$b$$')).not.toContain('katex-display')
    expect(renderMarkdown('$$ $$')).not.toContain('katex-display')
    expect(() => renderMarkdown('$$\nunclosed to the end')).not.toThrow()
  })
})
