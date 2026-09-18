import { describe, expect, it } from 'vitest'
import { rewriteWikilinksForRename, type RenameNoteRef } from './wikilink-rename'

const notes: RenameNoteRef[] = [
  { path: 'inbox/demo/Old Title.md', title: 'Old Title', folder: 'inbox' },
  { path: 'inbox/Other.md', title: 'Other', folder: 'inbox' }
]

function rewrite(body: string): { body: string; changed: number } {
  return rewriteWikilinksForRename(body, notes, 'inbox/demo/Old Title.md', 'New Title')
}

describe('rewriteWikilinksForRename', () => {
  it('rewrites the bare title form', () => {
    expect(rewrite('See [[Old Title]] here.')).toEqual({
      body: 'See [[New Title]] here.',
      changed: 1
    })
  })

  it('preserves the alias, heading, block, and embed marker', () => {
    expect(rewrite('[[Old Title|the old one]]').body).toBe('[[New Title|the old one]]')
    expect(rewrite('[[Old Title#Intro]]').body).toBe('[[New Title#Intro]]')
    expect(rewrite('[[Old Title^a1b2]]').body).toBe('[[New Title^a1b2]]')
    expect(rewrite('[[Old Title#Intro|see intro]]').body).toBe('[[New Title#Intro|see intro]]')
    expect(rewrite('![[Old Title]]').body).toBe('![[New Title]]')
  })

  it('rewrites path-form targets by swapping the final segment', () => {
    expect(rewrite('[[inbox/demo/Old Title]]').body).toBe('[[inbox/demo/New Title]]')
    expect(rewrite('[[demo/Old Title]]').body).toBe('[[demo/New Title]]')
    expect(rewrite('[[/demo/Old Title]]').body).toBe('[[/demo/New Title]]')
    expect(rewrite('[[inbox/demo/Old Title.md]]').body).toBe('[[inbox/demo/New Title.md]]')
  })

  it('counts and rewrites multiple links', () => {
    expect(rewrite('[[Old Title]] and also [[Old Title|x]]')).toEqual({
      body: '[[New Title]] and also [[New Title|x]]',
      changed: 2
    })
  })

  it('leaves links to other notes alone', () => {
    expect(rewrite('[[Other]] stays')).toEqual({ body: '[[Other]] stays', changed: 0 })
    expect(rewrite('nothing here')).toEqual({ body: 'nothing here', changed: 0 })
  })

  it('does not touch links inside inline or fenced code', () => {
    expect(rewrite('use `[[Old Title]]` literally').changed).toBe(0)
    expect(rewrite('```\n[[Old Title]]\n```').changed).toBe(0)
    // ...but a real link next to a code span still updates.
    expect(rewrite('`[[Old Title]]` then [[Old Title]]')).toEqual({
      body: '`[[Old Title]]` then [[New Title]]',
      changed: 1
    })
  })

  it('only rewrites links that resolved to THIS note when titles collide', () => {
    const dup: RenameNoteRef[] = [
      { path: 'inbox/A.md', title: 'Dup', folder: 'inbox' },
      { path: 'inbox/B.md', title: 'Dup', folder: 'inbox' }
    ]
    // `[[Dup]]` resolves to the first match (inbox/A.md). Renaming B must not
    // touch it; renaming A must.
    expect(rewriteWikilinksForRename('[[Dup]]', dup, 'inbox/B.md', 'New').changed).toBe(0)
    expect(rewriteWikilinksForRename('[[Dup]]', dup, 'inbox/A.md', 'New').body).toBe('[[New]]')
  })
})
