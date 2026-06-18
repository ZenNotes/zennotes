import { describe, it, expect } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkDirective from 'remark-directive'
import remarkDirectiveFilter from './remark-directive-filter'
import remarkRehype from 'remark-rehype'
import rehypeStringify from 'rehype-stringify'

function render(md: string): string {
  const processor = unified()
    .use(remarkParse)
    .use(remarkDirective)
    .use(remarkDirectiveFilter)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeStringify)
  return String(processor.processSync(md))
}

describe('remarkDirectiveFilter', () => {
  it('restores text directives like 1:2 to plain text', () => {
    const html = render('The ratio is 1:2 for this')
    expect(html).toContain('1:2')
    expect(html).not.toContain('<div></div>')
  })

  it('restores leaf directives like ::note to plain text', () => {
    const html = render('Hello ::note world')
    expect(html).toContain('::note')
    expect(html).not.toContain('<div></div>')
  })
})