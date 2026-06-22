import { describe, expect, it } from 'vitest'
import {
  parseCreateNotePath,
  resolveWikilinkTarget,
  stripWikilinkAnchor,
  suggestCreateNotePath,
  wikilinkHeadingAnchor
} from './wikilinks'

const notes = [
  { path: 'inbox/My Document.md', title: 'My Document', folder: 'inbox' as const },
  { path: 'inbox/projects/Spec.md', title: 'Spec', folder: 'inbox' as const }
]

describe('stripWikilinkAnchor (#196)', () => {
  it('drops a #heading anchor', () => {
    expect(stripWikilinkAnchor('My Document#My Heading')).toBe('My Document')
  })

  it('drops a ^block anchor', () => {
    expect(stripWikilinkAnchor('My Document^abc123')).toBe('My Document')
  })

  it('keeps a plain target untouched', () => {
    expect(stripWikilinkAnchor('My Document')).toBe('My Document')
  })

  it('keeps the path up to the first anchor', () => {
    expect(stripWikilinkAnchor('projects/Spec#design')).toBe('projects/Spec')
  })
})

describe('wikilinkHeadingAnchor (#196)', () => {
  it('returns the heading text after #', () => {
    expect(wikilinkHeadingAnchor('My Document#My Heading')).toBe('My Heading')
  })

  it('is null without a heading anchor', () => {
    expect(wikilinkHeadingAnchor('My Document')).toBeNull()
    expect(wikilinkHeadingAnchor('My Document^block')).toBeNull()
  })
})

describe('resolveWikilinkTarget — heading/block anchors (#196)', () => {
  it('resolves [[Doc#heading]] to the document', () => {
    expect(resolveWikilinkTarget(notes, 'My Document#My Heading')?.path).toBe('inbox/My Document.md')
  })

  it('resolves [[Doc^block]] to the document', () => {
    expect(resolveWikilinkTarget(notes, 'My Document^abc')?.path).toBe('inbox/My Document.md')
  })

  it('still resolves a plain [[Doc]]', () => {
    expect(resolveWikilinkTarget(notes, 'My Document')?.path).toBe('inbox/My Document.md')
  })

  it('resolves a path-like [[folder/Doc#heading]]', () => {
    expect(resolveWikilinkTarget(notes, 'projects/Spec#design')?.path).toBe('inbox/projects/Spec.md')
  })

  it('returns null for a bare [[#heading]] with no document', () => {
    expect(resolveWikilinkTarget(notes, '#My Heading')).toBeNull()
  })
})

describe('suggestCreateNotePath — anchored targets (#196)', () => {
  it('suggests the document, not the invalid anchored name', () => {
    expect(suggestCreateNotePath('New Doc#Heading')).toBe('/New Doc.md')
  })
})

describe('leading-slash + anchor (#196 — [[/Untitled#test]])', () => {
  const untitled = [{ path: 'inbox/Untitled.md', title: 'Untitled', folder: 'inbox' as const }]

  it('strips the anchor off an absolute-path target', () => {
    expect(stripWikilinkAnchor('/Untitled#test')).toBe('/Untitled')
  })

  it('resolves [[/Untitled#test]] to inbox/Untitled.md', () => {
    expect(resolveWikilinkTarget(untitled, '/Untitled#test')?.path).toBe('inbox/Untitled.md')
  })

  it('suggests a valid create path (no #, no extra slash)', () => {
    expect(suggestCreateNotePath('/Untitled#test')).toBe('/Untitled.md')
  })

  it('parseCreateNotePath accepts the suggested path', () => {
    expect(parseCreateNotePath(suggestCreateNotePath('/Untitled#test')).relPath).toBe(
      'inbox/Untitled.md'
    )
  })
})
