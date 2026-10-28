import { describe, expect, it } from 'vitest'
import { rewriteAssetReferences } from './asset-link-rename'
import {
  formatNoteCoverY,
  noteCoverFieldKeys,
  parseNoteCoverTarget,
  parseNoteCoverY,
  readNoteCover,
  readNoteCoverLines,
  removeNoteCover,
  setNoteCover,
  setNoteCoverPosition
} from './note-cover'

describe('readNoteCover', () => {
  it('reads the embed and focal point the app writes', () => {
    const body = '---\ntitle: Lisbon\nbanner: "![[assets/lisbon.jpg]]"\nbanner_y: 0.35\n---\n# Lisbon\n'
    expect(readNoteCover(body)).toEqual({
      key: 'banner',
      target: { kind: 'vault', href: 'assets/lisbon.jpg' },
      y: 0.35
    })
  })

  it('reads every shape the Obsidian banner plugins accept', () => {
    const cases: Array<[string, ReturnType<typeof parseNoteCoverTarget>]> = [
      ['[[a.png]]', { kind: 'vault', href: 'a.png' }],
      ['![[a.png]]', { kind: 'vault', href: 'a.png' }],
      ['[[pics/a.png|300]]', { kind: 'vault', href: 'pics/a.png' }],
      ['![alt](pics/a.png)', { kind: 'vault', href: 'pics/a.png' }],
      ['![alt](<pics/a b.png>)', { kind: 'vault', href: 'pics/a b.png' }],
      ['pics/a.png', { kind: 'vault', href: 'pics/a.png' }],
      ['https://example.com/a.jpg', { kind: 'url', url: 'https://example.com/a.jpg' }],
      ['file:///tmp/a.png', null],
      ['', null]
    ]
    for (const [value, expected] of cases) expect(parseNoteCoverTarget(value)).toEqual(expected)
  })

  it('takes an unquoted wikilink, a single-quoted value and a trailing comment', () => {
    expect(readNoteCover('---\nbanner: [[a.png]]\n---\n')?.target).toEqual({ kind: 'vault', href: 'a.png' })
    expect(readNoteCover("---\nbanner: '[[it''s.png]]'\n---\n")?.target).toEqual({
      kind: 'vault',
      href: "it's.png"
    })
    expect(readNoteCover('---\nbanner: pics/a.png # the bridge\n---\n')?.target).toEqual({
      kind: 'vault',
      href: 'pics/a.png'
    })
    expect(readNoteCover('---\nbanner: "[[a #1.png]]"\n---\n')?.target).toEqual({
      kind: 'vault',
      href: 'a #1.png'
    })
  })

  it('falls back to `cover`, and prefers `banner` when both are present', () => {
    expect(readNoteCover('---\ncover: "[[c.png]]"\ncover_y: 20%\n---\n')).toEqual({
      key: 'cover',
      target: { kind: 'vault', href: 'c.png' },
      y: 0.2
    })
    expect(readNoteCover('---\ncover: "[[c.png]]"\nbanner: "[[b.png]]"\n---\n')?.key).toBe('banner')
  })

  it('is null without frontmatter, without the key, and for an indented key', () => {
    expect(readNoteCover('# banner: [[a.png]]\n')).toBeNull()
    expect(readNoteCover('---\ntitle: x\n---\n')).toBeNull()
    expect(readNoteCover('---\nmeta:\n  banner: "[[a.png]]"\n---\n')).toBeNull()
    expect(readNoteCover('---\nbanner:\n---\n')).toBeNull()
  })

  it('reads the focal point on every scale the plugins use', () => {
    expect(parseNoteCoverY(undefined)).toBe(0.5)
    expect(parseNoteCoverY('0.2')).toBe(0.2)
    expect(parseNoteCoverY('"75%"')).toBe(0.75)
    expect(parseNoteCoverY('30')).toBe(0.3)
    expect(parseNoteCoverY('-1')).toBe(0)
    expect(parseNoteCoverY('400')).toBe(1)
    expect(parseNoteCoverY('soon')).toBe(0.5)
    expect(readNoteCover('---\nbanner: a.png\nbanner-y: 0.9\n---\n')?.y).toBe(0.9)
  })
})

describe('editing the cover', () => {
  it('adds a frontmatter block to a note without one', () => {
    expect(setNoteCover('# Trip\n', { kind: 'vault', href: 'assets/a.png' })).toBe(
      '---\nbanner: "![[assets/a.png]]"\n---\n# Trip\n'
    )
  })

  it('changes the image in place, resets its position, and keeps every other line', () => {
    const body = '---\ntitle: Trip\nbanner: "[[old.png]]"\ntags:\n  - travel\nbanner_y: 0.8\n---\nBody\n'
    expect(setNoteCover(body, { kind: 'url', url: 'https://example.com/x.jpg' })).toBe(
      '---\ntitle: Trip\nbanner: "https://example.com/x.jpg"\ntags:\n  - travel\n---\nBody\n'
    )
  })

  it('keeps writing to `cover` when that is the key the note uses', () => {
    const body = '---\ncover: "[[old.png]]"\n---\n'
    expect(setNoteCover(body, { kind: 'vault', href: 'new.png' })).toBe('---\ncover: "![[new.png]]"\n---\n')
    expect(setNoteCoverPosition(body, 0.25)).toBe('---\ncover: "[[old.png]]"\ncover_y: 0.25\n---\n')
  })

  it('moves the focal point, rounding to a 1% step, and ignores a note without a cover', () => {
    const body = '---\nbanner: "[[a.png]]"\nbanner_y: 0.5\n---\n'
    expect(setNoteCoverPosition(body, 0.3333)).toBe('---\nbanner: "[[a.png]]"\nbanner_y: 0.33\n---\n')
    expect(setNoteCoverPosition('# none\n', 0.3)).toBe('# none\n')
    expect(formatNoteCoverY(2)).toBe('1')
  })

  it('removes the cover and its position, and a block left empty', () => {
    expect(removeNoteCover('---\nbanner: "[[a.png]]"\nbanner_y: 0.4\n---\n# Trip\n')).toBe('# Trip\n')
    expect(removeNoteCover('---\ntitle: Trip\nbanner: "[[a.png]]"\n---\nBody\n')).toBe(
      '---\ntitle: Trip\n---\nBody\n'
    )
    expect(removeNoteCover('# none\n')).toBe('# none\n')
  })

  it('round-trips: set, read back, remove', () => {
    const start = 'Plain note\n'
    const withCover = setNoteCoverPosition(setNoteCover(start, { kind: 'vault', href: 'x/y z.png' }), 0.1)
    expect(readNoteCover(withCover)).toEqual({ key: 'banner', target: { kind: 'vault', href: 'x/y z.png' }, y: 0.1 })
    expect(removeNoteCover(withCover)).toBe(start)
  })
})

describe('the credit under a cover', () => {
  const unsplash = 'https://images.unsplash.com/photo-1?ixid=abc&w=2400&q=80&auto=format'
  const credit = { name: 'Jane Doe', url: 'https://unsplash.com/@janedoe' }

  it('writes the name and link on the lines under the image', () => {
    const body = '---\ntitle: Trip\nbanner: "[[old.png]]"\ntags: [a]\n---\nBody\n'
    expect(setNoteCover(body, { kind: 'url', url: unsplash }, credit)).toBe(
      '---\ntitle: Trip\nbanner: "' +
        unsplash +
        '"\nbanner_credit: Jane Doe\nbanner_credit_url: "https://unsplash.com/@janedoe"\ntags: [a]\n---\nBody\n'
    )
  })

  it('reads it back, and leaves out a link that is not a web page', () => {
    const body = setNoteCover('# Trip\n', { kind: 'url', url: unsplash }, credit)
    expect(readNoteCover(body)).toEqual({ key: 'banner', target: { kind: 'url', url: unsplash }, y: 0.5, credit })
    expect(readNoteCover('---\nbanner: a.png\nbanner_credit: "Me: myself"\nbanner_credit_url: javascript:x\n---\n')?.credit).toEqual({
      name: 'Me: myself',
      url: null
    })
    expect(readNoteCover('---\nbanner: a.png\nbanner_credit: ""\n---\n')?.credit).toBeUndefined()
  })

  it('goes with the picture: a new image or a removed cover takes it away', () => {
    const body = setNoteCoverPosition(setNoteCover('# Trip\n', { kind: 'url', url: unsplash }, credit), 0.3)
    expect(setNoteCover(body, { kind: 'vault', href: 'assets/a.png' })).toBe('---\nbanner: "![[assets/a.png]]"\n---\n# Trip\n')
    expect(removeNoteCover(body)).toBe('# Trip\n')
  })

  it('follows the key the note uses', () => {
    const body = setNoteCover('---\ncover: "[[c.png]]"\n---\n', { kind: 'url', url: unsplash }, { name: 'A', url: null })
    expect(body).toBe('---\ncover: "' + unsplash + '"\ncover_credit: A\n---\n')
    expect(readNoteCover(body)?.credit).toEqual({ name: 'A', url: null })
  })
})

describe('a cover follows its file through an asset rename', () => {
  it('is rewritten by the same rewriter that updates embeds', () => {
    const body = '---\nbanner: "![[assets/old.png]]"\nbanner_y: 0.3\n---\n# Trip\n'
    const result = rewriteAssetReferences(
      body,
      [{ path: 'assets/old.png' }],
      'inbox/Trip.md',
      'assets/old.png',
      'assets/trip.png'
    )
    expect(result.changed).toBe(1)
    expect(readNoteCover(result.body)?.target).toEqual({ kind: 'vault', href: 'assets/trip.png' })
  })
})

describe('the lines a cover owns', () => {
  const unsplash = 'https://images.unsplash.com/photo-1?ixid=abc&w=2400&q=80&auto=format'

  it('names every key the cover writes, under the key the note uses', () => {
    expect(noteCoverFieldKeys('banner')).toEqual(['banner', 'banner_y', 'banner-y', 'banner_credit', 'banner_credit_url'])
    expect(noteCoverFieldKeys('cover')).toEqual(['cover', 'cover_y', 'cover-y', 'cover_credit', 'cover_credit_url'])
  })

  it('finds the image, focal point and credit lines, and none of the others', () => {
    const body =
      '---\ntags: [travel]\nbanner: "' +
      unsplash +
      '"\nbanner_credit: Kalen Emsley\nbanner_credit_url: "https://unsplash.com/@kalenemsley"\ndue: 2026-11-02\nbanner_y: 0.4\n---\n# Trip\n'
    const found = readNoteCoverLines(body)
    expect(found?.cover.credit?.name).toBe('Kalen Emsley')
    expect(found?.lines).toEqual([2, 3, 4, 6])
  })

  it('follows `cover:` and leaves a `banner` line it does not read alone', () => {
    expect(readNoteCoverLines('---\ncover: "[[c.png]]"\ncover_y: 0.2\nbanner_y: 0.9\n---\n')?.lines).toEqual([1, 2])
    // banner wins over cover, so the cover lines are the banner's.
    expect(readNoteCoverLines('---\ncover: "[[c.png]]"\nbanner: "[[b.png]]"\n---\n')?.lines).toEqual([2])
  })

  it('takes the lines a value runs on to, and only the first line of a repeated key', () => {
    const body = '---\nbanner: a.png\nbanner_credit: >-\n  Jane\n\n  Doe\n\ntitle: Trip\nbanner: b.png\n---\n'
    expect(readNoteCoverLines(body)?.lines).toEqual([1, 2, 3, 4, 5])
  })

  it('is null when there is no cover to show', () => {
    expect(readNoteCoverLines('# Trip\n')).toBeNull()
    expect(readNoteCoverLines('---\nbanner:\n---\n')).toBeNull()
    expect(readNoteCoverLines('---\nbanner: file:///x.png\nbanner_y: 0.2\n---\n')).toBeNull()
  })
})
