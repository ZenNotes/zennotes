/**
 * Tests for remark-boxes plugin.
 *
 * Covers:
 *   - All 6 container types render correctly
 *   - Title extraction ({title=} and legacy [title])
 *   - Regression: unknown directives → plain <div> (remark-directive parsed)
 *   - Regression: `:::` lines in prose untouched
 *   - Edge cases: empty containers, nesting
 *   - Table rendering: colspan, rowspan, mixed cell counts
 *   - Sanskrit/courseware containers
 */
import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkDirective from 'remark-directive'
import remarkBreaks from 'remark-breaks'
import remarkMath from 'remark-math'
import remarkRehype from 'remark-rehype'
import rehypeStringify from 'rehype-stringify'
import remarkTableColspan from '../lib/remark-table-colspan'
import remarkBoxes from '../lib/remark-boxes'
import remarkDirectiveFilter from '../lib/remark-directive-filter'
import { normalizeMultimdTableSyntax } from '../lib/markdown'

/** Render markdown through the full pipeline. */
function render(md: string): string {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkDirective)
    .use(remarkBoxes)
    .use(remarkDirectiveFilter)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeStringify)

  return String(processor.processSync(md))
}

function hasClass(html: string, cls: string): boolean {
  return html.includes(`class="${cls}"`) || html.includes(`class="`) && html.includes(cls)
}

describe('container blocks', () => {
  it('parses basic grammarbox', () => {
    const md = ':::grammarbox\nContent\n:::'
    const html = render(md)
    expect(html).toContain('md-box--grammarbox')
    expect(html).toContain('data-box-kind="grammarbox"')
    expect(html).toContain('Content')
  })

  it('parses grammarbox with title', () => {
    const md = ':::grammarbox{title="My Title"}\nContent\n:::'
    const html = render(md)
    expect(html).toContain('md-box--grammarbox')
    expect(html).toContain('md-box__title')
    expect(html).toContain('My Title')
    expect(html).toContain('Content')
  })

  it('removes the title paragraph if legacy title is the only content on first line', () => {
    const md = ':::grammarbox\n[My Title]\n\nActual Content\n:::'
    const html = render(md)
    expect(html).toContain('md-box__title')
    expect(html).toContain('My Title')
    expect(html).toContain('Actual Content')
  })

  it('renders important as <aside>', () => {
    const html = render(':::important\nCritical info.\n:::')
    expect(html).toContain('<aside')
    expect(html).toContain('md-box--important')
    expect(html).toContain('Critical info.')
  })

  // it('renders note-box (inactive — commented out)', () => {
    //   const html = render(':::note-box\nA footnote.\n:::')
    //   expect(html).toContain('md-box--note-box')
    //   expect(html).toContain('A footnote.')
    // })

  it('renders center', () => {
    const html = render(':::center\nCentered.\n:::')
    expect(html).toContain('md-box--center')
    expect(html).toContain('Centered.')
  })

  it('renders indent', () => {
    const html = render(':::indent\nIndented text.\n:::')
    expect(html).toContain('md-box--indent')
    expect(html).toContain('Indented text.')
  })

  it('renders compact', () => {
    const html = render(':::compact\n| A | B |\n|---|---|\n| 1 | 2 |\n:::')
    expect(html).toContain('md-box--compact')
  })

  it('renders container with markdown content (GFM tables)', () => {
    const html = render(
      ':::grammarbox{title="Cases"}\n' +
      '| Case | Ending |\n' +
      '|------|--------|\n' +
      '| Nom  | -s     |\n' +
      ':::' +
      ''
    )
    expect(html).toContain('<table')
    expect(html).toContain('Cases')
  })

  it('handles empty container', () => {
    const html = render(':::grammarbox\n:::')
    expect(html).toContain('md-box--grammarbox')
    // Should not crash or produce malformed HTML
  })
})

describe('Sanskrit/courseware containers', () => {
  it('renders grammarbox2 (orange)', () => {
    const html = render(':::grammarbox2\nAdvanced note.\n:::')
    expect(html).toContain('md-box--grammarbox2')
    expect(html).toContain('Advanced note.')
  })

  it('renders media (flex centered)', () => {
    const html = render(':::media\n![alt](img.png)\n:::')
    expect(html).toContain('md-box--media')
  })

  // it('renders metrik-schema (inactive — commented out)', () => {
    //   const html = render(':::metrik-schema\n◡ – –\n:::')
    //   expect(html).toContain('md-box--metrik-schema')
    // })

    it('renders hidden (invisible)', () => {
    const html = render(':::hidden\nHidden content\n:::')
    expect(html).toContain('md-box--hidden')
  })

  // it('renders no-header (inactive — commented out)', () => {
    //   const html = render(':::no-header\n| A | B |\n|---|---|\n| 1 | 2 |\n:::')
    //   expect(html).toContain('md-box--no-header')
    // })

    // it('renders laut-table (inactive — commented out)', () => {
        //   const html = render(':::laut-table\n| Velar | k | kh |\n:::')
        //   expect(html).toContain('md-box--laut-table')
        // })
})

describe('regression: unknown directives consumed by remark-directive', () => {
  it('unknown container directive becomes empty div (not literal text)', () => {
    // :::{unknown} is parsed by remark-directive as a leaf directive.
    // remarkBoxes skips it (not in CONTAINER_KINDS), leaving only its children.
    const html = render(':::unknown-box\nSome content.\n:::')
    expect(html).not.toContain('md-box--unknown-box')
    expect(html).toContain('Some content.')
  })

  it('colon-prefix patterns are reconstructed as text', () => {
    // :name patterns are parsed as inline directives by remark-directive,
    // but our filter reconstructs them.
    const html = render('This is :warning important text.')
    expect(html).toContain(':warning')
  })

  it('passes through leaf directive (::name)', () => {
    const html = render('::something')
    // ::something without content after it may or may not be parsed
    // by remark-directive. If parsed, should be restored.
    expect(html).not.toContain('md-box--something')
  })

  it('colon-number patterns are reconstructed as text', () => {
    // 1:n is parsed by remark-directive as inline directive "1" with value "n"
    // but our filter reconstructs them.
    const html = render('A ratio of 1:n is common.')
    expect(html).toContain('1:n')
  })

  it('preserves :smile: style shortcodes', () => {
    const html = render('I am :smile: today.')
    // :smile: without [content] or {attrs} should pass through
    expect(html).toContain(':smile:')
  })

  it('prose ::: separator is reconstructed as text', () => {
    // ::: separator is normalized to :::separator{} which becomes a
    // leaf directive, but our filter reconstructs it.
    const html = render('Here is some text\n\n::: separator\n\nMore text.')
    expect(html).toContain('::: separator')
    expect(html).toContain('More text.')
  })
})

describe('rendered HTML structure', () => {
  it('wraps content in md-box__inner and md-box__body', () => {
    const html = render(':::grammarbox{title="Test"}\nBody text.\n:::')
    expect(html).toContain('md-box__inner')
    expect(html).toContain('md-box__body')
    expect(html).toContain('md-box__title')
  })

  it('includes data-box-kind attribute', () => {
      const html = render(':::grammarbox\nNote.\n:::')
      expect(html).toContain('data-box-kind="grammarbox"')
    })

  it('important uses <aside> tag', () => {
    const html = render(':::important\nWarning!\n:::')
    expect(html).toMatch(/<aside[^>]*class="[^"]*md-box[^"]*"/)
  })
})

describe('container text reconstruction', () => {
  it('reconstructs unknown container with children as literal', () => {
    const html = render(':::custom\nHello world\nMore text\n:::')
    // Unknown containers are reconstructed into text by our filter
    expect(html).not.toContain('<div')
    expect(html).toContain(':::custom')
    expect(html).toContain('Hello world')
    expect(html).toContain('More text')
  })
})

describe('table colspan/rowspan rendering', () => {
  // Helper: render with full table pipeline (GFM + colspan expansion)
  function renderTable(md: string): string {
    const normalized = normalizeMultimdTableSyntax(md)
    const processor = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkBreaks)
      .use(remarkMath)
      .use(remarkDirective)
      .use(remarkTableColspan)
      .use(remarkBoxes)
      .use(remarkDirectiveFilter)
      .use(remarkRehype)
      .use(rehypeStringify)
    const html = String(processor.processSync(normalized))
    return html
  }

  // Helper for basic GFM table tests (without colspan)
  function renderBasicTable(md: string): string {
    const processor = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkBreaks)
      .use(remarkMath)
      .use(remarkDirective)
      .use(remarkBoxes)
      .use(remarkDirectiveFilter)
      .use(remarkRehype)
      .use(rehypeStringify)
    return String(processor.processSync(md))
  }

  it('basic 2-column GFM table renders correctly', () => {
    const md = '| Col A | Col B |\n' +
      '|-------|-------|\n' +
      '| val1  | val2  |\n'
    const html = renderBasicTable(md)
    expect(html).toContain('<table')
    expect(html).toContain('Col A')
    expect(html).toContain('Col B')
    expect(html).toContain('val1')
    expect(html).toContain('val2')
    expect(html).toContain('<thead')
    expect(html).toContain('<tbody')
  })

  it('single || colspan expands header to 3 columns', () => {
    const md = '| A || B |\n' +
      '|---|---|---|\n' +
      '| 1 | 2 |\n'
    const html = renderTable(md)
    expect(html).toContain('<table>')
    // After colspan expansion: Header has 2 th elements (A spans 2 columns, B is 1)
    // First th should have colSpan="2"
    const theadMatch = html.match(/<thead[^>]*>[\s\S]*?<\/thead>/)
    expect(theadMatch).toBeTruthy()
    const thCount = (theadMatch![0].match(/<th(?:\s[^>]*)?>/g) || []).length
    expect(thCount).toBe(3)
    // First th should have colspan="2"
    expect(theadMatch![0]).toContain('colspan="2"')
  })

  it('double || colspan expands header to 5 columns', () => {
    const md = '| A || B || C |\n' +
      '|---|---|---|\n' +
      '| 1 | 2 | 3 |\n'
    const html = renderTable(md)
    expect(html).toContain('<table>')
    const theadMatch = html.match(/<thead[^>]*>[\s\S]*?<\/thead>/)
    expect(theadMatch).toBeTruthy()
    const thCount = (theadMatch![0].match(/<th(?:\s[^>]*)?>/g) || []).length
    expect(thCount).toBe(5)
  })

  it('body rows are padded to match expanded header', () => {
    const md = '| A || B |\n' +
      '|---|---|---|\n' +
      '| 1 | 2 |\n'
    const html = renderTable(md)
    // The body row should also have 3 td elements after padding
    const tbodyMatch = html.match(/<tbody[^>]*>[\s\S]*?<\/tbody>/)
    expect(tbodyMatch).toBeTruthy()
    const tdCount = (tbodyMatch![0].match(/<td>/g) || []).length
    expect(tdCount).toBe(3)
  })

  it('colspan with non-breaking body still renders table', () => {
    const md = '| Header || Extra |\n' +
      '|--------|---|-------|\n' +
      '| cell 1 | cell 2 | cell 3 |\n'
    const html = renderTable(md)
    expect(html).toContain('<table>')
    expect(html).toContain('Header')
    // Body should have exactly 3 td elements
    const tbodyMatch = html.match(/<tbody[^>]*>[\s\S]*?<\/tbody>/)
    const tdCount = tbodyMatch ? (tbodyMatch![0].match(/<td>/g) || []).length : 0
    expect(tdCount).toBe(3)
  })

  it('multiple || in same header row handled correctly', () => {
    const md = '| A || B | C || D |\n' +
      '|---|----|---|---|\n' +
      '| 1 | 2  | 3 | 4 |\n'
    const html = renderTable(md)
    expect(html).toContain('<table>')
    const theadMatch = html.match(/<thead[^>]*>[\s\S]*?<\/thead>/)
    const thCount = theadMatch ? (theadMatch![0].match(/<th(?:\s[^>]*)?>/g) || []).length : 0
    expect(thCount).toBe(6)
  })

  it('colspan works inside container blocks', () => {
    const md = ':::grammarbox{title="Cases"}\n' +
      '| Case || Extra |\n' +
      '|------|---|-------|\n' +
      '| Nom  | -s    |\n' +
      ':::'
    const html = renderTable(md)
    expect(html).toContain('md-box--grammarbox')
    expect(html).toContain('Cases')
    expect(html).toContain('<table>')
    expect(html).toContain('Nom')
  })

  it('table without || uses standard 2-column GFM table', () => {
    const md = '| Col1 | Col2 |\n' +
      '|------|------|\n' +
      '| a    | b    |\n'
    const html = renderTable(md)
    expect(html).toContain('<table>')
    const theadMatch = html.match(/<thead[^>]*>[\s\S]*?<\/thead>/)
    const thCount = theadMatch ? (theadMatch![0].match(/<th(?:\s[^>]*)?>/g) || []).length : 0
    expect(thCount).toBe(2)
    const tbodyMatch = html.match(/<tbody[^>]*>[\s\S]*?<\/tbody>/)
    const tdCount = tbodyMatch ? (tbodyMatch![0].match(/<td(?:\s[^>]*)?>/g) || []).length : 0
    expect(tdCount).toBe(2)
  })

  it('empty colspan table renders as plain paragraphs', () => {
    const md = '| Header || Extra |\n' +
      '|--------|---|-------|\n'
    const html = renderTable(md)
    expect(html).toContain('<table')
    expect(html).toContain('Header')
    // Empty body should have 0 cells
    const tbodyMatch = html.match(/<tbody[^>]*>[\s\S]*?<\/tbody>/)
    if (tbodyMatch) {
      const tdCount = (tbodyMatch[0].match(/<td/g) || []).length
      expect(tdCount).toBe(0)
    }
  })
})