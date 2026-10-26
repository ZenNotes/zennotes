import { describe, expect, it } from 'vitest'
import {
  UNRESOLVED_LINKS_TAB_PATH,
  collectUnresolvedLinks,
  findWikilinkOccurrences,
  isUnresolvedLinksTabPath,
  unresolvedLinkKey,
  unresolvedOccurrencesIn,
  wikilinkNoteName,
  type UnresolvedLinkSource
} from './unresolved-links'
import { scanMarkdownLines } from './markdown-lines'

describe('findWikilinkOccurrences', () => {
  it('reports each link with its 1-based line and body offsets', () => {
    const body = 'intro\nsee [[Alpha]] and [[Beta|the beta]]\n![[Gamma]]'
    const found = findWikilinkOccurrences(body)
    expect(found.map((o) => [o.target, o.line])).toEqual([
      ['Alpha', 2],
      ['Beta', 2],
      ['Gamma', 3]
    ])
    expect(body.slice(found[0]!.from, found[0]!.to)).toBe('[[Alpha]]')
    expect(body.slice(found[1]!.from, found[1]!.to)).toBe('[[Beta|the beta]]')
    expect(body.slice(found[2]!.from, found[2]!.to)).toBe('![[Gamma]]')
    expect(found[1]!.text).toBe('see [[Alpha]] and [[Beta|the beta]]')
    expect(found[1]!.column).toBe('see [[Alpha]] and '.length)
  })

  it('ignores links inside fenced code blocks, tilde fences and nested list fences', () => {
    const body = [
      '[[Real]]',
      '```md',
      '[[In Fence]]',
      '```',
      '~~~',
      '[[In Tilde]]',
      '~~~',
      '- item',
      '  ```',
      '  [[In List Fence]]',
      '  ```',
      'after [[After]]'
    ].join('\n')
    expect(findWikilinkOccurrences(body).map((o) => o.target)).toEqual(['Real', 'After'])
  })

  it('ignores links inside inline code spans and keeps later columns exact', () => {
    const body = 'a `[[Code]]` b [[Prose]]'
    const found = findWikilinkOccurrences(body)
    expect(found.map((o) => o.target)).toEqual(['Prose'])
    expect(body.slice(found[0]!.from, found[0]!.to)).toBe('[[Prose]]')
  })

  it('treats a backtick run with a backtick in its info string as inline code, not a fence', () => {
    const body = '```[[Inline]]```\n[[Next]]'
    expect(findWikilinkOccurrences(body).map((o) => o.target)).toEqual(['Next'])
  })

  it('does not let a longer closer requirement leak a fence open', () => {
    const body = '````\n```\n[[Still Code]]\n````\n[[Out]]'
    expect(findWikilinkOccurrences(body).map((o) => o.target)).toEqual(['Out'])
  })

  it('scans frontmatter lines, as the vault index does', () => {
    const body = '---\nrelated: "[[Front]]"\n---\nbody [[Body]]'
    expect(findWikilinkOccurrences(body).map((o) => [o.target, o.line])).toEqual([
      ['Front', 2],
      ['Body', 4]
    ])
  })

  it('counts a CRLF break as one character, like the editor', () => {
    const body = 'one\r\ntwo [[Link]]'
    const [hit] = findWikilinkOccurrences(body)
    expect(hit!.line).toBe(2)
    expect(hit!.from).toBe('one\ntwo '.length)
  })

  it('skips empty targets', () => {
    expect(findWikilinkOccurrences('[[ ]] [[|alias]]')).toEqual([])
  })
})

describe('scanMarkdownLines includeFrontmatter', () => {
  it('still skips frontmatter by default', () => {
    const body = '---\na: b\n---\ntext'
    expect(scanMarkdownLines(body).map((l) => l.text)).toEqual(['text'])
    expect(scanMarkdownLines(body, { includeFrontmatter: true }).map((l) => l.text)).toEqual([
      '---',
      'a: b',
      '---',
      'text'
    ])
  })
})

describe('unresolvedLinkKey', () => {
  it('folds case, anchors, the .md extension and a leading slash into one note', () => {
    for (const spelling of ['Doc', 'doc', 'Doc#Intro', 'Doc^block', 'Doc.md', '/Doc', ' Doc ']) {
      expect(unresolvedLinkKey(spelling)).toBe('doc')
    }
  })

  it('keeps folders: a path spelling names a different file', () => {
    expect(unresolvedLinkKey('ideas/Doc')).toBe('ideas/doc')
    expect(unresolvedLinkKey('ideas\\Doc#h')).toBe('ideas/doc')
  })

  it('names the note part of an anchored target', () => {
    expect(wikilinkNoteName('Doc#Heading')).toBe('Doc')
    expect(wikilinkNoteName('#Heading')).toBe('')
  })
})

describe('collectUnresolvedLinks', () => {
  const note = (path: string, wikilinks: string[], folder = 'inbox'): UnresolvedLinkSource => ({
    path,
    folder,
    wikilinks
  })
  const existing = new Set(['alpha'])
  const resolves = (target: string): boolean => existing.has(unresolvedLinkKey(target))

  it('groups spellings of one missing note and lists each source note once', () => {
    const a = note('inbox/a.md', ['Missing', 'missing#Part', 'Alpha'])
    const b = note('inbox/b.md', ['Missing|alias'.split('|')[0]!])
    const groups = collectUnresolvedLinks([a, b], resolves)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.target).toBe('Missing')
    expect(groups[0]!.sources.map((n) => n.path)).toEqual(['inbox/a.md', 'inbox/b.md'])
  })

  it('drops the anchor from the name it would create', () => {
    const groups = collectUnresolvedLinks([note('inbox/a.md', ['Later#Plan'])], resolves)
    expect(groups[0]!.target).toBe('Later')
  })

  it('ignores trashed source notes and targets the resolver accepts', () => {
    const groups = collectUnresolvedLinks(
      [note('trash/t.md', ['Gone'], 'trash'), note('inbox/a.md', ['Alpha'])],
      resolves
    )
    expect(groups).toEqual([])
  })

  it('asks the resolver with the note the link was written in', () => {
    const seen: Array<[string, string]> = []
    collectUnresolvedLinks([note('inbox/a.md', ['Sibling#Local'])], (target, from) => {
      seen.push([target, from.path])
      return true
    })
    expect(seen).toEqual([['Sibling#Local', 'inbox/a.md']])
  })

  it('skips a target that names no note at all', () => {
    let asked = 0
    const groups = collectUnresolvedLinks([note('inbox/a.md', ['#heading', '^block'])], () => {
      asked++
      return false
    })
    expect(groups).toEqual([])
    expect(asked).toBe(0)
  })

  it('puts the most-linked missing note first, then sorts by name', () => {
    const groups = collectUnresolvedLinks(
      [
        note('inbox/a.md', ['beta', 'Zeta']),
        note('inbox/b.md', ['Zeta', 'alpha 2']),
        note('inbox/c.md', ['alpha 10'])
      ],
      () => false
    )
    expect(groups.map((g) => g.target)).toEqual(['Zeta', 'alpha 2', 'alpha 10', 'beta'])
  })
})

describe('unresolvedOccurrencesIn', () => {
  it('returns only the lines that link to the requested missing notes', () => {
    const body = '[[Alpha]]\n[[Later#Plan]] and `[[Later]]`\n```\n[[Later]]\n```\n[[later]]'
    const hits = unresolvedOccurrencesIn(body, new Set(['later']))
    expect(hits.map((h) => [h.target, h.line, h.key])).toEqual([
      ['Later#Plan', 2, 'later'],
      ['later', 6, 'later']
    ])
  })
})

describe('Unresolved Links tab path', () => {
  it('is a zen:// virtual path', () => {
    expect(UNRESOLVED_LINKS_TAB_PATH.startsWith('zen://')).toBe(true)
    expect(isUnresolvedLinksTabPath(UNRESOLVED_LINKS_TAB_PATH)).toBe(true)
    expect(isUnresolvedLinksTabPath('inbox/unresolved-links.md')).toBe(false)
    expect(isUnresolvedLinksTabPath(null)).toBe(false)
  })
})
