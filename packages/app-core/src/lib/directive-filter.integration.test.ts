import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkDirective from 'remark-directive'
import remarkBoxes from './remark-boxes'
import remarkDirectiveFilter from './remark-directive-filter'
import remarkRehype from 'remark-rehype'
import rehypeStringify from 'rehype-stringify'

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

describe('directive filter integration', () => {
  it('known container (grammarbox) renders as styled box', () => {
    const html = render(':::grammarbox{title="Test"}\nContent.\n:::')
    expect(html).toContain('md-box--grammarbox')
    expect(html).toContain('Content.')
  })

  it('unknown container (Text) restored to plain text', () => {
    const html = render(':::Text\nSome text content.\n:::')
    expect(html).toContain(':::Text')
    expect(html).toContain('Some text content.')
  })

  it('text directive (:warning) restored to plain text', () => {
    const html = render('This is :warning important text.')
    expect(html).toContain(':warning')
    expect(html).toContain('important text')
  })

  it('leaf directive (::note) restored to plain text', () => {
    const html = render('::note')
    expect(html).toContain('::note')
  })

  it('colon number (1:n) restored to plain text', () => {
    const html = render('A ratio of 1:n is common.')
    expect(html).toContain('1:n')
  })
})