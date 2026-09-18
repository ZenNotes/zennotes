import { describe, expect, it } from 'vitest'
import { classifyOutgoingWikilinks } from './connections-outgoing'

// #757: the Connections panel listed an embedded image as an unresolved
// wikilink and offered to create `assets/diagram.png.md` for it. A wikilink
// that resolves to a file in the vault is an attachment, never a missing note.

const notes = [
  { path: 'inbox/Current.md', title: 'Current', folder: 'inbox' as const },
  { path: 'inbox/Doc.md', title: 'Doc', folder: 'inbox' as const },
  { path: 'trash/Old.md', title: 'Old', folder: 'trash' as const }
]

const assets = [{ path: 'assets/diagram.png' }, { path: 'Papers/spec.pdf' }]

function classify(body: string, notePath = 'inbox/Current.md') {
  return classifyOutgoingWikilinks({ body, notePath, noteTitle: 'Current', notes, assets })
}

describe('classifyOutgoingWikilinks (#757)', () => {
  it('lists an embedded image as an attachment, not a missing note', () => {
    const out = classify('Look: ![[assets/diagram.png]] and [[Doc]] and [[Nowhere]]')
    expect(out.resolved.map((n) => n.path)).toEqual(['inbox/Doc.md'])
    expect(out.attachments).toEqual([{ target: 'assets/diagram.png', assetPath: 'assets/diagram.png' }])
    expect(out.missing).toEqual([{ target: 'Nowhere', suggestedPath: '/Nowhere.md' }])
  })

  it('resolves a vault-root path from a note in a subfolder and a bare basename', () => {
    const out = classify('[[assets/diagram.png]] [[spec.pdf]]', 'Daily Notes/2026-09-09.md')
    expect(out.attachments.map((a) => a.assetPath)).toEqual(['assets/diagram.png', 'Papers/spec.pdf'])
    expect(out.missing).toEqual([])
  })

  it('lists a file reached by two spellings once', () => {
    const out = classify('![[assets/diagram.png]] [[diagram.png]]')
    expect(out.attachments.map((a) => a.assetPath)).toEqual(['assets/diagram.png'])
  })

  it('keeps a file-like name no asset answers in the missing bucket', () => {
    const out = classify('[[assets/nothing.png]]')
    expect(out.attachments).toEqual([])
    expect(out.missing.map((m) => m.target)).toEqual(['assets/nothing.png'])
  })

  it('keeps the note rules: self links, trashed notes and duplicate spellings drop out', () => {
    const out = classify('[[Current]] [[Old]] [[Doc]] [[Doc#Heading]] [[doc]]')
    expect(out.resolved.map((n) => n.path)).toEqual(['inbox/Doc.md'])
    expect(out.attachments).toEqual([])
    expect(out.missing.map((m) => m.target)).toEqual(['Old'])
  })
})
