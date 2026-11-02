import { describe, expect, it } from 'vitest'
import { blocksHaveTodos, renderBlocks } from './blocks'
import { parseCellText, parseInline, parseNotionMarkdown } from './nfm'
import type { NotionRenderContext } from './render-context'
import { plainText, type NotionBlock } from './types'

let n = 0
const parse = (text: string, references?: Record<string, string>): NotionBlock[] =>
  parseNotionMarkdown(text, { nextId: () => `id-${++n}`, references })

const ctx: NotionRenderContext = {
  resolvePage: (id) => ({ target: `Import/${id.slice(0, 4)}`, title: 'Page' }),
  resolveDatabase: () => [{ target: 'DB', title: 'DB' }],
  assetFor: (key) => (key.startsWith('block-') ? { path: 'Import/assets/a.png', name: 'a.png' } : null),
  issue: () => undefined
}
const md = (text: string, references?: Record<string, string>): string =>
  renderBlocks(parse(text, references), ctx)

const PAGE = 'https://app.notion.com/p/c0ffee00c0ffee00c0ffee00c0ffee00'

describe('parseInline', () => {
  const inline = (text: string): string =>
    renderBlocks([{ id: 'x', type: 'paragraph', paragraph: { rich_text: parseInline(text) } }], ctx)

  it('reads Notion inline tags as marks', () => {
    expect(inline('<b>bold</b> and <i>it</i> and <s>gone</s>')).toBe('**bold** and *it* and ~~gone~~')
  })

  it('keeps space inside a tag outside the markers', () => {
    expect(inline('<b>in short, </b>next')).toBe('**in short,** next')
  })

  it('lets a comment span pass its text through', () => {
    const span = '<span discussion-urls="discussion://1/2/3">it is</span>'
    expect(inline(`<b>${span}</b> fine`)).toBe('**it is** fine')
  })

  it('reads nested tags', () => {
    expect(inline('<span color="orange"><u>word</u></span>')).toBe('word')
    expect(inline('<b><i>both</i></b>')).toBe('***both***')
  })

  it('reads a code tag literally', () => {
    expect(inline('<code>command 2>&1</code>: to <code><file></code>')).toBe('`command 2>&1`: to `<file>`')
    expect(inline('<b><code>a*b</code></b>')).toBe('**`a*b`**')
  })

  it('reads links, code, and Markdown marks', () => {
    expect(inline('[a](https://x.io/b_(c)) `c*d` **e** ~~f~~')).toBe('[a](<https://x.io/b_(c)>) `c*d` **e** ~~f~~')
  })

  it('reads a backslash escape as its literal character', () => {
    expect(plainText(parseInline('1\\.\tTitle \\* star'))).toBe('1.\tTitle * star')
  })

  it('reads inline math but leaves prices', () => {
    expect(parseInline('$x^2$ ok').map((part) => part.type)).toEqual(['equation', 'text'])
    expect(plainText(parseInline('costs $5 and then $6 more'))).toBe('costs $5 and then $6 more')
  })

  it('decodes entities', () => {
    expect(plainText(parseInline('a &amp; b &lt;c&gt;'))).toBe('a & b <c>')
  })

  it('turns a page mention into a link to the page', () => {
    expect(inline(`see <mention url="${PAGE}">First draft</mention>`)).toBe('see [[Import/c0ff|First draft]]')
  })

  it('reads a user mention and a date', () => {
    expect(plainText(parseInline('<mention url="user://abc">Sam</mention>'))).toBe('@Sam')
    expect(inline('<date start="2026-01-02" end="2026-01-05" />')).toBe('2026-01-02 to 2026-01-05')
    expect(inline('<date start="2026-01-02" start-time="09:30" />')).toBe('2026-01-02 09:30')
  })

  it('reads a line break tag', () => {
    expect(plainText(parseInline('windows key<br />second'))).toBe('windows key\nsecond')
  })

  it('leaves an unclosed tag as text', () => {
    expect(plainText(parseInline('a <b>never closed'))).toBe('a <b>never closed')
  })
})

describe('parseNotionMarkdown', () => {
  it('reads paragraphs, wrapped paragraphs and spacers', () => {
    expect(md('one\n\n<p />\n\n<p>\nHello there! \n</p>\n\ntwo')).toBe('one\n\nHello there!\n\ntwo')
  })

  it('reads headings in both forms, and drops bold from them', () => {
    expect(md('## Start\n\n<h2>\nTopics \n</h2>')).toBe('## Start\n\n## Topics')
    expect(md('## <b>A "Quoted" Title </b>')).toBe('## A "Quoted" Title')
  })

  it('reads lists, their nesting, and to-dos', () => {
    expect(md('- a\n\t- b\n- c')).toBe('- a\n  - b\n- c')
    expect(md('1. x\n2. y')).toBe('1. x\n2. y')
    expect(md('- [ ] open\n- [x] done')).toBe('- [ ] open\n- [x] done')
  })

  it('reads tag lists', () => {
    expect(md('<ul>\n<li>\nitem 1\n</li>\n<li>\nitem 2 \n</li>\n</ul>')).toBe('- item 1\n- item 2')
    expect(md('<ol>\n<li>\none\n</li>\n<li>\ntwo\n</li>\n</ol>')).toBe('1. one\n2. two')
  })

  it('takes a toggle title from its body, and the rest as children', () => {
    expect(md('<toggle>\nSome things\n\n- One\n- Two\n</toggle>')).toBe(
      '> [!note]- Some things\n> - One\n> - Two'
    )
  })

  it('reads a toggle heading as a heading with its content under it', () => {
    expect(md('<toggle heading="h2">\nTitle\n\nbody\n</toggle>')).toBe('## Title\n\nbody')
  })

  it('reads a callout with its icon', () => {
    expect(md('<callout icon="💡" color="yellow_bg">\nA tip\n</callout>')).toBe('> [!tip]\n> A tip')
  })

  it('reads quotes in both forms', () => {
    expect(md('> said')).toBe('> said')
    expect(md('<quote color="purple_bg">\nTitle\n\n- child\n</quote>')).toBe('> Title\n>\n> - child')
  })

  it('never reads a tag inside a code fence', () => {
    const fence = '```go\n</toggle>\n<b>not bold</b>\n```'
    expect(md(`<toggle>\nCode\n\n${fence}\n</toggle>`)).toBe(
      '> [!note]- Code\n> ```go\n> </toggle>\n> <b>not bold</b>\n> ```'
    )
  })

  it('keeps a fenced fence intact', () => {
    expect(md('````md\n```\ninner\n```\n````')).toBe('````md\n```\ninner\n```\n````')
  })

  it('maps subpages and databases by their id', () => {
    const blocks = parse(`<page url="${PAGE}">\nFirst draft\n</page>`)
    expect(blocks[0].type).toBe('child_page')
    expect(blocks[0].id).toBe('c0ffee00c0ffee00c0ffee00c0ffee00')
    const db = parse('<database url="https://app.notion.com/p/dabadaba00004000800000000000000d" data-source-url="collection://x" inline="true"></database>')
    expect(db[0].type).toBe('child_database')
    expect(db[0].id).toBe('dabadaba00004000800000000000000d')
    expect(db[0].has_children).toBe(false)
  })

  it('flattens columns', () => {
    const text = '<columns>\n<column ratio="50">\n<h2>\nLeft\n</h2>\n\nx\n</column>\n<column ratio="50">\n## Right\n</column>\n</columns>'
    expect(md(text)).toBe('## Left\n\nx\n\n## Right')
  })

  it('reads a Notion-hosted image with its signed link, under its own block id', () => {
    const source =
      'notion-file-block://f11ef11e-0000-4000-8000-000000000001/dba0ba46?space_id=s&name=Screen%20Shot.png'
    const blocks = parse(`<image source="${source}" />`, { [source]: 'https://s3.example/signed' })
    const image = blocks[0].image as { type: string; file: { url: string }; name: string; source: string }
    expect(blocks[0].id).toBe('f11ef11e-0000-4000-8000-000000000001')
    expect(image.type).toBe('file')
    expect(image.file.url).toBe('https://s3.example/signed')
    expect(image.name).toBe('Screen Shot.png')
    expect(image.source).toBe(source)
  })

  it('reads an outside image, with a caption, in both forms', () => {
    expect((parse('![Cap](https://x.io/a.png)')[0].image as { type: string }).type).toBe('external')
    const tagged = parse('<image source="https://x.io/a.png">My caption</image>')[0]
    expect(plainText((tagged.image as { caption: never[] }).caption)).toBe('My caption')
  })

  it('decodes a bookmark link', () => {
    expect(md('<bookmark source="https://example.com/watch?v=1&amp;t=2s" />')).toBe(
      '```bookmark\nhttps://example.com/watch?v=1&t=2s\n```'
    )
  })

  it('reads pipe tables, including an escaped pipe', () => {
    expect(md('| a | b\\|c |\n| --- | --- |\n| 1 | **2** |')).toBe('| a | b\\|c |\n| --- | --- |\n| 1 | **2** |')
  })

  it('reads a styled table', () => {
    const text = '<table header-row="true">\n<tr>\n<th>H</th>\n<td color="blue_bg">I</td>\n</tr>\n<tr>\n<td>1</td>\n<td>2</td>\n</tr>\n</table>'
    expect(md(text)).toBe('| H | I |\n| --- | --- |\n| 1 | 2 |')
  })

  it('reads equations in both forms', () => {
    expect(md('$$\nE = mc^2\n$$')).toBe('$$\nE = mc^2\n$$')
    expect(md('<equation>x + y</equation>')).toBe('$$\nx + y\n$$')
  })

  it('reads a divider and drops the contents marker', () => {
    expect(md('---\n\n<table-of-contents />\n\nend')).toBe('---\n\nend')
  })

  it('keeps a synced block and its reference inline', () => {
    expect(md('<synced-block url="u">\nkept\n</synced-block>')).toBe('kept')
    expect(md('<synced-block-reference url="u">\ncopy\n</synced-block-reference>')).toBe('copy')
  })

  it('leaves a placeholder for a block it does not know', () => {
    expect(md('<custom-block definition-id="d" url="u" />')).toContain('A custom-block block')
  })

  it('finds to-dos nested in tags', () => {
    expect(blocksHaveTodos(parse('<toggle>\nT\n\n- [ ] nested\n</toggle>'))).toBe(true)
  })

  it('reads real page shapes without losing a line', () => {
    const text = [
      'A list:',
      '',
      '- First thing',
      '- Second thing',
      '',
      '<p />',
      '',
      `<page url="${PAGE}">`,
      'First draft',
      '</page>',
      '',
      '<b>in short, </b><b><span discussion-urls="discussion://a">it is</span></b><span discussion-urls="discussion://a"> the idea</span>. More.',
      '',
      '1\\.\t<b>Heavy Word</b>: a note',
      '',
      '•\tA bullet someone typed'
    ].join('\n')
    expect(md(text)).toBe(
      [
        'A list:',
        '',
        '- First thing',
        '- Second thing',
        '',
        '[[Import/c0ff|First draft]]',
        '',
        '**in short, it is** the idea. More.',
        '',
        '1\\.\t**Heavy Word**: a note',
        '',
        '•\tA bullet someone typed'
      ].join('\n')
    )
  })
})

describe('parseCellText', () => {
  it('unwraps a title cell', () => {
    expect(plainText(parseCellText('<p>\nSome Tool (Beta) \n</p>'))).toBe('Some Tool (Beta)')
    expect(plainText(parseCellText('plain name'))).toBe('plain name')
  })
})
