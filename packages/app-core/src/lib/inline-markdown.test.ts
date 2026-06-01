import { describe, expect, it } from 'vitest'
import { parseInlineTokens, type InlineToken } from './inline-markdown'

/** Flatten a token tree to a debug string like `strong(text:"x")` so tests
 *  read as assertions about shape, not nested object literals. */
function shape(tokens: InlineToken[]): string {
  return tokens
    .map((t) => {
      switch (t.type) {
        case 'text':
          return `text:${JSON.stringify(t.value)}`
        case 'code':
          return `code:${JSON.stringify(t.value)}`
        case 'tag':
          return `tag:${t.tag}`
        case 'wikilink':
          return `wikilink:${t.target}|${t.label}`
        case 'link':
          return `link(${t.href}){${shape(t.children)}}`
        default:
          return `${t.type}{${shape(t.children)}}`
      }
    })
    .join(' ')
}

describe('parseInlineTokens', () => {
  it('renders a link as its label, not the raw URL (issue #59)', () => {
    const tokens = parseInlineTokens(
      'Start DocumentAI course [link](https://learn.deeplearning.ai/courses/x)'
    )
    expect(shape(tokens)).toBe(
      'text:"Start DocumentAI course " link(https://learn.deeplearning.ai/courses/x){text:"link"}'
    )
  })

  it('parses bold across the rest of a line (issue #59)', () => {
    const tokens = parseInlineTokens('Build a **VectorDB** hobby project using **TurboVector**')
    expect(shape(tokens)).toBe(
      'text:"Build a " strong{text:"VectorDB"} text:" hobby project using " strong{text:"TurboVector"}'
    )
  })

  it('handles italic with both * and _', () => {
    expect(shape(parseInlineTokens('an *important* note'))).toBe(
      'text:"an " em{text:"important"} text:" note"'
    )
    expect(shape(parseInlineTokens('an _important_ note'))).toBe(
      'text:"an " em{text:"important"} text:" note"'
    )
  })

  it('does not treat intra-word underscores as emphasis', () => {
    expect(shape(parseInlineTokens('some_file_name.py'))).toBe('text:"some_file_name.py"')
  })

  it('does not treat arithmetic asterisks as emphasis', () => {
    expect(shape(parseInlineTokens('2 * 3 * 4'))).toBe('text:"2 * 3 * 4"')
  })

  it('keeps inline code literal and ignores markdown inside it', () => {
    expect(shape(parseInlineTokens('run `npm **test**` now'))).toBe(
      'text:"run " code:"npm **test**" text:" now"'
    )
  })

  it('parses strikethrough', () => {
    expect(shape(parseInlineTokens('~~done~~ already'))).toBe(
      'del{text:"done"} text:" already"'
    )
  })

  it('does not mistake ** for nested emphasis', () => {
    expect(shape(parseInlineTokens('**bold**'))).toBe('strong{text:"bold"}')
  })

  it('parses emphasis nested inside bold', () => {
    expect(shape(parseInlineTokens('**bold _and italic_**'))).toBe(
      'strong{text:"bold " em{text:"and italic"}}'
    )
  })

  it('parses wikilinks, using the label after a pipe', () => {
    expect(shape(parseInlineTokens('see [[Note Title]] and [[path/to/note|Alias]]'))).toBe(
      'text:"see " wikilink:Note Title|Note Title text:" and " wikilink:path/to/note|Alias'
    )
  })

  it('parses hashtags only at word boundaries', () => {
    expect(shape(parseInlineTokens('ship #project but not a#b'))).toBe(
      'text:"ship " tag:project text:" but not a#b"'
    )
  })

  it('parses formatting inside a link label', () => {
    expect(shape(parseInlineTokens('[**bold** label](https://x.dev)'))).toBe(
      'link(https://x.dev){strong{text:"bold"} text:" label"}'
    )
  })

  it('leaves a bare URL untouched (no autolinking)', () => {
    expect(shape(parseInlineTokens('see https://x.dev/a_b_c here'))).toBe(
      'text:"see https://x.dev/a_b_c here"'
    )
  })

  it('returns a single text token for plain content', () => {
    expect(shape(parseInlineTokens('just a normal task'))).toBe('text:"just a normal task"')
  })

  it('leaves an unterminated delimiter as plain text', () => {
    expect(shape(parseInlineTokens('a **bold start without end'))).toBe(
      'text:"a **bold start without end"'
    )
  })

  it('does not autolink a URL inside a wikilink target', () => {
    expect(shape(parseInlineTokens('[[https://x.dev|site]]'))).toBe(
      'wikilink:https://x.dev|site'
    )
  })

  it('handles an empty string', () => {
    expect(parseInlineTokens('')).toEqual([])
  })
})
