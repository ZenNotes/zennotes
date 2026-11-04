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

describe('rewriteAssetReferences with an escaped pipe', () => {
  it.each([
    ['a rename', '| ![[old.png\\|300]] |', 'assets/new.png', '| ![[new.png\\|300]] |', 1],
    ['a rooted path', '| ![[assets/old.png\\|300]] |', 'assets/new.png', '| ![[assets/new.png\\|300]] |', 1],
    ['a move', '| ![[assets/old.png\\|300]] |', 'media/old.png', '| ![[media/old.png\\|300]] |', 1],
    ['a bare name that still resolves', '| ![[old.png\\|300]] |', 'media/old.png', '| ![[old.png\\|300]] |', 0],
    ['a fragment', '| ![[old.png#page=2\\|300]] |', 'assets/new.png', '| ![[new.png#page=2\\|300]] |', 1],
    ['a plain link', '| [[old.png\\|the shot]] |', 'assets/new.png', '| [[new.png\\|the shot]] |', 1],
    ['an unescaped alias', '![[old.png|300]]', 'assets/new.png', '![[new.png|300]]', 1],
    ['code', '`![[old.png\\|300]]`', 'assets/new.png', '`![[old.png\\|300]]`', 0],
    ['another asset', '| ![[other.png\\|300]] |', 'assets/new.png', '| ![[other.png\\|300]] |', 0]
  ])('handles %s', (_name, body, newPath, want, changed) => {
    expect(rewrite(body, 'assets/old.png', newPath)).toEqual({ body: want, changed })
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

describe('a Markdown link whose file gains a space or a parenthesis', () => {
  const assets = [{ path: 'assets/report.pdf' }, { path: 'assets/other.pdf' }]
  const note = 'notes/n.md'
  const old = 'assets/report.pdf'

  it.each([
    ['a plain link gains brackets', '[x](../assets/report.pdf)\n', 'assets/new report.pdf', '[x](<../assets/new report.pdf>)\n'],
    ['a fragment stays inside them', '[x](../assets/report.pdf#page=3)\n', 'assets/new report.pdf', '[x](<../assets/new report.pdf#page=3>)\n'],
    ['a title stays outside them', '[x](../assets/report.pdf "T")\n', 'assets/new report.pdf', '[x](<../assets/new report.pdf> "T")\n'],
    ['an image too', '![x](../assets/report.pdf)\n', 'assets/new report.pdf', '![x](<../assets/new report.pdf>)\n'],
    ['parentheses need them too', '[x](../assets/report.pdf)\n', 'assets/report(1).pdf', '[x](<../assets/report(1).pdf>)\n'],
    ['a name without either stays plain', '[x](../assets/report.pdf)\n', 'assets/renamed.pdf', '[x](../assets/renamed.pdf)\n'],
    ['brackets already there stay', '[x](<../assets/report.pdf>)\n', 'assets/new report.pdf', '[x](<../assets/new report.pdf>)\n'],
    ['a bracket in a name cannot close them', '[x](<../assets/report.pdf>)\n', 'assets/a>b.pdf', '[x](<../assets/a%3Eb.pdf>)\n'],
    ['a wikilink never takes them', '![[assets/report.pdf]]\n', 'assets/new report.pdf', '![[assets/new report.pdf]]\n']
  ])('%s', (_name, body, next, want) => {
    expect(rewriteAssetReferences(body, assets, note, old, next).body).toBe(want)
  })

  it('stays encoded when it was, and the next rename finds it again', () => {
    expect(
      rewriteAssetReferences(
        '[x](../assets/my%20report.pdf)\n',
        [{ path: 'assets/my report.pdf' }],
        note,
        'assets/my report.pdf',
        'assets/new report.pdf'
      ).body
    ).toBe('[x](../assets/new%20report.pdf)\n')
    const first = rewriteAssetReferences('[x](../assets/report.pdf#page=3)\n', assets, note, old, 'assets/new report.pdf')
    const second = rewriteAssetReferences(
      first.body,
      [{ path: 'assets/new report.pdf' }],
      note,
      'assets/new report.pdf',
      'assets/final.pdf'
    )
    expect(second).toEqual({ body: '[x](<../assets/final.pdf#page=3>)\n', changed: 1 })
  })

  it('leaves a wikilink that names a note, when told the notes', () => {
    const assets = [{ path: 'Docs/Plan' }]
    const notes = [{ path: 'Plan.md', title: 'Plan', folder: 'inbox' }]
    const body = 'See [[Plan]] and [[Plan|the plan]] and ![[Docs/Plan]].\n'
    expect(rewriteAssetReferences(body, assets, 'N.md', 'Docs/Plan', 'Docs/Other', { notes }).body).toBe(
      'See [[Plan]] and [[Plan|the plan]] and ![[Docs/Other]].\n'
    )
    expect(rewriteAssetReferences(body, assets, 'N.md', 'Docs/Plan', 'Docs/Other').changed).toBe(3)
  })

  it('writes the whole path when asked, however unique the bare name is', () => {
    const assets = [{ path: 'assets/a.png' }]
    const body = '![[a.png]]\n'
    expect(rewriteAssetReferences(body, assets, 'N.md', 'assets/a.png', 'assets/b.png').body).toBe('![[b.png]]\n')
    expect(
      rewriteAssetReferences(body, assets, 'N.md', 'assets/a.png', 'assets/b.png', { fullPath: true }).body
    ).toBe('![[assets/b.png]]\n')
  })

  it('reads through an anchor when it asks whether a wikilink names a note', () => {
    const assets = [{ path: 'Docs/Report' }]
    const notes = [{ path: 'Report.md', title: 'Report', folder: 'inbox' }]
    const body = '[[Report#Heading]] [[Report^block]] [[Report|alias]]\n'
    expect(rewriteAssetReferences(body, assets, 'N.md', 'Docs/Report', 'Docs/Renamed', { notes }).body).toBe(body)
  })

  it('says when a wikilink cannot hold the new path', () => {
    const assets = [{ path: 'assets/a.png' }, { path: 'Other/a.png' }]
    const body = '![[assets/a.png]] ![x](assets/a.png)\n'
    const out = rewriteAssetReferences(body, assets, 'N.md', 'assets/a.png', 'Issue #5/a.png')
    expect(out.stranded).toBe(true)
    expect(out.body).toBe('![[assets/a.png]] ![x](<Issue %235/a.png>)\n')
  })

  it('uses a bare name in a wikilink where that resolves', () => {
    const out = rewriteAssetReferences('![[assets/a.png]]\n', [{ path: 'assets/a.png' }], 'N.md', 'assets/a.png', 'a?b/a.png')
    expect(out).toEqual({ body: '![[a.png]]\n', changed: 1 })
  })

  it('cannot use a bare name that holds link syntax itself', () => {
    const out = rewriteAssetReferences('![[a.png]]\n', [{ path: 'a.png' }], 'N.md', 'a.png', 'x#y.png')
    expect(out).toMatchObject({ body: '![[a.png]]\n', stranded: true })
  })
})
