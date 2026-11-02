import { describe, expect, it } from 'vitest'
import { blocksHaveTodos, renderBlocks } from './blocks'
import { planNotionPaths, safeNotionName } from './plan-paths'
import type { NotionIssueKind, NotionRenderContext } from './render-context'
import { escapeMarkdownText, richTextToMarkdown } from './rich-text'
import { notionIdFromHref, type NotionBlock, type NotionRichText } from './types'

function text(content: string, annotations: NotionRichText['annotations'] = {}, href?: string): NotionRichText {
  return {
    type: 'text',
    plain_text: content,
    href: href ?? null,
    annotations,
    text: { content, link: href ? { url: href } : null }
  }
}

function block(type: string, data: Record<string, unknown> = {}, children?: NotionBlock[]): NotionBlock {
  return { id: `${type}-id`, type, [type]: data, children, has_children: !!children }
}

const para = (content: string, children?: NotionBlock[]): NotionBlock =>
  block('paragraph', { rich_text: [text(content)] }, children)
const bullet = (content: string, children?: NotionBlock[]): NotionBlock =>
  block('bulleted_list_item', { rich_text: [text(content)] }, children)
const numbered = (content: string, children?: NotionBlock[]): NotionBlock =>
  block('numbered_list_item', { rich_text: [text(content)] }, children)

function makeContext(overrides: Partial<NotionRenderContext> = {}) {
  const issues: Array<{ kind: NotionIssueKind; detail: string }> = []
  const ctx: NotionRenderContext = {
    resolvePage: () => null,
    resolveDatabase: () => [],
    assetFor: () => null,
    issue: (kind, detail) => issues.push({ kind, detail }),
    ...overrides
  }
  return { ctx, issues }
}

const render = (blocks: NotionBlock[], overrides?: Partial<NotionRenderContext>): string =>
  renderBlocks(blocks, makeContext(overrides).ctx)

describe('escapeMarkdownText', () => {
  it('stops prices becoming math and words becoming tags', () => {
    expect(escapeMarkdownText('$5 and $6')).toBe('\\$5 and \\$6')
    expect(escapeMarkdownText('see #work now')).toBe('see \\#work now')
    expect(escapeMarkdownText('issue#12')).toBe('issue#12')
  })

  it('leaves snake_case alone but escapes emphasis-shaped underscores', () => {
    expect(escapeMarkdownText('snake_case_name')).toBe('snake_case_name')
    expect(escapeMarkdownText('_loud_')).toBe('\\_loud\\_')
  })

  it('escapes link, code and HTML openers', () => {
    expect(escapeMarkdownText('[x](y) `z` <div> a < b')).toBe('[x\\](y) \\`z\\` \\<div> a < b')
    expect(escapeMarkdownText('[[not a link]]')).toBe('\\[\\[not a link]]')
    expect(escapeMarkdownText('[!note] and [^1]')).toBe('\\[!note] and \\[^1]')
  })

  it('leaves alone what would not mean anything, since the editor shows a backslash', () => {
    for (const plain of ['It costs $5', 'a lone ` tick', 'see [1] and [x]', '2 * 3', 'C:\\Users\\me', 'a < b']) {
      expect(escapeMarkdownText(plain)).toBe(plain)
    }
  })

  it('keeps a real emphasis marker from opening', () => {
    expect(escapeMarkdownText('*loud* words')).toBe('\\*loud\\* words')
  })
})

describe('richTextToMarkdown', () => {
  it('keeps whitespace outside emphasis markers', () => {
    const { ctx } = makeContext()
    expect(richTextToMarkdown([text('bold ', { bold: true }), text('next')], ctx)).toBe('**bold** next')
  })

  it('merges runs Notion split where an edit landed', () => {
    const { ctx } = makeContext()
    expect(richTextToMarkdown([text('a', { bold: true }), text('b', { bold: true })], ctx)).toBe('**ab**')
  })

  it('gives each line of a hard break its own markers', () => {
    const { ctx } = makeContext()
    expect(richTextToMarkdown([text('one\ntwo', { italic: true })], ctx)).toBe('*one*  \n*two*')
  })

  it('does not escape inside code, and widens the fence around backticks', () => {
    const { ctx } = makeContext()
    expect(richTextToMarkdown([text('a*b', { code: true })], ctx)).toBe('`a*b`')
    expect(richTextToMarkdown([text('a`b', { code: true })], ctx)).toBe('``a`b``')
  })

  it('turns internal links into wikilinks and leaves outside links alone', () => {
    const id = 'c0ffee00c0ffee00c0ffee00c0ffee00'
    const { ctx } = makeContext({
      resolvePage: (page) => (page === id ? { target: 'Notion Import/Work/Plan', title: 'Plan' } : null)
    })
    expect(richTextToMarkdown([text('the plan', {}, `/${id}`)], ctx)).toBe('[[Notion Import/Work/Plan|the plan]]')
    expect(richTextToMarkdown([text('site', {}, 'https://example.com/a')], ctx)).toBe('[site](https://example.com/a)')
  })

  it('reports an internal link it cannot resolve, and keeps the link', () => {
    const { ctx, issues } = makeContext()
    const href = 'https://www.notion.so/Secret-c0ffee00c0ffee00c0ffee00c0ffee00'
    expect(richTextToMarkdown([text('gone', {}, href)], ctx)).toBe(`[gone](${href})`)
    expect(issues.map((issue) => issue.kind)).toEqual(['unresolved-link'])
  })

  it('escapes table pipes, including the one in a wikilink alias', () => {
    const id = 'c0ffee00c0ffee00c0ffee00c0ffee00'
    const { ctx } = makeContext({ resolvePage: () => ({ target: 'A/B', title: 'B' }) })
    expect(richTextToMarkdown([text('a|b')], ctx, { table: true })).toBe('a\\|b')
    expect(richTextToMarkdown([text('b', {}, `/${id}`)], ctx, { table: true })).toBe('[[A/B\\|b]]')
  })
})

describe('notionIdFromHref', () => {
  const id = 'c0ffee00c0ffee00c0ffee00c0ffee00'

  it('reads every form Notion prints', () => {
    expect(notionIdFromHref(`/${id}`)).toBe(id)
    expect(notionIdFromHref(`/${id}#abc`)).toBe(id)
    expect(notionIdFromHref(`https://www.notion.so/My-Page-${id}`)).toBe(id)
    expect(notionIdFromHref(`https://app.notion.com/p/${id}?pvs=204`)).toBe(id)
    expect(notionIdFromHref(`https://acme.notion.site/${id}`)).toBe(id)
  })

  it('ignores links to anywhere else', () => {
    expect(notionIdFromHref(`https://example.com/${id}`)).toBeNull()
    expect(notionIdFromHref('/short')).toBeNull()
    expect(notionIdFromHref('not a url')).toBeNull()
  })
})

describe('renderBlocks', () => {
  it('escapes text that would open a block', () => {
    expect(render([para('# not a heading'), para('1. not a list'), para('> not a quote')])).toBe(
      '\\# not a heading\n\n1\\. not a list\n\n\\> not a quote'
    )
    expect(render([bullet('[ ] not a task')])).toBe('- \\[ ] not a task')
  })

  it('keeps a list tight, numbers it, and nests children', () => {
    expect(render([bullet('a', [bullet('b')]), bullet('c')])).toBe('- a\n  - b\n- c')
    expect(render([numbered('a', [numbered('b')]), numbered('c')])).toBe('1. a\n   1. b\n2. c')
  })

  it('restarts numbering after anything else, and honors a start index', () => {
    expect(render([numbered('a'), para('x'), numbered('b')])).toBe('1. a\n\nx\n\n1. b')
    const start = block('numbered_list_item', { rich_text: [text('a')], list_start_index: 5 })
    expect(render([start, numbered('b')])).toBe('5. a\n6. b')
  })

  it('separates a bullet list from a numbered list', () => {
    expect(render([bullet('a'), numbered('b')])).toBe('- a\n\n1. b')
  })

  it('keeps a paragraph under a list item out of the item text', () => {
    expect(render([bullet('a', [para('b')])])).toBe('- a\n\n  b')
  })

  it('writes to-dos as task lines', () => {
    const todo = (content: string, checked: boolean): NotionBlock =>
      block('to_do', { rich_text: [text(content)], checked })
    expect(render([todo('a', false), todo('b', true)])).toBe('- [ ] a\n- [x] b')
    expect(blocksHaveTodos([bullet('x', [todo('y', false)])])).toBe(true)
    expect(blocksHaveTodos([bullet('x')])).toBe(false)
  })

  it('flattens a paragraph child rather than indenting it into a code block', () => {
    expect(render([para('a', [para('b')])])).toBe('a\n\nb')
  })

  it('makes a toggle a collapsed foldable callout', () => {
    const toggle = block('toggle', { rich_text: [text('More')] }, [para('inside'), bullet('x')])
    expect(render([toggle])).toBe('> [!note]- More\n> inside\n>\n> - x')
  })

  it('types a callout by its emoji, and keeps an emoji it has no type for', () => {
    const callout = (emoji: string): NotionBlock =>
      block('callout', { rich_text: [text('hi')], icon: { type: 'emoji', emoji } })
    expect(render([callout('💡')])).toBe('> [!tip]\n> hi')
    expect(render([callout('🚀')])).toBe('> [!note]\n> 🚀 hi')
  })

  it('keeps toggle heading content under its heading', () => {
    const heading = block('heading_2', { rich_text: [text('Title')], is_toggleable: true }, [para('body')])
    expect(render([heading])).toBe('## Title\n\nbody')
  })

  it('fences code with a mapped language, wide enough for its contents', () => {
    const code = (language: string, content: string): NotionBlock =>
      block('code', { language, rich_text: [text(content)], caption: [] })
    expect(render([code('plain text', 'x')])).toBe('```\nx\n```')
    expect(render([code('c++', 'x')])).toBe('```cpp\nx\n```')
    expect(render([code('markdown', '```\ninner\n```')])).toBe('````markdown\n```\ninner\n```\n````')
  })

  it('writes block equations as display math', () => {
    expect(render([block('equation', { expression: 'x^2' })])).toBe('$$\nx^2\n$$')
  })

  it('embeds a downloaded image and links other files', () => {
    const assetFor = () => ({ path: 'Notion Import/assets/a b.png', name: 'a b.png' })
    expect(render([block('image', { type: 'file', file: { url: 'u' } })], { assetFor })).toBe(
      '![[Notion Import/assets/a b.png]]'
    )
    const zip = () => ({ path: 'Notion Import/assets/a b.zip', name: 'a b.zip' })
    expect(render([block('file', { type: 'file', file: { url: 'u' } })], { assetFor: zip })).toBe(
      '[a b.zip](<Notion Import/assets/a b.zip>)'
    )
  })

  it('reports a file it could not download instead of losing it silently', () => {
    const { ctx, issues } = makeContext()
    const out = renderBlocks([block('pdf', { type: 'file', file: { url: 'u' }, caption: [text('Deed')] })], ctx)
    expect(out).toContain('[!warning]')
    expect(out).toContain('Deed')
    expect(issues[0].kind).toBe('file-missing')
  })

  it('embeds video hosts and bookmarks everything else', () => {
    expect(render([block('video', { type: 'external', external: { url: 'https://youtu.be/x' }, caption: [] })])).toBe(
      '```embed\nhttps://youtu.be/x\n```'
    )
    expect(render([block('bookmark', { url: 'https://a.io', caption: [] })])).toBe('```bookmark\nhttps://a.io\n```')
    expect(render([block('embed', { url: 'https://figma.com/x' })])).toBe('```bookmark\nhttps://figma.com/x\n```')
  })

  it('leads a headerless table with its first row', () => {
    const row = (...cells: string[]): NotionBlock =>
      block('table_row', { cells: cells.map((cell) => [text(cell)]) })
    const table = block('table', { has_column_header: false }, [row('a', 'b'), row('c', 'd|e')])
    expect(render([table])).toBe('| a | b |\n| --- | --- |\n| c | d\\|e |')
  })

  it('flattens columns and synced blocks', () => {
    const columns = block('column_list', {}, [block('column', {}, [para('a')]), block('column', {}, [para('b')])])
    expect(render([columns, block('synced_block', {}, [para('c')])])).toBe('a\n\nb\n\nc')
  })

  it('links subpages and databases where they sat in the page', () => {
    const out = render(
      [block('child_page', { title: 'Sub' }), block('child_database', { title: 'DB' })],
      {
        resolvePage: () => ({ target: 'A/Sub', title: 'Sub' }),
        resolveDatabase: () => [{ target: 'DB', title: 'DB' }]
      }
    )
    expect(out).toBe('[[A/Sub|Sub]]\n\n[[DB]]')
  })

  it('leaves a placeholder and a report entry for what the API cannot read', () => {
    const { ctx, issues } = makeContext()
    const out = renderBlocks(
      [
        block('child_database', { title: 'Linked' }),
        block('unsupported', { block_type: 'form' }),
        block('some_new_block', {}, [para('kept')])
      ],
      ctx
    )
    expect(out).toContain('Linked database "Linked"')
    expect(out).toContain('A form block')
    expect(out).toContain('kept')
    expect(issues.map((issue) => issue.kind)).toEqual(['linked-database', 'unsupported-block', 'unknown-block'])
  })

  it('drops the blocks Notion draws from the page itself', () => {
    expect(render([block('table_of_contents'), block('breadcrumb'), para('a')])).toBe('a')
  })
})

describe('safeNotionName', () => {
  it('removes what a filesystem or a wikilink cannot hold', () => {
    expect(safeNotionName('C# notes')).toBe('C- notes')
    expect(safeNotionName('a/b: c?')).toBe('a-b- c-')
    expect(safeNotionName('Q1 | [Plan]')).toBe('Q1 - -Plan-')
  })

  it('keeps a note visible and off the reserved list', () => {
    expect(safeNotionName('.env')).toBe('env')
    expect(safeNotionName('NUL')).toBe('NUL-')
    expect(safeNotionName('   ')).toBe('Untitled')
    expect(safeNotionName('trailing. ')).toBe('trailing')
  })

  it('never lets a page folder pose as a database folder', () => {
    expect(safeNotionName('Knowledge.base')).toBe('Knowledge base')
  })

  it('cuts a long title on a code point', () => {
    const name = safeNotionName('🚀'.repeat(150))
    expect(Array.from(name)).toHaveLength(100)
    expect(name.endsWith('🚀')).toBe(true)
  })
})

describe('planNotionPaths', () => {
  const page = (id: string, title: string, parentId: string | null = null) =>
    ({ id, kind: 'page', title, parentId }) as const
  const database = (id: string, title: string, parentId: string | null = null) =>
    ({ id, kind: 'database', title, parentId }) as const
  const row = (id: string, title: string, parentId: string) =>
    ({ id, kind: 'page', title, parentId, isRow: true }) as const
  const pathOf = (plan: ReturnType<typeof planNotionPaths>, id: string) => plan.get(id)?.path

  it('nests subpages in a folder named for their parent', () => {
    const plan = planNotionPaths([page('a', 'Work'), page('b', 'Plan', 'a')])
    expect(pathOf(plan, 'a')).toBe('Work.md')
    expect(pathOf(plan, 'b')).toBe('Work/Plan.md')
  })

  it('keeps two pages with one title apart, whatever their case', () => {
    const plan = planNotionPaths([page('a', 'Work'), page('b', 'work'), page('c', 'One', 'b')])
    expect(pathOf(plan, 'a')).toBe('Work.md')
    expect(pathOf(plan, 'b')).toBe('work 2.md')
    expect(pathOf(plan, 'c')).toBe('work 2/One.md')
  })

  it('does not count a numbered duplicate as a rename, but does a sanitized title', () => {
    const plan = planNotionPaths([page('a', 'Work'), page('b', 'Work'), page('c', 'C# notes')])
    expect(plan.get('b')?.renamed).toBe(false)
    expect(plan.get('c')?.renamed).toBe(true)
  })

  it('treats a parent the token cannot see as the top level', () => {
    const plan = planNotionPaths([page('a', 'Orphan', 'hidden')])
    expect(pathOf(plan, 'a')).toBe('Orphan.md')
  })

  it('reserves the names the import itself writes', () => {
    const plan = planNotionPaths([page('a', 'assets'), page('b', 'Import Report')])
    expect(pathOf(plan, 'a')).toBe('assets 2.md')
    expect(pathOf(plan, 'b')).toBe('Import Report 2.md')
  })

  it('puts rows in the database pages folder, and their subpages under them', () => {
    const plan = planNotionPaths([
      page('p', 'Cool Stuff'),
      database('d', 'Links', 'p'),
      row('r', 'First', 'd'),
      page('s', 'Notes', 'r')
    ])
    expect(pathOf(plan, 'd')).toBe('Cool Stuff/Links.base')
    expect(pathOf(plan, 'r')).toBe('Cool Stuff/Links.base/pages/First.md')
    expect(pathOf(plan, 's')).toBe('Cool Stuff/Links.base/pages/First/Notes.md')
  })

  it('moves a database inside a record page out of the .base folder', () => {
    const plan = planNotionPaths([
      page('p', 'Top'),
      database('d', 'Outer', 'p'),
      row('r', 'Row', 'd'),
      database('n', 'Inner', 'r')
    ])
    expect(pathOf(plan, 'n')).toBe('Top/Inner.base')
  })

  it('keeps database titles unique across the import, since links resolve by title', () => {
    const plan = planNotionPaths([
      page('a', 'A'),
      page('b', 'B'),
      database('d1', 'Tasks', 'a'),
      database('d2', 'Tasks', 'b')
    ])
    expect(pathOf(plan, 'd1')).toBe('A/Tasks.base')
    expect(pathOf(plan, 'd2')).toBe('B/Tasks 2.base')
  })

  it('survives a parent cycle without losing either page', () => {
    const plan = planNotionPaths([page('a', 'A', 'b'), page('b', 'B', 'a')])
    expect(plan.size).toBe(2)
  })
})
