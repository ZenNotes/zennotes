import { describe, expect, it } from 'vitest'
import { extractBlock } from '../block-anchors'
import { parseTasksFromBody } from '../tasks'
import { DEFAULT_LOGSEQ_CONFIG, formatLogseqDate, parseLogseqConfig, parseLogseqDate } from './config'
import {
  logseqTag,
  logseqTitleFromFileName,
  planLogseqImport,
  safeNoteName,
  type LogseqGraph,
  type LogseqImportOptions,
  type LogseqSourceFile
} from './convert'
import { parseLogseqPage } from './outline'

const ID = '6512a3b4-1c2d-4e5f-8a9b-0c1d2e3f4a5b'
const ID2 = '65a00000-0000-4000-8000-00000000beef'

function graph(parts: Partial<LogseqGraph> & { pages?: LogseqSourceFile[] }): LogseqGraph {
  return {
    config: parts.config ?? { ...DEFAULT_LOGSEQ_CONFIG, fileNameFormat: 'triple-lowbar' },
    pages: parts.pages ?? [],
    journals: parts.journals ?? [],
    orgFiles: parts.orgFiles ?? [],
    assets: parts.assets ?? []
  }
}

function plan(parts: Partial<LogseqGraph>, options: Partial<LogseqImportOptions> = {}) {
  return planLogseqImport(graph(parts), { folder: 'Logseq', existingNotes: [], ...options })
}

const page = (name: string, text: string): LogseqSourceFile => ({ rel: `pages/${name}.md`, text })
const bodyOf = (result: ReturnType<typeof plan>, path: string): string => {
  const note = result.notes.find((n) => n.path === path)
  if (!note) throw new Error(`no note at ${path}: ${result.notes.map((n) => n.path).join(', ')}`)
  return note.body
}
const tasksOf = (body: string) => parseTasksFromBody(body, { path: 'x.md', title: 'x', folder: 'inbox' })

describe('config.edn', () => {
  it('falls back to Logseq defaults', () => {
    expect(parseLogseqConfig(null)).toEqual(DEFAULT_LOGSEQ_CONFIG)
    expect(parseLogseqConfig('{:meta/version 1}')).toEqual(DEFAULT_LOGSEQ_CONFIG)
  })

  it('reads the three keys and ignores commented ones', () => {
    const config = parseLogseqConfig(`{:meta/version 1
 ;; :journal/file-name-format "yyyy-MM-dd"
 :journal/file-name-format "yyyy.MM.dd" ; trailing comment
 :journal/page-title-format "EEEE, dd.MM.yyyy"
 :file/name-format :triple-lowbar
 :default-templates {:journals ";; not a comment"}}`)
    expect(config).toEqual({
      fileNameFormat: 'triple-lowbar',
      journalFileFormat: 'yyyy.MM.dd',
      journalTitleFormat: 'EEEE, dd.MM.yyyy'
    })
  })
})

describe('date patterns', () => {
  it('formats the way Logseq titles journals', () => {
    expect(formatLogseqDate('2024-01-01', 'MMM do, yyyy')).toBe('Jan 1st, 2024')
    expect(formatLogseqDate('2024-01-02', 'MMM do, yyyy')).toBe('Jan 2nd, 2024')
    expect(formatLogseqDate('2024-01-03', 'MMM do, yyyy')).toBe('Jan 3rd, 2024')
    expect(formatLogseqDate('2024-01-11', 'MMM do, yyyy')).toBe('Jan 11th, 2024')
    expect(formatLogseqDate('2024-01-22', 'MMM do, yyyy')).toBe('Jan 22nd, 2024')
    expect(formatLogseqDate('2024-01-15', 'EEEE, dd.MM.yyyy')).toBe('Monday, 15.01.2024')
    expect(formatLogseqDate('2024-03-05', "yyyy 'week' M/d")).toBe('2024 week 3/5')
  })

  it('parses file names and titles back into dates', () => {
    expect(parseLogseqDate('2024_01_15', 'yyyy_MM_dd')).toBe('2024-01-15')
    expect(parseLogseqDate('Jan 15th, 2024', 'MMM do, yyyy')).toBe('2024-01-15')
    expect(parseLogseqDate('january 5th, 2024', 'MMMM do, yyyy')).toBe('2024-01-05')
    expect(parseLogseqDate('Monday, 15.01.2024', 'EEEE, dd.MM.yyyy')).toBe('2024-01-15')
    expect(parseLogseqDate('2024_02_30', 'yyyy_MM_dd')).toBeNull()
    expect(parseLogseqDate('Meeting notes', 'yyyy_MM_dd')).toBeNull()
  })
})

describe('page names', () => {
  it('reads namespaces in both file name formats', () => {
    expect(logseqTitleFromFileName('Projects___ZenNotes', 'triple-lowbar')).toBe('Projects/ZenNotes')
    expect(logseqTitleFromFileName('What%3F___Why', 'triple-lowbar')).toBe('What?/Why')
    expect(logseqTitleFromFileName('Projects%2FZenNotes', 'legacy')).toBe('Projects/ZenNotes')
    expect(logseqTitleFromFileName('Projects.ZenNotes', 'legacy')).toBe('Projects/ZenNotes')
    expect(logseqTitleFromFileName('v1.2 notes', 'triple-lowbar')).toBe('v1.2 notes')
  })

  it('makes names every file system takes', () => {
    expect(safeNoteName('Q&A: why? [draft]')).toBe('Q&A- why- -draft-')
    expect(safeNoteName('  .hidden  ')).toBe('hidden')
    expect(safeNoteName('trailing.')).toBe('trailing')
    expect(safeNoteName('###')).toBe('---')
    expect(safeNoteName('')).toBe('Untitled')
  })

  it('turns page names into tags', () => {
    expect(logseqTag('side project')).toBe('side-project')
    expect(logseqTag('#[[two  words]]')).toBe('two-words')
  })
})

describe('outline', () => {
  it('nests tab and space indented blocks and keeps continuation lines with their block', () => {
    const tabs = parseLogseqPage('- one\n  more of one\n\t- two\n\t  more of two\n\t\t- three\n- four\n')
    expect(tabs.blocks.map((b) => b.lines)).toEqual([['one', 'more of one'], ['four']])
    expect(tabs.blocks[0].children[0].lines).toEqual(['two', 'more of two'])
    expect(tabs.blocks[0].children[0].children[0].lines).toEqual(['three'])
    const spaces = parseLogseqPage('- one\n  - two\n    - three\n  - two b\n')
    expect(spaces.blocks[0].children.map((b) => b.lines[0])).toEqual(['two', 'two b'])
    expect(spaces.blocks[0].children[0].children[0].lines[0]).toBe('three')
  })

  it('does not read a dash inside a code fence as a block', () => {
    const parsed = parseLogseqPage('- code\n  ```yaml\n  - not a block\n  ```\n- next\n')
    expect(parsed.blocks).toHaveLength(2)
    expect(parsed.blocks[0].lines).toEqual(['code', '```yaml', '- not a block', '```'])
  })

  it('reads page properties written above the blocks or as the first block', () => {
    expect(parseLogseqPage('title:: A\ntags:: x\n\n- body\n').properties).toEqual([
      { key: 'title', value: 'A' },
      { key: 'tags', value: 'x' }
    ])
    const old = parseLogseqPage('- title:: A\n  alias:: B\n- body\n')
    expect(old.properties.map((p) => p.key)).toEqual(['title', 'alias'])
    expect(old.blocks.map((b) => b.lines[0])).toEqual(['body'])
  })

  it('takes task markers, priorities, dates and time logs off a block', () => {
    const [block] = parseLogseqPage(
      '- LATER [#B] Call Sam\n  SCHEDULED: <2024-01-15 Mon 10:00 .+1d>\n  DEADLINE: <2024-01-20 Sat>\n  :LOGBOOK:\n  CLOCK: [2024-01-15 Mon 10:00]\n  :END:\n  id:: abc\n'
    ).blocks
    expect(block.marker).toBe('LATER')
    expect(block.priority).toBe('B')
    expect(block.scheduled).toEqual({ date: '2024-01-15', repeat: '.+1d' })
    expect(block.deadline).toEqual({ date: '2024-01-20' })
    expect(block.logbooks).toBe(1)
    expect(block.lines).toEqual(['Call Sam', 'id:: abc'])
    expect(block.properties).toEqual([{ key: 'id', value: 'abc' }])
  })
})

describe('converting pages', () => {
  it('reads childless top-level blocks as prose and keeps nesting as a list', () => {
    const result = plan({
      pages: [page('Notes', '- First thought.\n- Second thought\n  over two lines.\n- Parent\n\t- child\n\t\t- grandchild\n- Last one.\n')]
    })
    expect(bodyOf(result, 'Logseq/Notes.md')).toBe(
      'First thought.\n\nSecond thought\nover two lines.\n\n- Parent\n  - child\n    - grandchild\n\nLast one.\n'
    )
  })

  it('keeps every block a bullet when asked', () => {
    const result = plan({ pages: [page('Notes', '- First\n- ## Head\n\t- child\n')] }, { bullets: true })
    expect(bodyOf(result, 'Logseq/Notes.md')).toBe('- First\n- ## Head\n  - child\n')
  })

  it('makes a top-level heading block a heading, with its children under it', () => {
    const result = plan({
      pages: [page('Doc', '- # Title\n\t- Intro text.\n\t- Point\n\t\t- detail\n- Section\n  heading:: 2\n\t- More.\n')]
    })
    expect(bodyOf(result, 'Logseq/Doc.md')).toBe(
      '# Title\n\nIntro text.\n\n- Point\n  - detail\n\n## Section\n\nMore.\n'
    )
  })

  it('numbers blocks Logseq numbers', () => {
    const result = plan({
      pages: [
        page(
          'Steps',
          '- First\n  logseq.order-list-type:: number\n- Second\n  logseq.order-list-type:: number\n\t- sub\n'
        )
      ]
    })
    expect(bodyOf(result, 'Logseq/Steps.md')).toBe('1. First\n2. Second\n   - sub\n')
  })

  it('turns page properties into frontmatter and drops Logseq bookkeeping', () => {
    const result = plan({
      pages: [
        page(
          'Book',
          'title:: The Book: Second Edition\ntype:: [[Reading]]\ntags:: books, [[to read]], #fiction\nalias:: TB, Book 2\nfilters:: {"x" true}\nicon:: 📚\n\n- Quote\n  collapsed:: true\n  rating:: 5\n'
        )
      ]
    })
    const note = result.notes[0]
    expect(note.title).toBe('The Book: Second Edition')
    expect(note.path).toBe('Logseq/The Book- Second Edition.md')
    expect(note.body).toBe(
      '---\ntitle: "The Book: Second Edition"\ntype: "[[Reading]]"\ntags: [books, to-read, fiction]\naliases: [TB, Book 2]\n---\n\nQuote\nrating:: 5\n'
    )
  })

  it('writes the full title when the file name had to change it', () => {
    const result = plan({ pages: [page('What%3F', '- body\n')] })
    expect(result.notes[0].path).toBe('Logseq/What-.md')
    expect(result.notes[0].body).toBe('---\ntitle: What?\n---\n\nbody\n')
  })

  it('puts namespace pages in folders and keeps an empty page', () => {
    const result = plan({
      pages: [page('Projects', ''), page('Projects___ZenNotes', '- a\n'), page('Projects___ZenNotes___Import', '-\n')]
    })
    expect(result.notes.map((n) => n.path)).toEqual([
      'Logseq/Projects.md',
      'Logseq/Projects/ZenNotes.md',
      'Logseq/Projects/ZenNotes/Import.md'
    ])
    expect(bodyOf(result, 'Logseq/Projects/ZenNotes/Import.md')).toBe('\n')
  })

  it('never gives two pages one file, and leaves the report its name', () => {
    const result = plan({ pages: [page('a', 'title:: Same\n'), page('b', 'title:: same\n'), page('Import Report', '- x\n')] })
    expect(result.notes.map((n) => n.path)).toEqual(['Logseq/Same.md', 'Logseq/same 2.md', 'Logseq/Import Report 2.md'])
  })
})

describe('links and tags', () => {
  it('keeps a link that already finds its note and pins one that would not', () => {
    const result = plan(
      {
        pages: [
          page('Home', '- [[Alpha]] [[alpha]] [[Projects/Beta]] [[Gamma]] [[Missing page]] [label]([[Alpha]])\n'),
          page('Alpha', ''),
          page('Projects___Beta', ''),
          page('Gamma', '')
        ]
      },
      { existingNotes: ['inbox/Gamma.md'] }
    )
    expect(bodyOf(result, 'Logseq/Home.md')).toBe(
      '[[Alpha]] [[alpha]] [[Beta|Projects/Beta]] [[Logseq/Gamma|Gamma]] [[Missing page]] [[Alpha|label]]\n'
    )
  })

  it('follows aliases to their page', () => {
    const result = plan({ pages: [page('Home', '- [[ZN]]\n'), page('ZenNotes', 'alias:: ZN, zen\n')] })
    expect(bodyOf(result, 'Logseq/Home.md')).toBe('[[ZenNotes|ZN]]\n')
  })

  it('turns Logseq tags into ZenNotes tags', () => {
    const result = plan({ pages: [page('Home', '- #idea and #[[big idea]] and #[[x/y]]\n')] })
    expect(bodyOf(result, 'Logseq/Home.md')).toBe('#idea and #big-idea and #x/y\n')
  })

  it('leaves code alone', () => {
    const text = '- `[[not a link]]` and ((' + ID + '))\n- ```\n  [[nor this]] {{query x}}\n  ```\n'
    const result = plan({ pages: [page('Code', text)] })
    expect(bodyOf(result, 'Logseq/Code.md')).toBe(
      '`[[not a link]]` and ((' + ID + '))\n\n```\n[[nor this]] {{query x}}\n```\n'
    )
    expect(result.stats.verbatim.query.count).toBe(0)
    expect(result.stats.missingBlockRefs).toBe(1)
  })

  it('turns ^^highlights^^ into ==highlights==', () => {
    const result = plan({ pages: [page('H', '- a ^^marked^^ word\n')] })
    expect(bodyOf(result, 'Logseq/H.md')).toBe('a ==marked== word\n')
  })
})

describe('block references and embeds', () => {
  const pages = [
    page('Source', `- The original idea\n  id:: ${ID}\n\t- with a child\n- Unreferenced\n  id:: ${ID2}\n`),
    page(
      'Uses',
      `- See ((${ID})) here\n- [my words](((${ID})))\n- {{embed ((${ID}))}}\n- {{embed [[Source]]}}\n- gone ((00000000-0000-4000-8000-000000000000))\n`
    )
  ]

  it('anchors the referenced block and links to it', () => {
    const result = plan({ pages })
    const source = bodyOf(result, 'Logseq/Source.md')
    expect(source).toBe(`- The original idea ^${ID}\n  - with a child\n\nUnreferenced\n`)
    expect(extractBlock(source, ID)).toBe('- The original idea\n  - with a child')
    expect(bodyOf(result, 'Logseq/Uses.md')).toBe(
      `See [[Source^${ID}|The original idea]] here\n\n[[Source^${ID}|my words]]\n\n![[Source^${ID}]]\n\n![[Source]]\n\ngone ((00000000-0000-4000-8000-000000000000))\n`
    )
    expect(result.stats).toMatchObject({ blockRefs: 3, embeds: 2, missingBlockRefs: 1 })
    expect(result.report.body).toContain("1 block reference points at a block that isn't in the graph")
  })
})

describe('tasks', () => {
  it('writes every Logseq task the way the task parser reads it', () => {
    const result = plan({
      pages: [
        page(
          'Tasks',
          [
            '- TODO [#A] Plan',
            '  DEADLINE: <2024-01-20 Sat>',
            '- LATER Later [#C] one',
            '  SCHEDULED: <2024-01-15 Mon .+1w>',
            '- NOW Doing it',
            '- DOING Also doing',
            '- DONE Done one',
            '  SCHEDULED: <2024-01-10 Wed ++1d>',
            '- CANCELED Dropped',
            '- CANCELLED Dropped too',
            '- WAITING [#B] On Sam',
            '  SCHEDULED: <2024-01-11 Thu>',
            '  DEADLINE: <2024-01-12 Fri>',
            '- Not a task',
            '  SCHEDULED: <2024-02-01 Thu>',
            '\t- TODO nested',
            ''
          ].join('\n')
        )
      ]
    })
    const body = bodyOf(result, 'Logseq/Tasks.md')
    expect(body).toBe(
      [
        '- [ ] Plan !high due:2024-01-20',
        '- [ ] Later one !low due:2024-01-15 @repeat:after-1w',
        '- [/] Doing it',
        '- [/] Also doing',
        '- [x] Done one due:2024-01-10',
        '- [-] Dropped',
        '- [-] Dropped too',
        '- [ ] On Sam !med @waiting due:2024-01-12 @scheduled:2024-01-11',
        '- Not a task',
        '  Scheduled: 2024-02-01',
        '  - [ ] nested',
        ''
      ].join('\n')
    )
    const tasks = tasksOf(body)
    expect(tasks.map((t) => [t.content, t.checked, t.inProgress, t.cancelled, t.due ?? null, t.priority ?? null, t.waiting])).toEqual([
      ['Plan', false, false, false, '2024-01-20', 'high', false],
      ['Later one', false, false, false, '2024-01-15', 'low', false],
      ['Doing it', false, true, false, null, null, false],
      ['Also doing', false, true, false, null, null, false],
      ['Done one', true, false, false, '2024-01-10', null, false],
      ['Dropped', false, false, true, null, null, false],
      ['Dropped too', false, false, true, null, null, false],
      ['On Sam', false, false, false, '2024-01-12', 'med', true],
      ['nested', false, false, false, null, null, false]
    ])
    expect(tasks[1].fields?.repeat).toBe('after-1w')
    expect(tasks[7].fields?.scheduled).toBe('2024-01-11')
  })

  it('keeps imported tasks out of Tasks when asked', () => {
    const result = plan({ pages: [page('T', '- TODO x\n'), page('P', '- prose\n')] }, { includeTasks: false })
    expect(bodyOf(result, 'Logseq/T.md')).toBe('---\ntasks: false\n---\n\n- [ ] x\n')
    expect(bodyOf(result, 'Logseq/P.md')).toBe('prose\n')
    expect(tasksOf(bodyOf(result, 'Logseq/T.md'))).toEqual([])
  })
})

describe('journals', () => {
  const journals = [
    { rel: 'journals/2024_01_15.md', text: '- Met [[Sam]]\n' },
    { rel: 'journals/2024_01_16.md', text: '- Back to [[Jan 15th, 2024]]\n' },
    { rel: 'journals/notes.md', text: '- not a date\n' }
  ]

  it('become daily notes where the vault keeps them, and links to them follow', () => {
    const result = plan(
      { journals, pages: [page('Sam', '- [[Jan 16th, 2024]]\n')] },
      { journalPath: (date) => `Daily Notes/${date}.md` }
    )
    expect(result.notes.map((n) => [n.path, n.kind, n.outside])).toEqual([
      ['Daily Notes/2024-01-15.md', 'journal', true],
      ['Daily Notes/2024-01-16.md', 'journal', true],
      ['Logseq/Sam.md', 'page', false],
      ['Logseq/notes.md', 'page', false]
    ])
    expect(bodyOf(result, 'Daily Notes/2024-01-16.md')).toBe('Back to [[2024-01-15|Jan 15th, 2024]]\n')
    expect(bodyOf(result, 'Logseq/Sam.md')).toBe('[[2024-01-16|Jan 16th, 2024]]\n')
    expect(result.stats).toMatchObject({ journals: 2, journalsInDailyNotes: 2, pages: 2 })
  })

  it('stay in the import folder when the day already has a daily note', () => {
    const result = plan(
      { journals: journals.slice(0, 2) },
      {
        journalPath: (date) => (date === '2024-01-15' ? null : `Daily Notes/${date}.md`),
        takenJournalDates: ['2024-01-15'],
        existingNotes: ['Daily Notes/2024-01-15.md']
      }
    )
    expect(result.notes.map((n) => n.path)).toEqual(['Logseq/Journals/2024-01-15.md', 'Daily Notes/2024-01-16.md'])
    // The vault's own 2024-01-15 shares the name, so the link is pinned.
    expect(bodyOf(result, 'Daily Notes/2024-01-16.md')).toBe(
      'Back to [[Logseq/Journals/2024-01-15|Jan 15th, 2024]]\n'
    )
    expect(result.report.body).toContain('## Journals kept here')
    expect(result.report.body).toContain('[[Logseq/Journals/2024-01-15|Jan 15th, 2024]]')
  })

  it('read the file name format from config.edn', () => {
    const result = plan(
      {
        config: parseLogseqConfig(':journal/file-name-format "yyyy-MM-dd"\n:journal/page-title-format "yyyy-MM-dd"'),
        journals: [{ rel: 'journals/2024-03-01.md', text: '- hi\n' }]
      },
      { journalPath: (date) => `Daily/${date}.md` }
    )
    expect(result.notes[0]).toMatchObject({ path: 'Daily/2024-03-01.md', title: '2024-03-01', date: '2024-03-01' })
  })
})

describe('assets', () => {
  it('copies files into the import folder and rewrites links from wherever the note lands', () => {
    const result = plan(
      {
        assets: ['assets/shot_1.png', 'assets/My Doc.pdf', 'draws/2024-01-15-10-00-00.excalidraw'],
        pages: [page('Projects___Pics', '- ![shot](../assets/shot_1.png){:height 200, :width 300}\n- [doc](../assets/My%20Doc.pdf)\n- [[draws/2024-01-15-10-00-00.excalidraw]]\n- ![web](https://example.com/a.png){:width 10}\n')],
        journals: [{ rel: 'journals/2024_01_15.md', text: '- ![shot](../assets/shot_1.png)\n' }]
      },
      { journalPath: (date) => `Daily Notes/2024/${date}.md` }
    )
    expect(result.assets).toEqual([
      { source: 'assets/shot_1.png', path: 'Logseq/assets/shot_1.png' },
      { source: 'assets/My Doc.pdf', path: 'Logseq/assets/My Doc.pdf' },
      { source: 'draws/2024-01-15-10-00-00.excalidraw', path: 'Logseq/draws/2024-01-15-10-00-00.excalidraw' }
    ])
    expect(bodyOf(result, 'Logseq/Projects/Pics.md')).toBe(
      '![shot|300x200](../assets/shot_1.png)\n\n[doc](<../assets/My Doc.pdf>)\n\n![[Logseq/draws/2024-01-15-10-00-00.excalidraw]]\n\n![web|10](https://example.com/a.png)\n'
    )
    expect(bodyOf(result, 'Daily Notes/2024/2024-01-15.md')).toBe('![shot](../../Logseq/assets/shot_1.png)\n')
  })
})

describe('what ZenNotes has nothing for', () => {
  it('keeps queries, macros and Org blocks as written, and counts them', () => {
    const result = plan({
      pages: [
        page(
          'Dash',
          [
            '- {{query (and (task TODO) [[Work]])}}',
            '- Inline {{renderer :todomaster}} macro and {{cloze secret}}',
            '- #+BEGIN_QUERY',
            '  {:query [:find (pull ?b [*]) :where [?b :block/marker "TODO"]]}',
            '  #+END_QUERY',
            '- #+BEGIN_QUOTE',
            '  Quoted [[Work]]',
            '  #+END_QUOTE',
            '- #+BEGIN_TIP',
            '  A tip',
            '  #+END_TIP',
            '- #+BEGIN_VERSE',
            '  roses',
            '  #+END_VERSE',
            '- {{video https://www.youtube.com/watch?v=abc}}',
            '- watch {{youtube https://youtu.be/abc}} now',
            ''
          ].join('\n')
        )
      ]
    })
    expect(bodyOf(result, 'Logseq/Dash.md')).toBe(
      [
        '```logseq',
        '{{query (and (task TODO) [[Work]])}}',
        '```',
        '',
        'Inline `{{renderer :todomaster}}` macro and `{{cloze secret}}`',
        '',
        '```logseq',
        '#+BEGIN_QUERY',
        '{:query [:find (pull ?b [*]) :where [?b :block/marker "TODO"]]}',
        '#+END_QUERY',
        '```',
        '',
        '> Quoted [[Work]]',
        '',
        '> [!tip]',
        '> A tip',
        '',
        '```logseq',
        '#+BEGIN_VERSE',
        'roses',
        '#+END_VERSE',
        '```',
        '',
        '```embed',
        'https://www.youtube.com/watch?v=abc',
        '```',
        '',
        'watch [https://youtu.be/abc](https://youtu.be/abc) now',
        ''
      ].join('\n')
    )
    expect(result.stats.verbatim.query).toEqual({ count: 2, paths: ['Logseq/Dash.md'] })
    expect(result.stats.verbatim.macro.count).toBe(2)
    expect(result.stats.verbatim['org-block'].count).toBe(1)
    expect(result.report.body).toContain('- 2 queries\n  - [[Dash|Dash]]')
  })

  it('keeps an Org mode page whole, and lists whiteboards', () => {
    const result = plan({
      orgFiles: [{ rel: 'pages/agenda.org', text: '#+title: My Agenda\n* TODO thing\n```\n' }],
      assets: ['whiteboards/board.edn']
    })
    const org = result.notes[0]
    expect(org).toMatchObject({ path: 'Logseq/My Agenda.md', kind: 'org', title: 'My Agenda' })
    expect(org.body).toContain('````org\n#+title: My Agenda\n* TODO thing\n```\n````\n')
    expect(result.stats.verbatim['org-page'].count).toBe(1)
    expect(result.stats.verbatim.whiteboard).toEqual({ count: 1, paths: ['Logseq/whiteboards/board.edn'] })
    expect(result.report.body).toContain('- 1 whiteboard\n  - Logseq/whiteboards/board.edn')
    expect(result.report.body).toContain('- 1 page, 1 of them in Org mode and kept as written')
    expect(result.report.body).toContain('- 1 file, in the same folders as in the graph')
  })
})

describe('nothing is lost', () => {
  it('keeps every word of a busy page', () => {
    const text = [
      'title:: Busy Page',
      '',
      '- # Heading words',
      '\t- alpha **bravo** charlie',
      '\t  delta continuation',
      '\t\t- echo [[Foxtrot]]',
      '\t\t  custom:: golf',
      '- TODO hotel',
      '  :LOGBOOK:',
      '  CLOCK: [2024-01-15 Mon 10:00]--[2024-01-15 Mon 11:00] =>  01:00:00',
      '  :END:',
      '- ```python',
      '  print("india")',
      '  ```',
      '- | juliet | kilo |',
      '  | --- | --- |',
      '  | lima | mike |',
      '- > november quote',
      '-',
      '- oscar',
      '\t-',
      '\t- papa',
      ''
    ].join('\n')
    const body = plan({ pages: [page('busy', text)] }).notes[0].body
    for (const word of ['Heading', 'alpha', 'bravo', 'charlie', 'delta', 'echo', 'Foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa']) {
      expect(body).toContain(word)
    }
    expect(body).not.toContain('CLOCK')
    expect(body).toContain('custom:: golf')
  })
})
