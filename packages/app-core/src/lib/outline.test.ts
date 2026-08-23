import { describe, expect, it } from 'vitest'
import { activeOutlineLineForCursor, parseOutline } from './outline'

describe('parseOutline — #249 code block with wikilinks', () => {
  it('keeps headings after a single-line triple-backtick code span (the #248/#249 repro)', () => {
    // ```[[...]]``` on one line is an inline code span, NOT a fence opener.
    const body = [
      '# Section 1',
      '## Sub 1',
      '```[[Verweisziel|Beschriftung des Verweises]]```',
      '# Section 2',
      '## Sub 2',
      '# Section 3'
    ].join('\n')
    expect(parseOutline(body).map((i) => i.text)).toEqual([
      'Section 1',
      'Sub 1',
      'Section 2',
      'Sub 2',
      'Section 3'
    ])
  })

  it('keeps headings after a code block that contains wikilink syntax', () => {
    const body = [
      '# Section 1',
      '## Sub 1',
      '',
      '```',
      '[[Verweisziel|Beschriftung des Verweises]]',
      '',
      '[[Linux-Backup]]',
      '```',
      '',
      '# Section 2',
      '## Sub 2',
      '# Section 3'
    ].join('\n')
    expect(parseOutline(body).map((i) => i.text)).toEqual([
      'Section 1',
      'Sub 1',
      'Section 2',
      'Sub 2',
      'Section 3'
    ])
  })

  it('keeps headings after a code block that contains a fence-like line', () => {
    const body = [
      '# Section 1',
      '```',
      'show a fence: ```',
      '~~~',
      '```',
      '# Section 2'
    ].join('\n')
    expect(parseOutline(body).map((i) => i.text)).toEqual(['Section 1', 'Section 2'])
  })

  it('keeps headings after a language-tagged code block', () => {
    const body = ['# Section 1', '```markdown', '# not a heading', '```', '# Section 2'].join('\n')
    expect(parseOutline(body).map((i) => i.text)).toEqual(['Section 1', 'Section 2'])
  })

  it('still skips real headings inside a fenced code block', () => {
    const body = ['# Real', '```', '# fake heading in code', '```', '# Also real'].join('\n')
    expect(parseOutline(body).map((i) => i.text)).toEqual(['Real', 'Also real'])
  })

  it('is unaffected by a single-backtick inline code span', () => {
    const body = ['# Section 1', '`[[Linux-Backup]]`', '# Section 2'].join('\n')
    expect(parseOutline(body).map((i) => i.text)).toEqual(['Section 1', 'Section 2'])
  })
})

describe('parseOutline — #442 frontmatter is not parsed as headings', () => {
  it("does not read the closing '---' as a setext H2 for the last frontmatter line", () => {
    const body = ['---', 'title: Test', 'type: Test', '---'].join('\n')
    expect(parseOutline(body)).toEqual([])
  })

  it('skips frontmatter and reports the real heading with the correct line number', () => {
    const body = ['---', 'title: Test', 'type: Test', '---', '', '# Real Heading'].join('\n')
    expect(parseOutline(body)).toEqual([{ level: 1, text: 'Real Heading', line: 6, from: 32 }])
  })

  it('keeps a real setext heading in the body after frontmatter', () => {
    const body = ['---', 'title: Test', '---', '', 'A Heading', '---', '', 'body'].join('\n')
    expect(parseOutline(body).map((i) => ({ level: i.level, text: i.text }))).toEqual([
      { level: 2, text: 'A Heading' }
    ])
  })

  it('does not treat a `---` horizontal rule as frontmatter when the note has no frontmatter', () => {
    // No leading `---`, so the first heading's setext underline still works.
    const body = ['Title', '===', '', 'text', '', '---', '', '# After Rule'].join('\n')
    expect(parseOutline(body).map((i) => ({ level: i.level, text: i.text }))).toEqual([
      { level: 1, text: 'Title' },
      { level: 1, text: 'After Rule' }
    ])
  })

  it('handles an empty frontmatter block', () => {
    const body = ['---', '---', '# Only Heading'].join('\n')
    expect(parseOutline(body).map((i) => i.text)).toEqual(['Only Heading'])
  })
})

describe('activeOutlineLineForCursor — discussion #597', () => {
  const items = parseOutline(['intro', '# One', 'body', '## Two', 'more', '# Three'].join('\n'))

  it('tracks the heading that contains the cursor instead of a viewport probe', () => {
    expect(activeOutlineLineForCursor(items, 2)).toBe(2)
    expect(activeOutlineLineForCursor(items, 3)).toBe(2)
    expect(activeOutlineLineForCursor(items, 5)).toBe(4)
    expect(activeOutlineLineForCursor(items, 6)).toBe(6)
  })

  it('has no active heading before the first heading or in an empty outline', () => {
    expect(activeOutlineLineForCursor(items, 1)).toBeNull()
    expect(activeOutlineLineForCursor([], 20)).toBeNull()
  })
})
