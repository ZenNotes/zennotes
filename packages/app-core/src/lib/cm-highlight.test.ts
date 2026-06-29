import { describe, expect, it } from 'vitest'
import { HIGHLIGHT_COLORS, unwrapHighlight, wrapHighlight } from './cm-highlight'

describe('wrapHighlight', () => {
  it('uses == for yellow (default) and <mark class> for colors', () => {
    expect(wrapHighlight('x', 'yellow')).toBe('==x==')
    expect(wrapHighlight('foo bar', 'green')).toBe('<mark class="hl-green">foo bar</mark>')
    expect(wrapHighlight('x', 'blue')).toBe('<mark class="hl-blue">x</mark>')
    expect(wrapHighlight('x', 'purple')).toBe('<mark class="hl-purple">x</mark>')
    expect(wrapHighlight('x', 'red')).toBe('<mark class="hl-red">x</mark>')
  })
})

describe('unwrapHighlight', () => {
  it('strips == and <mark> wrappers', () => {
    expect(unwrapHighlight('==x==')).toBe('x')
    expect(unwrapHighlight('<mark class="hl-green">x</mark>')).toBe('x')
    expect(unwrapHighlight('<mark>x</mark>')).toBe('x')
  })

  it('leaves plain (or partial) text untouched', () => {
    expect(unwrapHighlight('plain')).toBe('plain')
    expect(unwrapHighlight('==')).toBe('==')
    expect(unwrapHighlight('a == b')).toBe('a == b')
  })

  it('round-trips with wrapHighlight for every color (enables re-coloring)', () => {
    for (const c of HIGHLIGHT_COLORS) {
      expect(unwrapHighlight(wrapHighlight('hello world', c.id))).toBe('hello world')
    }
  })
})
