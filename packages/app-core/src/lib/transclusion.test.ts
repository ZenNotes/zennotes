// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { expandEmbeds, hasNoteEmbeds } from './transclusion'
import { renderMarkdown } from './markdown'

// Mock vault keyed by note name (without .md).
function ctxFor(vault: Record<string, { title: string; body: string }>) {
  return {
    resolve: (target: string) => {
      const key = target.replace(/\.md$/i, '')
      return vault[key] ? { path: `${key}.md`, title: vault[key].title } : null
    },
    loadNote: async (path: string) => vault[path.replace(/\.md$/i, '')]?.body ?? null
  }
}

describe('expandEmbeds — transclusion', () => {
  it('inlines a note embed in a styled block', async () => {
    const ctx = ctxFor({ Child: { title: 'Child', body: '# Child\n\nHello.' } })
    const out = await expandEmbeds('Before\n\n![[Child]]\n\nAfter', 'Master.md', ctx)
    expect(out).toContain('<div class="note-embed" data-embed-src="Child">')
    expect(out).toContain('# Child')
    expect(out).toContain('Hello.')
    expect(out).toContain('Before')
    expect(out).toContain('After')
  })

  it('expands nested embeds recursively', async () => {
    const ctx = ctxFor({
      A: { title: 'A', body: 'A-body\n\n![[B]]' },
      B: { title: 'B', body: 'B-body' }
    })
    const out = await expandEmbeds('![[A]]', 'Master.md', ctx)
    expect(out).toContain('A-body')
    expect(out).toContain('B-body')
    expect(out.match(/class="note-embed"/g)?.length).toBe(2)
  })

  it('breaks self / circular embeds with a notice', async () => {
    const ctx = ctxFor({
      A: { title: 'A', body: 'A-body\n\n![[B]]' },
      B: { title: 'B', body: 'B-body\n\n![[A]]' } // cycles back to A
    })
    const out = await expandEmbeds('![[A]]', 'Master.md', ctx)
    expect(out).toContain('A-body')
    expect(out).toContain('B-body')
    expect(out).toContain('Circular embed skipped')
  })

  it('leaves image / unresolved embeds untouched', async () => {
    const out = await expandEmbeds('![[photo.png]] and ![[Missing]]', 'M.md', ctxFor({}))
    expect(out).toBe('![[photo.png]] and ![[Missing]]')
    expect(out).not.toContain('note-embed')
  })

  it('does not expand embeds inside code', async () => {
    const ctx = ctxFor({ Child: { title: 'Child', body: 'child' } })
    const fenced = '```\n![[Child]]\n```'
    expect(await expandEmbeds(fenced, 'M.md', ctx)).toBe(fenced)
    const inline = 'use `![[Child]]` syntax'
    expect(await expandEmbeds(inline, 'M.md', ctx)).toBe(inline)
  })

  it('strips the embedded note frontmatter', async () => {
    const ctx = ctxFor({ Child: { title: 'Child', body: '---\ntags: x\n---\n\nBody only' } })
    const out = await expandEmbeds('![[Child]]', 'M.md', ctx)
    expect(out).toContain('Body only')
    expect(out).not.toContain('tags: x')
  })

  it('stops at the depth limit', async () => {
    // A -> A -> A … (self-ref through a fresh path each level is impossible here,
    // so use a chain longer than maxDepth).
    const vault: Record<string, { title: string; body: string }> = {}
    for (let i = 0; i < 10; i += 1) vault[`N${i}`] = { title: `N${i}`, body: `n${i}\n\n![[N${i + 1}]]` }
    const out = await expandEmbeds('![[N0]]', 'M.md', { ...ctxFor(vault), maxDepth: 3 })
    expect(out).toContain('n0')
    expect(out).toContain('nesting too deep')
  })

  it('hasNoteEmbeds detects note embeds but not images/code', () => {
    const resolve = (t: string) => (t === 'Child' ? { path: 'Child.md', title: 'Child' } : null)
    expect(hasNoteEmbeds('![[Child]]', resolve, 'M.md')).toBe(true)
    expect(hasNoteEmbeds('![[img.png]]', resolve, 'M.md')).toBe(false)
    expect(hasNoteEmbeds('`![[Child]]`', resolve, 'M.md')).toBe(false)
    expect(hasNoteEmbeds('no embeds here', resolve, 'M.md')).toBe(false)
  })
})

describe('note-embed wrapper renders its inner markdown (foundation)', () => {
  it('renderMarkdown parses markdown inside the embed div', () => {
    const wrapped =
      '<div class="note-embed" data-embed-src="Child">\n\n# Heading\n\nSome **bold**.\n\n</div>'
    const html = renderMarkdown(wrapped)
    expect(html).toContain('class="note-embed"')
    expect(html).toContain('data-embed-src="Child"')
    expect(html).toMatch(/<h1[^>]*>Heading<\/h1>/)
    expect(html).toContain('<strong>bold</strong>')
  })
})

// The real `resolve` runs through resolveWikilinkTarget, which strips the
// `#heading` / `^block` anchor before matching a note. Mirror that here.
function anchorAwareCtxFor(vault: Record<string, { title: string; body: string }>) {
  return {
    resolve: (target: string) => {
      const key = target.split(/[#^]/)[0].trim().replace(/\.md$/i, '')
      return vault[key] ? { path: `${key}.md`, title: vault[key].title } : null
    },
    loadNote: async (path: string) => vault[path.replace(/\.md$/i, '')]?.body ?? null
  }
}

describe('expandEmbeds: block transclusion (#601)', () => {
  const vault = {
    Daily: {
      title: 'Daily',
      body: '# Daily\n\n## Notes\n\n- First note\n- Second note ^note-two\n- Third note\n'
    }
  }

  it('embeds only the block the id marks, not the whole note', async () => {
    const out = await expandEmbeds('![[Daily^note-two]]', 'Master.md', anchorAwareCtxFor(vault))
    expect(out).toContain('- Second note')
    expect(out).not.toContain('First note')
    expect(out).not.toContain('Third note')
    expect(out).not.toContain('# Daily')
  })

  it('drops the marker from the embedded text', async () => {
    const out = await expandEmbeds('![[Daily^note-two]]', 'Master.md', anchorAwareCtxFor(vault))
    expect(out).not.toContain('^note-two\n')
  })

  it('titles the embed with the note and the block', async () => {
    const out = await expandEmbeds('![[Daily^note-two]]', 'Master.md', anchorAwareCtxFor(vault))
    expect(out).toContain('Daily > note-two')
  })

  it('shows a notice when the id is gone, rather than the whole note', async () => {
    const out = await expandEmbeds('![[Daily^deleted]]', 'Master.md', anchorAwareCtxFor(vault))
    expect(out).toContain('Embedded block not found')
    expect(out).not.toContain('First note')
  })

  it('still embeds the whole note when no block is named', async () => {
    const out = await expandEmbeds('![[Daily]]', 'Master.md', anchorAwareCtxFor(vault))
    expect(out).toContain('First note')
    expect(out).toContain('Third note')
  })
})
