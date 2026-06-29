import { describe, expect, it } from 'vitest'
import { parseOutline } from './outline'

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
