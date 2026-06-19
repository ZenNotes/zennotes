/**
 * Tests for remark-scholarly plugin.
 *
 * Handles:
 *   - :br → hard line break
 *   - :indent → inline indent span
 *   - ⟪Devanagari⟫ → explicit Sanskrit markup (red)
 */
import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkDirective from 'remark-directive'
import remarkScholarly from './remark-scholarly'
import remarkRehype from 'remark-rehype'
import rehypeStringify from 'rehype-stringify'

function render(md: string): string {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkDirective)
    .use(remarkScholarly)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeStringify)

  return String(processor.processSync(md))
}

describe('remarkScholarly', () => {
  it('transforms :br to hard break', () => {
    const html = render('Cell A :br Cell B')
    expect(html).toContain('<br>')
  })

  it('transforms :indent to inline span', () => {
    const html = render('Before:indent after')
    expect(html).toContain('indent-inline')
  })

  it('wraps explicit ⟪Sanskrit⟫ in sanskrit-dev span', () => {
    const html = render('Term ⟪संस्कृत⟫ here')
    expect(html).toContain('sanskrit-dev')
    expect(html).toContain('संस्कृत')
  })

  it('does NOT auto-wrap bare Devanagari (avoids wikilink collisions)', () => {
    const html = render('The word धर्म means dharma. Also [[संस्कृत]]')
    expect(html).not.toContain('sanskrit-dev')
    expect(html).toContain('धर्म')
    expect(html).toContain('[[संस्कृत]]')
  })

  it('does NOT transform inside headings', () => {
    const html = render('# Heading with ⟪संस्कृत⟫')
    expect(html).not.toContain('sanskrit-dev')
    expect(html).toContain('⟪संस्कृत⟫')
  })
})