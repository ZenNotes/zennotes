import { describe, expect, it } from 'vitest'
import { classifyApplicationLink, normalizeApplicationSchemes } from './application-links'

describe('application links', () => {
  it('preserves custom URLs, including their case, query, and fragment', () => {
    const url = 'Zotero://open-pdf/library/items/W78FUE98?page=3#annotation=ABC'
    expect(classifyApplicationLink(url)).toEqual({ url, scheme: 'zotero', blocked: false })
  })
  it.each([
    'obsidian://open?vault=Work',
    'vscode://file/tmp/note.md',
    'x://note',
    'things:add?title=Task'
  ])('recognizes %s', (url) => {
    expect(classifyApplicationLink(url)?.blocked).toBe(false)
  })
  it.each([
    'https://example.com',
    'mailto:a@b.com',
    'tel:+123',
    'file:///tmp/a.pdf',
    'zen-asset://a',
    'zen://asset/a',
    'C:\\a.pdf',
    'C:/a.pdf',
    '../Note.md',
    'Note.md',
    '#Heading'
  ])('leaves existing handlers in charge of %s', (url) => {
    expect(classifyApplicationLink(url)).toBeNull()
  })
  it.each([
    'javascript:alert(1)',
    'data:text/html,test',
    'vbscript:run',
    'about:blank',
    'chrome://settings',
    'zotero:',
    'zotero://bad\nvalue',
    'zotero://bad value'
  ])('blocks %s', (url) => {
    expect(classifyApplicationLink(url)?.blocked).toBe(true)
  })
  it('normalizes enabled prefixes while excluding reserved and invalid entries', () => {
    expect(
      normalizeApplicationSchemes([
        ' Zotero:// ',
        'zotero',
        'OBSIDIAN:',
        'vscode',
        'javascript',
        'file',
        'https',
        'zen-asset',
        'bad value',
        7
      ])
    ).toEqual(['zotero', 'obsidian', 'vscode'])
    expect(normalizeApplicationSchemes(null)).toEqual([])
  })
})
