import { describe, expect, it } from 'vitest'
import {
  externalLinkUrl,
  externalUrlForLink,
  linkRangeAtCursor,
  linkRangesInLine,
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

describe('linkRangeAtCursor', () => {
  it('unwraps an angle-bracketed url with spaces', () => {
    expect(linkRangeAtCursor('[x](<a b.md>)', 2)?.target).toBe('a b.md')
  })

  it('returns the target and source range of a Markdown link', () => {
    const doc = 'see [the plan](Work/Projects/plan.md) here'
    expect(linkRangeAtCursor(doc, doc.indexOf('plan.md'))).toEqual({
      kind: 'markdown',
      target: 'Work/Projects/plan.md',
      from: 4,
      to: 4 + '[the plan](Work/Projects/plan.md)'.length
    })
  })

  it('returns doc offsets for a link on a later line', () => {
    const doc = 'first line\n2. courses on [[Another Note]] end'
    const at = linkRangeAtCursor(doc, doc.indexOf('Another'))
    expect(at).toEqual({
      kind: 'wikilink',
      target: 'Another Note',
      from: doc.indexOf('[[Another'),
      to: doc.indexOf(']]') + 2
    })
  })

  it('covers a bare url up to its last character, exclusive of line end', () => {
    const doc = 'ends with https://x.test/a'
    expect(linkRangeAtCursor(doc, doc.indexOf('https'))).toEqual({
      kind: 'url',
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

// A wikilink names a note. Read as an href, `[[2024.01.15]]` passed the
// bare-domain guess and `gd`, Cmd-click on its source, `gy` and the table
// cells sent it to https://2024.01.15.
describe('externalUrlForLink', () => {
  it('never reads a wikilink name as a bare domain', () => {
    for (const name of ['2024.01.15', 'v1.2', 'notes.v2', 'google.com', '2024.01.15#Agenda']) {
      expect(externalUrlForLink(name, 'wikilink'), name).toBeNull()
    }
  })

  it('still sends a wikilink written with a scheme to the browser', () => {
    expect(externalUrlForLink('https://example.net', 'wikilink')).toBe('https://example.net')
    expect(externalUrlForLink(' mailto:a@b.com ', 'wikilink')).toBe('mailto:a@b.com')
  })

  it('reads a Markdown href and a bare URL as externalLinkUrl does (#201)', () => {
    expect(externalUrlForLink('google.com', 'markdown')).toBe('https://google.com')
    expect(externalUrlForLink('https://x.test/a', 'url')).toBe('https://x.test/a')
    expect(externalUrlForLink('Note.md', 'markdown')).toBeNull()
  })

  it('pairs with the kind linkRangeAtCursor reports', () => {
    const doc = 'see [[example.com]] and [site](example.com)'
    const wikilink = linkRangeAtCursor(doc, doc.indexOf('example'))!
    const markdown = linkRangeAtCursor(doc, doc.indexOf('[site]'))!
    expect(externalUrlForLink(wikilink.target, wikilink.kind)).toBeNull()
    expect(externalUrlForLink(markdown.target, markdown.kind)).toBe('https://example.com')
  })
})

describe('markdownLinkAt', () => {
  it.each(['[EE]', '[ordinary text]', '[label][missing]', '[missing][]'])(
    'does not treat undefined bracket text as a click or keyboard link: %s',
    (brackets) => {
      const doc = `Ask ${brackets} for details.`
      const pos = doc.indexOf(brackets) + 1
      expect(markdownLinkAt(doc, pos)).toBeNull()
      expect(linkRangeAtCursor(doc, pos)).toBeNull()
    }
  )

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

// #894: hint mode labels every link in the Edit view, so it needs them all at
// once, with the targets a click or `gd` on each would follow.
describe('linkRangesInLine', () => {
  it('lists each link shape in reading order, with its kind, target and span', () => {
    const line =
      'see https://example.net and [[Plan#Goals|the plan]], [GitHub](https://github.com) ' +
      'and ![diagram](assets/d.png) or [a b](<my file.md>)'
    const links = linkRangesInLine(line)

    expect(links.map(({ kind, target }) => ({ kind, target }))).toEqual([
      { kind: 'url', target: 'https://example.net' },
      { kind: 'wikilink', target: 'Plan#Goals' },
      { kind: 'markdown', target: 'https://github.com' },
      { kind: 'markdown', target: 'assets/d.png' },
      { kind: 'markdown', target: 'my file.md' }
    ])
    expect(line.slice(links[1].from, links[1].to)).toBe('[[Plan#Goals|the plan]]')
    expect(line.slice(links[2].from, links[2].to)).toBe('[GitHub](https://github.com)')
  })

  it('does not list the URL inside a Markdown link or a wikilink as a link of its own', () => {
    expect(linkRangesInLine('[GitHub](https://github.com)')).toHaveLength(1)
    expect(linkRangesInLine('[[https://example.net]]')).toEqual([
      { kind: 'wikilink', target: 'https://example.net', from: 0, to: 23 }
    ])
  })

  it('agrees with linkRangeAtCursor on every link it lists', () => {
    const line = 'a [[Note|alias]] b [t](<x y.md> "title") c ![i](img.png "t") d http://x.test/a)'
    for (const link of linkRangesInLine(line)) {
      for (let col = link.from; col < link.to; col++) {
        expect(linkRangeAtCursor(line, col), `col ${col}`).toEqual({
          kind: link.kind,
          target: link.target,
          from: link.from,
          to: link.to
        })
      }
    }
  })

  it('finds nothing in bracket text that is not a link', () => {
    expect(linkRangesInLine('Ask [EE] or [label][missing] for details.')).toEqual([])
  })
})

describe('linkRangeAtCursor with an escaped pipe', () => {
  it('follows the note a table link names, not its backslash', () => {
    const doc = '| [[Note\\|see]] | x |'
    expect(linkRangeAtCursor(doc, doc.indexOf('Note'))).toEqual({
      kind: 'wikilink',
      target: 'Note',
      from: doc.indexOf('[['),
      to: doc.indexOf(']]') + 2
    })
  })
  it('leaves an unescaped alias as it was', () => {
    expect(linkRangeAtCursor('[[Note|see]]', 3)?.target).toBe('Note')
  })
})
