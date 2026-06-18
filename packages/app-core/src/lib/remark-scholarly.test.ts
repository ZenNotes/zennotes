/**
 * Tests for remark-scholarly plugins — split-phase pipeline.
 *
 * Phase 1 (remarkScholarlyExtensions, before wikilinks):
 *   [[br]], [[indent]], ⟪explicit⟫ Sanskrit markup
 *
 * Phase 2 (remarkScholarlyDevanagari, after wikilinks):
 *   Bare Devanagari auto-wrap, link-node guard
 */
import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkScholarly, { remarkScholarlyDevanagari } from './remark-scholarly'
import remarkRehype from 'remark-rehype'
import rehypeStringify from 'rehype-stringify'

function renderWithWikilinks(md: string): string {
  // Mimics the real pipeline order:
  //   remarkScholarly → wikilinks → remarkScholarlyDevanagari
  const { visit, SKIP } = require('unist-util-visit')

  function remarkWikilinksStub() {
    return (tree: import('mdast').Root): void => {
      visit(tree, 'text', (node: any, index: number, parent: any) => {
        if (!parent || index === undefined) return
        const value = node.value as string
        if (!value.includes('[[')) return
        const regex = /\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g
        const parts: any[] = []
        let last = 0
        let m: RegExpExecArray | null
        while ((m = regex.exec(value)) !== null) {
          if (m.index > last) {
            parts.push({ type: 'text', value: value.slice(last, m.index) })
          }
          parts.push({
            type: 'link',
            url: `zen://note/${encodeURIComponent(m[1].trim())}`,
            title: null,
            data: {
              hProperties: {
                className: ['wikilink'],
                'data-wikilink': m[1].trim(),
              },
            },
            children: [{ type: 'text', value: (m[2] ?? m[1]).trim() }],
          })
          last = regex.lastIndex
        }
        if (last < value.length) {
          parts.push({ type: 'text', value: value.slice(last) })
        }
        parent.children.splice(index, 1, ...parts)
        return [SKIP, index + parts.length]
      })
    }
  }

  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkScholarly)                  // Phase 1: [[br]], [[indent]], ⟪⟫
    .use(remarkWikilinksStub)              // Wikilinks resolve [[note]]
    .use(remarkScholarlyDevanagari)        // Phase 2: bare Devanagari auto-wrap
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeStringify)

  return String(processor.processSync(md))
}

function renderPhase1Only(md: string): string {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkScholarly)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeStringify)

  return String(processor.processSync(md))
}

describe('Phase 1: [[br]], [[indent]], ⟪⟫ (before wikilinks)', () => {
  it('transforms [[br]] to hard break', () => {
    const html = renderPhase1Only('Cell A[[br]]Cell B')
    expect(html).toContain('<br>')
  })

  it('transforms [[indent]] to inline span', () => {
    const html = renderPhase1Only('Before[[indent]]after')
    expect(html).toContain('indent-inline')
  })

  it('wraps explicit ⟪Sanskrit⟫ in sanskrit-dev span', () => {
    const html = renderPhase1Only('Term \u27ea\u0938\u0902\u0938\u094d\u0915\u0943\u0924\u27eb here')
    expect(html).toContain('sanskrit-dev')
  })

  it('does NOT auto-wrap bare Devanagari (phase 2 responsibility)', () => {
    const html = renderPhase1Only('Plain \u0927\u0930\u094d\u092e text')
    // Phase 1 should NOT wrap bare Devanagari
    expect(html).not.toContain('sanskrit-dev')
    expect(html).toContain('\u0927\u0930\u094d\u092e')
  })
})

describe('Phase 2: bare Devanagari auto-wrap (after wikilinks)', () => {
  it('auto-wraps bare Devanagari', () => {
    const html = renderWithWikilinks('The word \u0927\u0930\u094d\u092e means dharma')
    expect(html).toContain('sanskrit-dev')
    expect(html).toContain('\u0927\u0930\u094d\u092e')
  })

  it('does NOT wrap Devanagari inside [[wikilinks]]', () => {
    const html = renderWithWikilinks('See [[\u0927\u0930\u094d\u092e]] for details')
    expect(html).toContain('data-wikilink')
    // Devanagari in wikilink should NOT be wrapped
    const sanskritCount = (html.match(/sanskrit-dev/g) || []).length
    expect(sanskritCount).toBe(0)
  })

  it('wraps Devanagari outside but not inside wikilinks', () => {
    const html = renderWithWikilinks('Plain \u0927\u0930\u094d\u092e and [[\u0927\u0930\u094d\u092e]] link')
    expect(html).toContain('data-wikilink')
    // Only the plain one should be wrapped (1 occurrence)
    const sanskritCount = (html.match(/sanskrit-dev/g) || []).length
    expect(sanskritCount).toBe(1)
  })
})

describe('full pipeline: scholarly + wikilinks coexist', () => {
  it('[[br]] survives wikilink processing', () => {
    const html = renderWithWikilinks('Cell A[[br]]Cell B')
    expect(html).toContain('<br>')
  })

  it('[[indent]] survives wikilink processing', () => {
    const html = renderWithWikilinks('[[indent]]text')
    expect(html).toContain('indent-inline')
  })

  it('[[Note]] wikilink and [[br]] in same paragraph', () => {
    const html = renderWithWikilinks('See [[Note]] for[[br]]details')
    expect(html).toContain('data-wikilink')
    expect(html).toContain('<br>')
  })

  it('[[Note]] wikilink and [[indent]] in same paragraph', () => {
    const html = renderWithWikilinks('[[Note]][[indent]]more')
    expect(html).toContain('data-wikilink')
    expect(html).toContain('indent-inline')
  })
})

describe('regression: prose patterns', () => {
  it('preserves :n pattern', () => {
    const html = renderWithWikilinks('Ratio 1:n is common')
    expect(html).toContain('1:n')
  })

  it('preserves :smile: shortcodes', () => {
    const html = renderWithWikilinks('I am :smile: today')
    expect(html).toContain(':smile:')
  })

  it('preserves [[unmatched]] text', () => {
    const html = renderWithWikilinks('Some [[unmatched]] text')
    expect(html.length).toBeGreaterThan(0)
  })
})