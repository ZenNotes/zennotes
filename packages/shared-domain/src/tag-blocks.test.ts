import { describe, expect, it } from 'vitest'
import { extractTagBlocks, tagBlockJumpOffset } from './tag-blocks'
import { extractTags } from './tag-scan'

const lines = (...rows: string[]): string => rows.join('\n')

describe('extractTagBlocks', () => {
  it('returns nothing for a note without inline tags', () => {
    expect(extractTagBlocks('')).toEqual([])
    expect(extractTagBlocks('Just prose, no hashes.')).toEqual([])
    expect(extractTagBlocks('# A heading\n\nText')).toEqual([])
  })

  it('lists each list item that carries a tag, with its own line', () => {
    const body = lines(
      '# Ideas',
      '',
      '- Unrelated thought',
      '- Build a recipe gallery #idea',
      '- Another idea #idea #later',
      '- Last item'
    )
    const blocks = extractTagBlocks(body)
    expect(blocks).toEqual([
      {
        kind: 'list-item',
        startLine: 3,
        endLine: 3,
        tags: ['idea'],
        text: 'Build a recipe gallery #idea'
      },
      {
        kind: 'list-item',
        startLine: 4,
        endLine: 4,
        tags: ['idea', 'later'],
        text: 'Another idea #idea #later'
      }
    ])
  })

  it('takes a list item with its nested children and wrapped lines', () => {
    const body = lines(
      '- Parent idea #idea',
      '  wrapped onto a second line',
      '  - child one',
      '    - grandchild',
      '- Sibling'
    )
    const [block] = extractTagBlocks(body)
    expect(block?.kind).toBe('list-item')
    expect(block?.startLine).toBe(0)
    expect(block?.endLine).toBe(3)
    expect(block?.text).toBe('Parent idea #idea\nwrapped onto a second line\nchild one\ngrandchild')
  })

  it('gives a nested item its own block, apart from its parent', () => {
    const body = lines('- Parent #a', '  - Child #b', '  - Other child', '- Next')
    const blocks = extractTagBlocks(body)
    expect(blocks.map((b) => [b.startLine, b.endLine, b.tags])).toEqual([
      [0, 2, ['a']],
      [1, 1, ['b']]
    ])
  })

  it('credits a tag on a continuation line to the item it belongs to', () => {
    const body = lines(
      '1. First step',
      '   more about it #todo',
      '',
      '   a loose paragraph of the step',
      '2. Second step'
    )
    const [block] = extractTagBlocks(body)
    expect(block).toMatchObject({ kind: 'list-item', startLine: 0, endLine: 3, tags: ['todo'] })
  })

  it('keeps a loose paragraph under a nested item with the outer item', () => {
    const body = lines('- Parent', '  - child', '', '  parent paragraph #x', '- Next')
    expect(extractTagBlocks(body)).toMatchObject([{ kind: 'list-item', startLine: 0, endLine: 3 }])
  })

  it('treats a task line as a list item and strips its box from the text', () => {
    const body = lines('- [ ] Ship the gallery #idea', '- [x] Done thing #idea')
    expect(extractTagBlocks(body).map((b) => b.text)).toEqual([
      'Ship the gallery #idea',
      'Done thing #idea'
    ])
  })

  it('takes the whole paragraph a tag sits in', () => {
    const body = lines(
      'First paragraph, not tagged.',
      '',
      'An idea that spans',
      'several lines #idea',
      'and keeps going.',
      '',
      'Another paragraph.'
    )
    expect(extractTagBlocks(body)).toEqual([
      {
        kind: 'paragraph',
        startLine: 2,
        endLine: 4,
        tags: ['idea'],
        text: 'An idea that spans\nseveral lines #idea\nand keeps going.'
      }
    ])
  })

  it('does not pull a paragraph after a list into the list', () => {
    const body = lines('- item', '', 'Paragraph after the list #idea')
    expect(extractTagBlocks(body)).toMatchObject([{ kind: 'paragraph', startLine: 2, endLine: 2 }])
  })

  it('does not pull a column-0 paragraph into an earlier list across a blank line', () => {
    const body = lines('- item', '', 'Para A', '', '  indented para #x')
    expect(extractTagBlocks(body)).toMatchObject([{ kind: 'paragraph', startLine: 4 }])
  })

  it('tags a heading with its whole section, down to the next heading at its level', () => {
    const body = lines(
      '# Note',
      '## Gallery idea #idea',
      'Why it matters.',
      '### Sub detail',
      'More.',
      '',
      '## Next section',
      'Other.'
    )
    expect(extractTagBlocks(body)).toEqual([
      {
        kind: 'heading',
        startLine: 1,
        endLine: 4,
        tags: ['idea'],
        text: 'Gallery idea #idea\nWhy it matters.\nSub detail\nMore.'
      }
    ])
  })

  it('lists a tagged block inside a tagged section as a block of its own', () => {
    const body = lines('## Ideas #idea', '- one #idea', '- two')
    expect(extractTagBlocks(body).map((b) => [b.kind, b.startLine, b.endLine])).toEqual([
      ['heading', 0, 2],
      ['list-item', 1, 1]
    ])
  })

  it('ignores tags inside fenced and inline code', () => {
    const body = lines(
      '```c',
      '#include <stdio.h>',
      '```',
      '',
      '- item with `#notatag` code #real',
      '  ```',
      '  #alsonot',
      '  ```',
      '',
      '~~~',
      '#nope',
      '~~~'
    )
    const blocks = extractTagBlocks(body)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'list-item', startLine: 4, endLine: 7, tags: ['real'] })
    // The fenced child is part of the item's extent but not of its text.
    expect(blocks[0]?.text).toBe('item with `#notatag` code #real')
  })

  it('never treats a `#` line inside a fence as a heading that ends a section', () => {
    const body = lines('## Section #s', '```sh', '# a shell comment', '```', 'after', '## Next')
    expect(extractTagBlocks(body)).toMatchObject([{ kind: 'heading', startLine: 0, endLine: 4 }])
  })

  it('leaves frontmatter tags note-level and counts lines from the top of the file', () => {
    const body = lines('---', 'tags: [project, idea]', 'title: "#notatag"', '---', '', 'Body line #inline')
    const blocks = extractTagBlocks(body)
    expect(blocks).toEqual([
      { kind: 'paragraph', startLine: 5, endLine: 5, tags: ['inline'], text: 'Body line #inline' }
    ])
    // The note-level scan still sees the frontmatter tags.
    expect(extractTags(body)).toEqual(['project', 'idea', 'inline'])
  })

  it('produces no block for a note tagged only in frontmatter', () => {
    expect(extractTagBlocks(lines('---', 'tags: idea', '---', 'Plain body'))).toEqual([])
  })

  it('takes a whole quote or callout', () => {
    const body = lines('Intro', '', '> [!note] Callout title', '> idea inside #idea', '', 'After')
    expect(extractTagBlocks(body)).toEqual([
      {
        kind: 'quote',
        startLine: 2,
        endLine: 3,
        tags: ['idea'],
        text: 'Callout title\nidea inside #idea'
      }
    ])
  })

  it('takes a single table row', () => {
    const body = lines('| Idea | Status |', '| --- | --- |', '| Gallery #idea | open |', '| Other | done |')
    expect(extractTagBlocks(body)).toEqual([
      { kind: 'table-row', startLine: 2, endLine: 2, tags: ['idea'], text: 'Gallery #idea · open' }
    ])
  })

  it('merges tags from several lines of one block', () => {
    const body = lines('First line #a', 'second line #b #a')
    expect(extractTagBlocks(body)).toMatchObject([{ startLine: 0, endLine: 1, tags: ['a', 'b'] }])
  })

  it('agrees with the note-level scan on which tags are inline', () => {
    const body = lines(
      '# Heading',
      'me#nottag url.com/#nottag #Ünïcode #тег #nested/tag-1',
      '`#code` #after-code'
    )
    const blockTags = extractTagBlocks(body).flatMap((b) => b.tags)
    expect(blockTags).toEqual(['Ünïcode', 'тег', 'nested/tag-1', 'after-code'])
    expect(extractTags(body)).toEqual(blockTags)
  })

  it('reads CRLF bodies without shifting lines', () => {
    const body = ['- one', '- two #idea', '- three'].join('\r\n')
    expect(extractTagBlocks(body)).toMatchObject([{ startLine: 1, endLine: 1, text: 'two #idea' }])
  })

  it('drops a trailing block id from the text', () => {
    expect(extractTagBlocks('- An idea #idea ^gallery')[0]?.text).toBe('An idea #idea')
  })

  it('caps long blocks', () => {
    const body = ['## Long #idea', ...Array.from({ length: 20 }, (_, i) => `line ${i}`)].join('\n')
    const text = extractTagBlocks(body)[0]?.text ?? ''
    expect(text.split('\n')).toHaveLength(6)
    expect(text.endsWith('…')).toBe(true)
  })
})

describe('tagBlockJumpOffset', () => {
  const body = lines('# Title', '', '- [ ] task #idea', '  > quoted', '## Head #x', 'plain #y')

  it('lands after list markers and task boxes', () => {
    expect(tagBlockJumpOffset(body, 2)).toBe(body.indexOf('task #idea'))
  })

  it('lands after heading hashes', () => {
    expect(tagBlockJumpOffset(body, 4)).toBe(body.indexOf('Head #x'))
  })

  it('lands at the start of a plain line, and clamps past the end', () => {
    expect(tagBlockJumpOffset(body, 5)).toBe(body.indexOf('plain #y'))
    expect(tagBlockJumpOffset(body, 99)).toBe(body.indexOf('plain #y'))
  })
})
