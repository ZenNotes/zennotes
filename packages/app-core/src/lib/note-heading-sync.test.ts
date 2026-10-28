import { describe, expect, it } from 'vitest'
import { leadingTitleHeading } from '@shared/note-heading-sync'
import { retitleLeadingHeading } from './note-heading-sync'

describe('retitleLeadingHeading (#455)', () => {
  it('retitles the heading a new note is created with', () => {
    expect(retitleLeadingHeading('# Untitled\n\n', 'Groceries')).toBe('# Groceries\n\n')
  })

  it('keeps the rest of the note byte-identical', () => {
    const body = '# Untitled\n\nFirst para.\n\n## Section\n\n- item\n'
    expect(retitleLeadingHeading(body, 'Notes')).toBe(
      '# Notes\n\nFirst para.\n\n## Section\n\n- item\n'
    )
  })

  it('rewrites a heading that no longer matches the old title', () => {
    expect(retitleLeadingHeading('# Old name\n\nbody', 'New name')).toBe('# New name\n\nbody')
  })

  it('finds the heading after frontmatter', () => {
    const body = '---\ntags: [task]\n---\n\n# Untitled\n\nbody\n'
    expect(retitleLeadingHeading(body, 'Ship it')).toBe(
      '---\ntags: [task]\n---\n\n# Ship it\n\nbody\n'
    )
  })

  it('is not fooled by a `# ` line inside frontmatter', () => {
    const body = '---\n# a yaml comment\ntags: [x]\n---\n# Untitled\n'
    expect(retitleLeadingHeading(body, 'Real')).toBe('---\n# a yaml comment\ntags: [x]\n---\n# Real\n')
  })

  it('skips leading blank lines', () => {
    expect(retitleLeadingHeading('\n\n# Untitled\nbody', 'Title')).toBe('\n\n# Title\nbody')
  })

  it('preserves CRLF line endings', () => {
    expect(retitleLeadingHeading('# Untitled\r\n\r\nbody\r\n', 'Title')).toBe(
      '# Title\r\n\r\nbody\r\n'
    )
  })

  it('preserves up to three spaces of heading indent', () => {
    expect(retitleLeadingHeading('  # Untitled\nbody', 'Title')).toBe('  # Title\nbody')
  })

  it('drops a closing hash sequence, keeping the heading well-formed', () => {
    expect(retitleLeadingHeading('# Untitled ###\nbody', 'Title')).toBe('# Title\nbody')
  })

  it('retitles a bare `#` heading', () => {
    expect(retitleLeadingHeading('#\nbody', 'Title')).toBe('# Title\nbody')
  })

  it('returns the same string when the heading already matches', () => {
    const body = '# Title\n\nbody'
    expect(retitleLeadingHeading(body, 'Title')).toBe(body)
  })

  it('never invents a heading', () => {
    expect(retitleLeadingHeading('Just prose.\n', 'Title')).toBe('Just prose.\n')
    expect(retitleLeadingHeading('', 'Title')).toBe('')
    expect(retitleLeadingHeading('\n\n  \n', 'Title')).toBe('\n\n  \n')
    expect(retitleLeadingHeading('---\ntags: [x]\n---\n', 'Title')).toBe('---\ntags: [x]\n---\n')
  })

  it('leaves anything that is not a leading H1 alone', () => {
    expect(retitleLeadingHeading('## Sub\n# Untitled\n', 'Title')).toBe('## Sub\n# Untitled\n')
    expect(retitleLeadingHeading('#Untitled\n', 'Title')).toBe('#Untitled\n')
    expect(retitleLeadingHeading('- [ ] task\n# Untitled\n', 'Title')).toBe(
      '- [ ] task\n# Untitled\n'
    )
    expect(retitleLeadingHeading('    # indented code\n', 'Title')).toBe('    # indented code\n')
  })

  it('refuses a title that would break the heading across lines', () => {
    expect(retitleLeadingHeading('# Untitled\n', 'One\nTwo')).toBe('# Untitled\n')
    expect(retitleLeadingHeading('# Untitled\n', '')).toBe('# Untitled\n')
  })
})

// The same line, located rather than rewritten: what select all leaves out (#1006).
describe('leadingTitleHeading', () => {
  const at = (body: string): string | null => {
    const found = leadingTitleHeading(body)
    return found ? body.slice(found.from, found.to) : null
  }

  it('finds the title past frontmatter and blank lines, without the line break', () => {
    expect(at('# Groceries\n\nmilk\n')).toBe('# Groceries')
    expect(at('---\ntags: [x]\n---\n\n  # Groceries\r\nmilk\r\n')).toBe('  # Groceries')
    expect(at('#\n')).toBe('#')
  })

  it('has no title when the first line is anything but an H1', () => {
    for (const body of ['', '\n\n', 'milk\n# Groceries\n', '## Groceries\n', '#Groceries\n', '    # code\n']) {
      expect(leadingTitleHeading(body), JSON.stringify(body)).toBeNull()
    }
  })
})
