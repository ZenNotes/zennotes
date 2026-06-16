import { describe, expect, it } from 'vitest'
import {
  bindableH1TitleCursorOffset,
  ensureBindableH1,
  firstBindableH1,
  isGeneratedUntitledTitle,
  replaceFirstBindableH1Title
} from './note-title-heading'

describe('firstBindableH1', () => {
  it('finds the first H1 after frontmatter and blank lines', () => {
    const body = ['---', 'status: draft', '---', '', '# Project title', '', 'Body'].join('\n')
    expect(firstBindableH1(body)?.title).toBe('Project title')
  })

  it('returns null when the first non-empty block is not an H1', () => {
    expect(firstBindableH1('Intro\n\n# Later')).toBeNull()
    expect(firstBindableH1('## Section\n\nBody')).toBeNull()
  })

  it('treats an empty H1 as bindable', () => {
    expect(firstBindableH1('# \n\nBody')?.title).toBe('')
    expect(firstBindableH1('#')?.title).toBe('')
  })
})

describe('replaceFirstBindableH1Title', () => {
  it('rewrites only the bindable H1 line', () => {
    const body = ['---', 'status: draft', '---', '', '# Old', '', '## Old'].join('\n')
    expect(replaceFirstBindableH1Title(body, 'New')).toBe(
      ['---', 'status: draft', '---', '', '# New', '', '## Old'].join('\n')
    )
  })

  it('keeps a visible empty H1 marker for blank titles', () => {
    expect(replaceFirstBindableH1Title('# Old\n\nBody', '')).toBe('# \n\nBody')
  })

  it('leaves the body unchanged without a bindable H1', () => {
    const body = 'Intro\n\n# Later'
    expect(replaceFirstBindableH1Title(body, 'New')).toBe(body)
  })
})

describe('bindableH1TitleCursorOffset', () => {
  it('places the cursor after the empty H1 marker', () => {
    expect(bindableH1TitleCursorOffset('# \n')).toBe(2)
    expect(bindableH1TitleCursorOffset('#')).toBe(1)
  })

  it('places the cursor at the end of the bindable H1 title', () => {
    expect(bindableH1TitleCursorOffset('# Draft\n')).toBe('# Draft'.length)
  })

  it('finds the title cursor after frontmatter and blank lines', () => {
    const body = ['---', 'status: draft', '---', '', '# Draft', '', 'Body'].join('\n')
    expect(bindableH1TitleCursorOffset(body)).toBe(body.indexOf('# Draft') + '# Draft'.length)
  })

  it('returns null without a bindable H1', () => {
    expect(bindableH1TitleCursorOffset('Body\n\n# Later')).toBeNull()
  })
})

describe('ensureBindableH1', () => {
  it('leaves a body with a bindable H1 unchanged', () => {
    const body = '# Existing\n\nBody'
    expect(ensureBindableH1(body, 'Filename')).toBe(body)
  })

  it('adds a filename H1 before the first content block', () => {
    expect(ensureBindableH1('Body', 'Filename')).toBe('# Filename\n\nBody')
  })

  it('keeps frontmatter at the top', () => {
    const body = ['---', 'status: draft', '---', '', 'Body'].join('\n')
    expect(ensureBindableH1(body, 'Filename')).toBe(
      ['---', 'status: draft', '---', '', '# Filename', '', 'Body'].join('\n')
    )
  })

  it('adds a visible empty H1 marker for blank titles', () => {
    expect(ensureBindableH1('Body', '')).toBe('# \n\nBody')
  })
})

describe('isGeneratedUntitledTitle', () => {
  it('matches generated empty-note filenames only', () => {
    expect(isGeneratedUntitledTitle('Untitled')).toBe(true)
    expect(isGeneratedUntitledTitle('Untitled 2')).toBe(true)
    expect(isGeneratedUntitledTitle('Untitled 32')).toBe(true)
    expect(isGeneratedUntitledTitle('untitled')).toBe(false)
    expect(isGeneratedUntitledTitle('Untitled draft')).toBe(false)
    expect(isGeneratedUntitledTitle('Untitled 02')).toBe(false)
  })
})
