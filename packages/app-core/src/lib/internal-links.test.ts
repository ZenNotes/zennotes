import { describe, expect, it } from 'vitest'
import {
  externalLinkUrl,
  extractLinkAtCursor,
  linkRangeAtCursor,
  markdownLinkAt,
  resolveInternalNoteHref
} from './internal-links'

const NOTES = [
  { path: 'Work/Documentation/Vault CLI Cheatsheet.md', folder: 'inbox' },
  { path: 'Work/Documentation/Another Note.md', folder: 'inbox' },
  { path: 'Work/Projects/plan.md', folder: 'inbox' },
  { path: 'index.md', folder: 'inbox' },
  { path: 'Archive/old plan.md', folder: 'trash' }
]

describe('resolveInternalNoteHref', () => {
  const from = 'Work/Documentation/Vault CLI Cheatsheet.md'

  it('resolves a same-folder relative link', () => {
    expect(resolveInternalNoteHref(from, 'Another Note.md', NOTES)).toEqual({
      path: 'Work/Documentation/Another Note.md',
      anchor: null
    })
  })

  it('resolves a `../` relative link', () => {
    expect(resolveInternalNoteHref(from, '../Projects/plan.md', NOTES)?.path).toBe(
      'Work/Projects/plan.md'
    )
  })

  it('resolves a vault-absolute (leading slash) link', () => {
    expect(resolveInternalNoteHref(from, '/index.md', NOTES)?.path).toBe('index.md')
  })

  it('decodes percent-encoded spaces (Obsidian Markdown-link style)', () => {
    expect(resolveInternalNoteHref(from, 'Another%20Note.md', NOTES)?.path).toBe(
      'Work/Documentation/Another Note.md'
    )
  })

  it('carries a #heading anchor', () => {
    expect(resolveInternalNoteHref(from, 'Another%20Note.md#My%20Heading', NOTES)).toEqual({
      path: 'Work/Documentation/Another Note.md',
      anchor: 'My Heading'
    })
  })

  it('carries an Obsidian #^block fragment raw, for the dispatcher to type (#601 review)', () => {
    expect(resolveInternalNoteHref(from, 'Another%20Note.md#^note-two', NOTES)).toEqual({
      path: 'Work/Documentation/Another Note.md',
      anchor: '^note-two'
    })
  })

  it('tolerates a missing .md extension', () => {
    expect(resolveInternalNoteHref(from, 'Another Note', NOTES)?.path).toBe(
      'Work/Documentation/Another Note.md'
    )
  })

  it('falls back to a unique basename match when the path is off', () => {
    // `plan.md` doesn't exist in this folder, but there's exactly one elsewhere.
    expect(resolveInternalNoteHref(from, 'plan.md', NOTES)?.path).toBe('Work/Projects/plan.md')
  })

  it('returns null for external and in-page links', () => {
    for (const href of [
      'https://example.com',
      'http://x.test/a.md',
      'mailto:a@b.com',
      '#heading',
      '//cdn.test/x'
    ]) {
      expect(resolveInternalNoteHref(from, href, NOTES), href).toBeNull()
    }
  })

  it('returns null when nothing matches (e.g. an asset or missing note)', () => {
    expect(resolveInternalNoteHref(from, 'diagram.png', NOTES)).toBeNull()
    expect(resolveInternalNoteHref(from, 'Nope.md', NOTES)).toBeNull()
  })

  it('never resolves to a trashed note', () => {
    expect(resolveInternalNoteHref(from, '../../Archive/old plan.md', NOTES)).toBeNull()
  })

  it('returns null when the path escapes the vault', () => {
    expect(resolveInternalNoteHref('index.md', '../secrets.md', NOTES)).toBeNull()
  })
})

describe('extractLinkAtCursor', () => {
  it('pulls a Markdown link url under the cursor', () => {
    const doc = 'see [the plan](Work/Projects/plan.md) here'
    expect(extractLinkAtCursor(doc, doc.indexOf('plan.md'))).toBe('Work/Projects/plan.md')
  })

  it('pulls a wikilink target under the cursor', () => {
    const doc = 'see [[Another Note]] here'
    expect(extractLinkAtCursor(doc, doc.indexOf('Another'))).toBe('Another Note')
  })

  it('unwraps an angle-bracketed url with spaces', () => {
    const doc = '[x](<a b.md>)'
    expect(extractLinkAtCursor(doc, 2)).toBe('a b.md')
  })

  it('returns null when not inside a link', () => {
    expect(extractLinkAtCursor('just text', 3)).toBeNull()
  })
})

describe('linkRangeAtCursor', () => {
  it('returns the target and source range of a Markdown link', () => {
    const doc = 'see [the plan](Work/Projects/plan.md) here'
    expect(linkRangeAtCursor(doc, doc.indexOf('plan.md'))).toEqual({
      target: 'Work/Projects/plan.md',
      from: 4,
      to: 4 + '[the plan](Work/Projects/plan.md)'.length
    })
  })

  it('returns doc offsets for a link on a later line', () => {
    const doc = 'first line\n2. courses on [[Another Note]] end'
    const at = linkRangeAtCursor(doc, doc.indexOf('Another'))
    expect(at).toEqual({
      target: 'Another Note',
      from: doc.indexOf('[[Another'),
      to: doc.indexOf(']]') + 2
    })
  })

  it('covers a bare url up to its last character, exclusive of line end', () => {
    const doc = 'ends with https://x.test/a'
    expect(linkRangeAtCursor(doc, doc.indexOf('https'))).toEqual({
      target: 'https://x.test/a',
      from: doc.indexOf('https'),
      to: doc.length
    })
    expect(linkRangeAtCursor(doc, doc.length)).toBeNull()
  })

  it('returns null when the offset is outside any link', () => {
    expect(linkRangeAtCursor('just text', 3)).toBeNull()
  })
})

describe('externalLinkUrl', () => {
  it('keeps explicit web/scheme URLs as-is', () => {
    expect(externalLinkUrl('https://google.com')).toBe('https://google.com')
    expect(externalLinkUrl('http://x.test/a')).toBe('http://x.test/a')
    expect(externalLinkUrl('mailto:a@b.com')).toBe('mailto:a@b.com')
  })

  it('promotes a bare domain a user typed without a scheme', () => {
    expect(externalLinkUrl('google.com')).toBe('https://google.com')
    expect(externalLinkUrl('www.example.com/path?q=1')).toBe('https://www.example.com/path?q=1')
  })

  it('is null for note links, relative paths, files and anchors', () => {
    for (const href of [
      'Another Note.md',
      'folder/Note.md',
      '../x.md',
      '/index.md',
      'image.png',
      'report.pdf',
      '#heading'
    ]) {
      expect(externalLinkUrl(href), href).toBeNull()
    }
  })
})

describe('markdownLinkAt', () => {
  it('returns the href and source range of the link under the cursor', () => {
    const doc = 'a [test](google.com) b'
    const at = markdownLinkAt(doc, doc.indexOf('test'))
    expect(at).toEqual({ href: 'google.com', from: 2, to: 2 + '[test](google.com)'.length })
  })

  it('returns null when the cursor is outside any link', () => {
    expect(markdownLinkAt('a [test](google.com) b', 0)).toBeNull()
  })
})

// #199: a markdown title after the destination is not part of the path.
describe('markdownLinkAt with a title', () => {
  it('drops the title from the href', () => {
    const doc = 'see ![chart](assets/chart.png "chart.png") here'
    expect(markdownLinkAt(doc, 8)?.href).toBe('assets/chart.png')
    expect(markdownLinkAt('[x](<a b.pdf> "t")', 2)?.href).toBe('a b.pdf')
  })
})
