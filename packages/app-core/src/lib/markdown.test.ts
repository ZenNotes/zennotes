// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'
import { setMarkdownMathRenderer } from './markdown-settings'

describe('renderMarkdown', () => {
  it('keeps source newlines soft while preserving explicit hard breaks (#656)', () => {
    const soft = renderMarkdown('Preview should reflow this prose\nwhen the pane changes width.')
    const hard = renderMarkdown('Keep this explicit break.  \nStart a new visual line.')

    expect(soft).not.toContain('<br>')
    expect(hard).toContain('<br>')
  })

  it('hides leading YAML/TOML frontmatter in preview output', () => {
    const yaml = renderMarkdown('---\ntitle: Hidden\ntags: [a, b]\n---\n\n# Visible')
    expect(yaml).toContain('<h1 data-source-line="6">Visible</h1>')
    expect(yaml).not.toContain('title: Hidden')
    expect(yaml).not.toContain('<hr')

    const toml = renderMarkdown('+++\ntitle = "Hidden"\n+++\n\nBody')
    expect(toml).toContain('<p data-source-line="5">Body</p>')
    expect(toml).not.toContain('title =')
  })

  it('hides trailing and standalone block ids from rendered prose (#601)', () => {
    const html = renderMarkdown(
      ['A trailing marker. ^trailing', '', 'A standalone marker names this.', '', '^standalone'].join(
        '\n'
      )
    )

    expect(html).toContain('A trailing marker.')
    expect(html).toContain('A standalone marker names this.')
    expect(html).not.toContain('^trailing')
    expect(html).not.toContain('^standalone')
  })

  it('never deletes prose that merely resembles a block id (#601 review)', () => {
    const html = renderMarkdown('See note ^ref *below* for details\n\n| a |\n| - |\n| 10 ^2 |')
    // The caret is mid-line, so it is prose, and the joining space survives.
    expect(html).toContain('^ref <em>below</em>')
    expect(html).toContain('10 ^2')
  })

  it('strips a genuine anchor on a non-final paragraph line (#601 review)', () => {
    const html = renderMarkdown('first line ^mid\nsecond line')
    expect(html).not.toContain('^mid')
    expect(html).toContain('first line')
    expect(html).toContain('second line')
  })

  it('leaves code-fence and frontmatter carets untouched (#601 review)', () => {
    const html = renderMarkdown('```bash\nkill %1 ^Z2\n```')
    expect(html).toContain('^Z2')
  })

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

  it('#570: an Obsidian image embed honors its |WxH size hint', () => {
    const html = renderMarkdown('![[assets/cognitive_web.jpg|100x50]]')

    expect(html).toContain('<img')
    expect(html).toContain('width="100"')
    expect(html).toContain('height="50"')
    expect(html).toContain('alt=""')
  })

  it('#570: a markdown image honors the alt-pipe size hint and keeps its caption', () => {
    const html = renderMarkdown('![cognitive web|100x50](../../assets/cognitive_web.jpg)')

    expect(html).toContain('width="100"')
    expect(html).toContain('height="50"')
    expect(html).toContain('alt="cognitive web"')
  })

  it('#570: a width-only hint sets no height, and plain alts stay untouched', () => {
    const sized = renderMarkdown('![[assets/pic.png|300]]')
    expect(sized).toContain('width="300"')
    expect(sized).not.toContain('height=')

    const plain = renderMarkdown('![[assets/pic.png|a nice caption]]')
    expect(plain).toContain('alt="a nice caption"')
    expect(plain).not.toContain('width=')
  })

  it('#570: a purely numeric markdown alt stays a caption, not a resize', () => {
    // Only the wikilink form treats a bare number as a size hint; `![2024]`
    // is the author's alt text (a year), and `![|2024]` is the sized form.
    const html = renderMarkdown('![2024](assets/chart.png)')
    expect(html).toContain('alt="2024"')
    expect(html).not.toContain('width=')

    const sized = renderMarkdown('![|2024](assets/chart.png)')
    expect(sized).toContain('width="2024"')
    expect(sized).toContain('alt=""')
  })

  it('#570: a zero dimension is not a hint and keeps the label', () => {
    const html = renderMarkdown('![[assets/pic.png|0x300]]')
    expect(html).toContain('alt="0x300"')
    expect(html).not.toContain('height=')
  })

  it('renders excalidraw embeds as placeholder divs', () => {
    const html = renderMarkdown('![[diagram.excalidraw]]')

    expect(html).toContain('data-excalidraw-embed="diagram.excalidraw"')
    expect(html).toContain('class="excalidraw-embed-host"')
    expect(html).not.toContain('<img')
  })

  it('#463: a generic-file Obsidian embed becomes an image node (→ attachment chip)', () => {
    // `![[file.tldraw]]` flows through the same <img> path as `![](file.tldraw)`
    // so the asset enhancer denotes it as a chip.
    const html = renderMarkdown('![[attachments/diagram.tldraw]]')
    expect(html).toContain('<img')
    expect(html).toContain('src="attachments/diagram.tldraw"')
  })

  it('#463: a PDF Obsidian embed stays a link (keeps its rich embed), not an image', () => {
    const html = renderMarkdown('![[attachments/report.pdf]]')
    expect(html).not.toContain('<img')
    expect(html).toContain('attachments/report.pdf')
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

  it('numbers equation environments in document order', () => {
    const html = renderMarkdown(
      [
        '$$',
        '\\begin{equation}a=b\\end{equation}',
        '$$',
        '',
        '$$',
        '\\begin{equation}c=d\\end{equation}',
        '$$'
      ].join('\n')
    )
    const host = document.createElement('div')
    host.innerHTML = html
    expect(
      Array.from(host.querySelectorAll('.katex-html .tag')).map((node) =>
        node.textContent?.replace(/[\s\u200b]/g, '')
      )
    ).toEqual(['(1)', '(2)'])
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

describe('Typst math renderer', () => {
  // Reset to the default so one test's engine choice can't leak into another
  // (and into the rest of the suite, which asserts KaTeX output).
  afterEach(() => setMarkdownMathRenderer('katex'))

  it('emits SVG placeholders instead of KaTeX when Typst is active', () => {
    setMarkdownMathRenderer('typst')
    const block = renderMarkdown('$$\nx^2 + y^2\n$$')
    expect(block).not.toContain('katex')
    expect(block).toContain('zen-typst-math')
    expect(block).toContain('zen-typst-display')
    expect(block).toContain('data-typst-source="x^2 + y^2"')
    expect(block).toContain('data-typst-display="true"')

    const inline = renderMarkdown('Norm $a^2 + b^2$ inline.')
    expect(inline).not.toContain('katex')
    expect(inline).toContain('zen-typst-math')
    expect(inline).toContain('data-typst-display="false"')
    expect(inline).not.toContain('zen-typst-display')
  })

  it('keeps KaTeX as the default and restores it on switch back', () => {
    // Default: KaTeX, no Typst placeholders.
    expect(renderMarkdown('$$\nx^2\n$$')).toContain('katex')
    expect(renderMarkdown('$$\nx^2\n$$')).not.toContain('zen-typst-math')

    setMarkdownMathRenderer('typst')
    expect(renderMarkdown('$$\nx^2\n$$')).toContain('zen-typst-math')

    setMarkdownMathRenderer('katex')
    const back = renderMarkdown('$$\nx^2\n$$')
    expect(back).toContain('katex')
    expect(back).not.toContain('zen-typst-math')
  })

  it('still leaves currency alone under Typst (shares the parse guards)', () => {
    setMarkdownMathRenderer('typst')
    const html = renderMarkdown('I paid $5 and got $10 back.')
    expect(html).not.toContain('zen-typst-math')
    expect(html).toContain('$5 and got $10 back.')
  })
})

describe('display math inside a table cell (reading view matches the editor)', () => {
  // The reported shape: a worked answer living in a table cell. Mid-line
  // `$$…$$` can never be currency, so the guard must let it through, and the
  // editor's table widget shows it as display math, so the reading view must
  // agree.
  const table = [
    '| # | Ans | Working |',
    '| --- | --- | --- |',
    '| 9 | B | $$\\frac{800}{10000} \\times 100\\% = 8\\%$$ |'
  ].join('\n')

  it('renders $$…$$ in a cell as display math instead of literal source', () => {
    setMarkdownMathRenderer('katex')
    const html = renderMarkdown(table)
    expect(html).toContain('katex')
    expect(html).toContain('katex-display')
    expect(html).not.toContain('$$\\frac')
  })

  it('renders a display placeholder under Typst', () => {
    setMarkdownMathRenderer('typst')
    const html = renderMarkdown(table)
    expect(html).toContain('zen-typst-math')
    expect(html).toContain('zen-typst-display')
    setMarkdownMathRenderer('katex')
  })

  it('still leaves single-dollar currency in cells literal', () => {
    setMarkdownMathRenderer('katex')
    const html = renderMarkdown('| item | price |\n| --- | --- |\n| tea | $5 and $10 |')
    expect(html).not.toContain('katex')
    expect(html).toContain('$5 and $10')
  })
})

describe('non-GFM task states in the reading view (#512)', () => {
  it('renders [/], [-] and [>] as markers instead of literal text', () => {
    const html = renderMarkdown(
      '- [ ] open\n- [x] done\n- [/] started\n- [-] scrapped\n- [>] gone\n'
    )
    // The literal brackets are gone; each state gets a marker span and the
    // `task-list-item` class that lines it up with the real checkboxes.
    expect(html).not.toContain('[/]')
    expect(html).not.toContain('[-]')
    expect(html).not.toContain('[&#x3C;')
    expect(html).toContain('zen-task-state-in-progress')
    expect(html).toContain('zen-task-state-cancelled')
    expect(html).toContain('zen-task-state-forwarded')
    expect(html).toContain('zen-task-in-progress')
    // The task text itself survives.
    for (const text of ['open', 'done', 'started', 'scrapped', 'gone']) {
      expect(html).toContain(text)
    }
  })

  it('chips the metadata on an in-progress task, like a checked one', () => {
    const html = renderMarkdown('- [/] Ship it due:2026-08-04 !high\n')
    expect(html).toContain('zen-task-due')
    expect(html).toContain('data-due="2026-08-04"')
    expect(html).toContain('zen-task-prio-high')
  })

  it('leaves ordinary list items and mid-line brackets alone', () => {
    const html = renderMarkdown('- plain item\n- see [-] in the middle\n- [-]nospace\n')
    expect(html).not.toContain('zen-task-state')
    expect(html).toContain('[-]nospace')
  })

  it('keeps a wikilink on a forwarded task', () => {
    const html = renderMarkdown('- [>] gone [[Target]]\n')
    expect(html).toContain('zen-task-state-forwarded')
    expect(html).toContain('wikilink')
    expect(html).toContain('Target')
  })
})

describe('callout titles keep their inline markup (#549)', () => {
  const titleOf = (html: string): string => {
    const m = html.match(/<div class="callout-title">([\s\S]*?)<\/div>/)
    return m ? m[1] : ''
  }

  it('keeps a link inside the title line, with no orphaned body paragraph', () => {
    const html = renderMarkdown('> [!warning] This is warning [with](https://example.com) that is not multiline')
    const title = titleOf(html)
    expect(title).toContain('This is warning')
    expect(title).toContain('<a')
    expect(title).toContain('that is not multiline')
    // The whole line is the title: nothing left over as a body paragraph.
    expect(html).not.toMatch(/callout-title[\s\S]*?<\/div><p/)
  })

  it('keeps inline math inside the title line', () => {
    const html = renderMarkdown('> [!note] This can also be reproduced with a $3+1=4$ formula inline.')
    const title = titleOf(html)
    expect(title).toContain('katex')
    expect(title).toContain('formula inline.')
  })

  it('splits a multiline callout into title and a compact body without a stray <br>', () => {
    const html = renderMarkdown('> [!note] line 1\n> line 2')
    expect(titleOf(html)).toContain('line 1')
    expect(html).toMatch(/<p[^>]*>line 2<\/p>/)
    // The title/body soft break is a delimiter, not content: a leading <br>
    // in the body paragraph rendered as a phantom empty line.
    expect(html).not.toMatch(/<p[^>]*><br>/)
  })

  it('falls back to the capitalized type when the title line is empty', () => {
    expect(titleOf(renderMarkdown('> [!note]\n> body only'))).toBe('Note')
    expect(titleOf(renderMarkdown('> [!tip]'))).toBe('Tip')
  })

  it('leaves ordinary blockquotes and non-marker text alone', () => {
    expect(renderMarkdown('> just a quote')).not.toContain('callout')
    expect(renderMarkdown('> [!note]x is not a marker')).not.toContain('callout')
  })
})
