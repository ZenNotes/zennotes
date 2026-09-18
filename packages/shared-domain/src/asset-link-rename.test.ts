import { describe, expect, it } from 'vitest'
import { rewriteAssetReferences } from './asset-link-rename'

const assets = [
  { path: 'assets/old.png' },
  { path: 'assets/other.png' },
  { path: 'assets/old name.png' },
  { path: 'docs/manual.pdf' },
  { path: 'assets/dup.png' },
  { path: 'docs/dup.png' }
]

const note = 'inbox/Daily/2026-09-15.md'

function rewrite(body: string, oldPath = 'assets/old.png', newPath = 'assets/new.png') {
  return rewriteAssetReferences(body, assets, note, oldPath, newPath)
}

describe('rewriteAssetReferences on rename (#785)', () => {
  it('rewrites the vault-relative embed the paste flow writes', () => {
    expect(rewrite('Shot: ![[assets/old.png]]\n')).toEqual({
      body: 'Shot: ![[assets/new.png]]\n',
      changed: 1
    })
  })

  it('keeps size hints, aliases, fragments and the plain (non-embed) wikilink form', () => {
    const body = '![[assets/old.png|300]] [[assets/old.png|the shot]] [[/assets/old.png#top]]'
    expect(rewrite(body).body).toBe(
      '![[assets/new.png|300]] [[assets/new.png|the shot]] [[/assets/new.png#top]]'
    )
  })

  it('rewrites markdown images and links, keeping titles and note-relative paths', () => {
    const body = [
      '![alt](assets/old.png "Title")',
      '[open](../../assets/old.png)',
      '[page two](/assets/old.png#page=2)'
    ].join('\n')
    expect(rewrite(body).body).toBe(
      [
        '![alt](assets/new.png "Title")',
        '[open](../../assets/new.png)',
        '[page two](/assets/new.png#page=2)'
      ].join('\n')
    )
  })

  it('keeps the author\'s percent-encoding and angle brackets around spaced names', () => {
    const body = '![](assets/old%20name.png) ![](<assets/old name.png>) ![[assets/old name.png]]'
    const out = rewrite(body, 'assets/old name.png', 'assets/new name.png')
    expect(out.body).toBe(
      '![](assets/new%20name.png) ![](<assets/new name.png>) ![[assets/new name.png]]'
    )
    expect(out.changed).toBe(3)
  })

  it('rewrites both hrefs of an image nested inside a link to itself', () => {
    expect(rewrite('[![shot](assets/old.png)](assets/old.png)').body).toBe(
      '[![shot](assets/new.png)](assets/new.png)'
    )
  })

  it('follows a bare basename only while it is unique in the vault', () => {
    expect(rewrite('![[old.png]] ![](old.png)').body).toBe('![[new.png]] ![](new.png)')
    // Two `dup.png` files: the link was already ambiguous, so it is left alone.
    expect(rewrite('![[dup.png]]', 'assets/dup.png', 'assets/renamed.png')).toEqual({
      body: '![[dup.png]]',
      changed: 0
    })
  })

  it('leaves code, other assets, notes, and URLs untouched', () => {
    const body = [
      '`![[assets/old.png]]` and `[x](assets/old.png)`',
      '```',
      '![[assets/old.png]]',
      '```',
      '~~~md',
      '![](assets/old.png)',
      '~~~',
      '![[assets/other.png]] [[Old Note]] [[docs/manual.pdf]]',
      '[web](https://example.com/assets/old.png) ![](//cdn/assets/old.png)'
    ].join('\n')
    expect(rewrite(body)).toEqual({ body, changed: 0 })
  })

  it('does nothing when the name did not change', () => {
    const body = '![[assets/old.png]]'
    expect(rewrite(body, 'assets/old.png', 'assets/old.png')).toEqual({ body, changed: 0 })
  })

  it('handles a case-only rename', () => {
    expect(rewrite('![[assets/old.png]]', 'assets/old.png', 'assets/OLD.png').body).toBe(
      '![[assets/OLD.png]]'
    )
  })
})

describe('rewriteAssetReferences on move (#785 follow-up)', () => {
  const move = (body: string, oldPath = 'assets/old.png', newPath = 'media/shots/old.png') =>
    rewriteAssetReferences(body, assets, note, oldPath, newPath)

  it('re-roots vault-root wikilinks and hrefs, keeping a spelled-out leading slash', () => {
    expect(move('![[assets/old.png]] [[assets/old.png|the shot]] [p](/assets/old.png#page=2)').body).toBe(
      '![[media/shots/old.png]] [[media/shots/old.png|the shot]] [p](/media/shots/old.png#page=2)'
    )
  })

  it('keeps a note-relative href relative to the note', () => {
    // The note sits in inbox/Daily/, so the new location is reached the same way.
    expect(move('[open](../../assets/old.png "Title")').body).toBe('[open](../../media/shots/old.png "Title")')
    // A note at the vault root writes the plain path either way.
    expect(rewriteAssetReferences('![](assets/old.png)', assets, 'Root.md', 'assets/old.png', 'media/old.png').body).toBe(
      '![](media/old.png)'
    )
    // Moving into the note\'s own folder yields a bare relative name.
    expect(rewriteAssetReferences('![](../../assets/old.png)', assets, note, 'assets/old.png', 'inbox/Daily/old.png').body).toBe(
      '![](old.png)'
    )
  })

  it('leaves a bare file name bare while it still names one asset', () => {
    expect(move('![[old.png]] ![](old.png)')).toEqual({ body: '![[old.png]] ![](old.png)', changed: 0 })
  })

  it('spells out the path when the bare name would become ambiguous', () => {
    // Moving old.png into docs/ as dup.png collides with docs/dup.png\'s twin assets/dup.png.
    expect(move('![[old.png]] ![[assets/old.png]]', 'assets/old.png', 'docs/dup.png').body).toBe(
      '![[docs/dup.png]] ![[docs/dup.png]]'
    )
    // Same for a rename that lands on a name another folder already uses.
    expect(move('![[old.png]]', 'assets/old.png', 'assets/dup.png').body).toBe('![[assets/dup.png]]')
  })

  it('moves an asset that sat next to its note: hrefs go relative, wikilinks stay bare or go vault-root', () => {
    const local = [{ path: 'inbox/pic.png' }, { path: 'inbox/sub/chart.png' }, { path: 'assets/other.png' }]
    const body = '![[pic.png]] ![alt](pic.png) [[inbox/pic.png|the pic]] ![[assets/other.png]]'
    expect(rewriteAssetReferences(body, local, 'inbox/Pics.md', 'inbox/pic.png', 'media/shots/pic.png').body).toBe(
      '![[pic.png]] ![alt](../media/shots/pic.png) [[media/shots/pic.png|the pic]] ![[assets/other.png]]'
    )
    // A wikilink with a note-relative folder in it becomes a vault-root path, never `../`.
    expect(rewriteAssetReferences('![[sub/chart.png]] ![](sub/chart.png)', local, 'inbox/Pics.md', 'inbox/sub/chart.png', 'media/chart.png').body).toBe(
      '![[media/chart.png]] ![](../media/chart.png)'
    )
    // A bare wikilink whose name stops being unique spells out the path instead.
    expect(rewriteAssetReferences('![[pic.png]]', local, 'inbox/Pics.md', 'inbox/pic.png', 'assets/other.png').body).toBe(
      '![[assets/other.png]]'
    )
  })

  it('keeps encoding, angle brackets and code untouched across a move', () => {
    const out = rewriteAssetReferences(
      '![](assets/old%20name.png) ![](<assets/old name.png>) `![[assets/old name.png]]`',
      assets,
      note,
      'assets/old name.png',
      'media/new name.png'
    )
    expect(out).toEqual({
      body: '![](media/new%20name.png) ![](<media/new name.png>) `![[assets/old name.png]]`',
      changed: 2
    })
  })
})
