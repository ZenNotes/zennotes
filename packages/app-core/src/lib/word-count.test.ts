import { describe, expect, it } from 'vitest'
import { countWords } from './word-count'

describe('countWords', () => {
  it('returns 0 for an empty string', () => {
    expect(countWords('')).toBe(0)
  })

  it('returns 0 for whitespace-only input', () => {
    expect(countWords('   \n\t  ')).toBe(0)
  })

  it('counts words separated by whitespace', () => {
    expect(countWords('hello world')).toBe(2)
  })

  it('treats consecutive whitespace as a single separator', () => {
    expect(countWords('  hello\n\nworld\t!  ')).toBe(3)
  })

  it('strips YAML frontmatter at the start of the document', () => {
    const body = '---\ntitle: foo\ntags: [a, b]\n---\nhello world'
    expect(countWords(body)).toBe(2)
  })

  it('handles CRLF line endings in frontmatter', () => {
    const body = '---\r\ntitle: foo\r\n---\r\nhello world'
    expect(countWords(body)).toBe(2)
  })

  it('does not strip --- horizontal rules in the body', () => {
    const body = '# Heading\n\nfoo\n\n---\n\nbar'
    expect(countWords(body)).toBe(5)
  })

  it('counts words inside fenced code blocks (issue #43)', () => {
    const body = 'before\n\n```python\ndef hello():\n    return "world"\n```\n\nafter'
    expect(countWords(body)).toBe(8)
  })

  it('counts words inside inline code (issue #43)', () => {
    expect(countWords('use the `console.log` function')).toBe(4)
  })
})
