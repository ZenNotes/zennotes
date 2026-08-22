import { describe, expect, it } from 'vitest'
import {
  blockAnchorsTargeting,
  extractWikilinkTargets,
  extractMarkdownLinkHrefs,
  isSameFileBlockLink,
  isSameFileHeadingLink,
  parseCreateNotePath,
  resolveWikilinkPath,
  resolveWikilinkTarget,
  stripWikilinkAnchor,
  suggestCreateNotePath,
  wikilinkBlockAnchor,
  wikilinkDisplayLabel,
  wikilinkHeadingAnchor
} from './wikilinks'

describe('extractWikilinkTargets — code fences are not scanned (#293)', () => {
  it('ignores [[links]] inside a fence indented under a list item', () => {
    const body = '- item:\n\n  ```\n  see [[Secret Note]] here\n  ```\n\n[[Real Link]]'
    expect(extractWikilinkTargets(body)).toEqual(['Real Link'])
  })
})

const notes = [
  { path: 'inbox/My Document.md', title: 'My Document', folder: 'inbox' as const },
  { path: 'inbox/projects/Spec.md', title: 'Spec', folder: 'inbox' as const }
]

describe('stripWikilinkAnchor (#196)', () => {
  it('drops a #heading anchor', () => {
    expect(stripWikilinkAnchor('My Document#My Heading')).toBe('My Document')
  })

  it('drops a ^block anchor', () => {
    expect(stripWikilinkAnchor('My Document^abc123')).toBe('My Document')
  })

  it('keeps a plain target untouched', () => {
    expect(stripWikilinkAnchor('My Document')).toBe('My Document')
  })

  it('keeps the path up to the first anchor', () => {
    expect(stripWikilinkAnchor('projects/Spec#design')).toBe('projects/Spec')
  })
})

describe('wikilinkHeadingAnchor (#196)', () => {
  it('returns the heading text after #', () => {
    expect(wikilinkHeadingAnchor('My Document#My Heading')).toBe('My Heading')
  })

  it('is null without a heading anchor', () => {
    expect(wikilinkHeadingAnchor('My Document')).toBeNull()
    expect(wikilinkHeadingAnchor('My Document^block')).toBeNull()
  })
})

describe('wikilinkBlockAnchor (#601)', () => {
  it('returns the block id after ^', () => {
    expect(wikilinkBlockAnchor('Daily Note^note-two')).toBe('note-two')
    expect(wikilinkBlockAnchor('projects/Spec^abc123')).toBe('abc123')
  })

  it('is null without a block anchor', () => {
    expect(wikilinkBlockAnchor('My Document')).toBeNull()
    expect(wikilinkBlockAnchor('My Document#My Heading')).toBeNull()
    expect(wikilinkBlockAnchor('My Document^')).toBeNull()
  })

  it('yields to whichever anchor marker comes first', () => {
    // A heading link that happens to contain a caret stays a heading link.
    expect(wikilinkBlockAnchor('Doc#Heading^id')).toBeNull()
    expect(wikilinkHeadingAnchor('Doc#Heading^id')).toBe('Heading^id')
    // ...and the reverse.
    expect(wikilinkBlockAnchor('Doc^id#not-a-heading')).toBe('id#not-a-heading')
    expect(wikilinkHeadingAnchor('Doc^id#not-a-heading')).toBeNull()
  })

  it("parses Obsidian's canonical block form Note#^id as a block link (#601 review)", () => {
    expect(wikilinkBlockAnchor('Daily Note#^note-two')).toBe('note-two')
    expect(wikilinkHeadingAnchor('Daily Note#^note-two')).toBeNull()
    // The same-file spelling Obsidian writes.
    expect(wikilinkBlockAnchor('#^note-two')).toBe('note-two')
    expect(isSameFileBlockLink('#^note-two')).toBe(true)
  })
})

describe('wikilinkDisplayLabel (#601)', () => {
  it('separates the note from the anchor it points at', () => {
    expect(wikilinkDisplayLabel('Daily Note^note-two')).toBe('Daily Note > note-two')
    expect(wikilinkDisplayLabel('Daily Note#Notes')).toBe('Daily Note > Notes')
  })

  it('shows just the anchor for a same-note link', () => {
    expect(wikilinkDisplayLabel('^note-two')).toBe('note-two')
    expect(wikilinkDisplayLabel('#Notes')).toBe('Notes')
  })

  it('leaves an un-anchored target alone', () => {
    expect(wikilinkDisplayLabel('Daily Note')).toBe('Daily Note')
    expect(wikilinkDisplayLabel('projects/Spec')).toBe('projects/Spec')
  })
})

describe('isSameFileBlockLink (#601)', () => {
  it('is true for a block link with no note part', () => {
    expect(isSameFileBlockLink('^note-two')).toBe(true)
  })

  it('is false when a note part is present, or there is no block anchor', () => {
    expect(isSameFileBlockLink('Doc^note-two')).toBe(false)
    expect(isSameFileBlockLink('#My Heading')).toBe(false)
    expect(isSameFileBlockLink('^')).toBe(false)
  })
})

describe('isSameFileHeadingLink (#291)', () => {
  it('is true for a heading link with no note part', () => {
    expect(isSameFileHeadingLink('#My Heading')).toBe(true)
    expect(isSameFileHeadingLink('#heading')).toBe(true)
  })

  it('is false when a note part is present', () => {
    expect(isSameFileHeadingLink('Doc#My Heading')).toBe(false)
    expect(isSameFileHeadingLink('projects/Spec#design')).toBe(false)
  })

  it('is false without a heading anchor (plain note, empty, or block ref)', () => {
    expect(isSameFileHeadingLink('Doc')).toBe(false)
    expect(isSameFileHeadingLink('#')).toBe(false)
    expect(isSameFileHeadingLink('^block')).toBe(false)
  })
})

describe('blockAnchorsTargeting (#601)', () => {
  const here = 'inbox/My Document.md'

  it('collects the block ids a note aimed at here', () => {
    const targets = ['My Document^note-two', 'My Document^intro', 'Other Note^elsewhere']
    expect(blockAnchorsTargeting(notes, targets, here)).toEqual(['note-two', 'intro'])
  })

  it('ignores links that carry no block anchor', () => {
    expect(blockAnchorsTargeting(notes, ['My Document', 'My Document#Heading'], here)).toEqual([])
  })

  it('de-duplicates a block referenced twice', () => {
    const targets = ['My Document^note-two', 'My Document^note-two']
    expect(blockAnchorsTargeting(notes, targets, here)).toEqual(['note-two'])
  })
})

describe('resolveWikilinkTarget — heading/block anchors (#196)', () => {
  it('resolves [[Doc#heading]] to the document', () => {
    expect(resolveWikilinkTarget(notes, 'My Document#My Heading')?.path).toBe('inbox/My Document.md')
  })

  it('resolves [[Doc^block]] to the document', () => {
    expect(resolveWikilinkTarget(notes, 'My Document^abc')?.path).toBe('inbox/My Document.md')
  })

  it('still resolves a plain [[Doc]]', () => {
    expect(resolveWikilinkTarget(notes, 'My Document')?.path).toBe('inbox/My Document.md')
  })

  it('resolves a path-like [[folder/Doc#heading]]', () => {
    expect(resolveWikilinkTarget(notes, 'projects/Spec#design')?.path).toBe('inbox/projects/Spec.md')
  })

  it('returns null for a bare [[#heading]] with no document', () => {
    expect(resolveWikilinkTarget(notes, '#My Heading')).toBeNull()
  })
})

describe('resolveWikilinkPath: same-note anchors (#601)', () => {
  const currentPath = 'inbox/My Document.md'

  it('uses the current note for a same-note block link', () => {
    expect(resolveWikilinkPath(notes, '^note-two', currentPath)).toBe(currentPath)
  })

  it('uses the current note for a same-note heading link', () => {
    expect(resolveWikilinkPath(notes, '#Introduction', currentPath)).toBe(currentPath)
  })

  it('still resolves a cross-note anchored link normally', () => {
    expect(resolveWikilinkPath(notes, 'projects/Spec^design', currentPath)).toBe(
      'inbox/projects/Spec.md'
    )
  })

  it('returns null when a same-note anchor has no current note', () => {
    expect(resolveWikilinkPath(notes, '^note-two', null)).toBeNull()
  })
})

describe('suggestCreateNotePath — anchored targets (#196)', () => {
  it('suggests the document, not the invalid anchored name', () => {
    expect(suggestCreateNotePath('New Doc#Heading')).toBe('/New Doc.md')
  })
})

describe('leading-slash + anchor (#196 — [[/Untitled#test]])', () => {
  const untitled = [{ path: 'inbox/Untitled.md', title: 'Untitled', folder: 'inbox' as const }]

  it('strips the anchor off an absolute-path target', () => {
    expect(stripWikilinkAnchor('/Untitled#test')).toBe('/Untitled')
  })

  it('resolves [[/Untitled#test]] to inbox/Untitled.md', () => {
    expect(resolveWikilinkTarget(untitled, '/Untitled#test')?.path).toBe('inbox/Untitled.md')
  })

  it('suggests a valid create path (no #, no extra slash)', () => {
    expect(suggestCreateNotePath('/Untitled#test')).toBe('/Untitled.md')
  })

  it('parseCreateNotePath accepts the suggested path', () => {
    expect(parseCreateNotePath(suggestCreateNotePath('/Untitled#test')).relPath).toBe(
      'inbox/Untitled.md'
    )
  })
})

describe('extractMarkdownLinkHrefs (#70dark)', () => {
  it('pulls hrefs from markdown links', () => {
    const body = 'See [Note](Note.md) and [Sub](folder/Sub.md).'
    expect(extractMarkdownLinkHrefs(body)).toEqual(['Note.md', 'folder/Sub.md'])
  })

  it('handles angle-bracket hrefs and drops link titles', () => {
    expect(extractMarkdownLinkHrefs('[a](<a b.md>)')).toEqual(['a b.md'])
    expect(extractMarkdownLinkHrefs('[a](Note.md "the title")')).toEqual(['Note.md'])
  })

  it('ignores links inside code', () => {
    expect(extractMarkdownLinkHrefs('use `[a](Note.md)`')).toEqual([])
    expect(extractMarkdownLinkHrefs('```\n[a](Note.md)\n```')).toEqual([])
  })

  it('dedupes; external hrefs are left for the resolver to filter', () => {
    const body = '[a](Note.md) [b](Note.md) [ext](https://example.com)'
    expect(extractMarkdownLinkHrefs(body)).toEqual(['Note.md', 'https://example.com'])
  })
})
