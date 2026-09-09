import { describe, expect, it } from 'vitest'
import {
  lineOfOffset,
  normalizeNoteComment,
  normalizeNoteComments,
  noteCommentsSidecarPath,
  resolveCommentAnchor,
  threadNoteComments,
  threadRootOf
} from './note-comments'

const NOTE = 'inbox/Plan.md'

describe('normalizeNoteComment', () => {
  it('keeps an author and a parent, trimmed, and drops them when blank', () => {
    const c = normalizeNoteComment(
      { notePath: NOTE, anchorStart: 3, anchorEnd: 9, anchorText: 'the plan', body: ' Looks good ', author: '  Claude  Code ', parentId: ' c1 ' },
      NOTE,
      1000
    )!
    expect(c.body).toBe('Looks good')
    expect(c.author).toBe('Claude Code')
    expect(c.parentId).toBe('c1')
    expect(c.createdAt).toBe(1000)
    expect(c.resolvedAt).toBeNull()
    const plain = normalizeNoteComment({ notePath: NOTE, anchorStart: 0, anchorEnd: 0, anchorText: '', body: 'x', author: '  ', parentId: '' }, NOTE)!
    expect(plain).not.toHaveProperty('author')
    expect(plain).not.toHaveProperty('parentId')
  })

  it('drops a comment without a body and mints an id when missing', () => {
    expect(normalizeNoteComment({ notePath: NOTE, anchorStart: 0, anchorEnd: 0, anchorText: '', body: '  ' }, NOTE)).toBeNull()
    const c = normalizeNoteComment({ notePath: NOTE, anchorStart: 5, anchorEnd: 2, anchorText: '', body: 'b' }, NOTE)!
    expect(c.id.length).toBeGreaterThan(8)
    expect(c.anchorStart).toBe(2)
    expect(c.anchorEnd).toBe(5)
  })
})

describe('normalizeNoteComments', () => {
  it('reads both sidecar shapes, dedupes by id, sorts by creation, and orphans a reply whose parent is gone', () => {
    const raw = {
      version: 1,
      comments: [
        { id: 'b', notePath: NOTE, anchorStart: 0, anchorEnd: 0, anchorText: '', body: 'second', createdAt: 2 },
        { id: 'a', notePath: NOTE, anchorStart: 0, anchorEnd: 0, anchorText: '', body: 'first', createdAt: 1 },
        { id: 'a', notePath: NOTE, anchorStart: 0, anchorEnd: 0, anchorText: '', body: 'dupe', createdAt: 3 },
        { id: 'r', notePath: NOTE, anchorStart: 0, anchorEnd: 0, anchorText: '', body: 'reply', createdAt: 4, parentId: 'a', author: 'Claude' },
        { id: 'o', notePath: NOTE, anchorStart: 0, anchorEnd: 0, anchorText: '', body: 'orphan', createdAt: 5, parentId: 'missing' },
        { id: 's', notePath: NOTE, anchorStart: 0, anchorEnd: 0, anchorText: '', body: 'self', createdAt: 6, parentId: 's' },
        null,
        'junk'
      ]
    }
    const comments = normalizeNoteComments(raw, NOTE)
    expect(comments.map((c) => c.id)).toEqual(['a', 'b', 'r', 'o', 's'])
    expect(comments[2].parentId).toBe('a')
    expect(comments[3]).not.toHaveProperty('parentId')
    expect(comments[4]).not.toHaveProperty('parentId')
    expect(normalizeNoteComments([{ id: 'x', body: 'bare array', anchorStart: 0, anchorEnd: 0, anchorText: '', notePath: NOTE }], NOTE)).toHaveLength(1)
    expect(normalizeNoteComments('nope', NOTE)).toEqual([])
  })
})

describe('threadNoteComments', () => {
  const base = { notePath: NOTE, anchorStart: 0, anchorEnd: 0, anchorText: '', updatedAt: 0, resolvedAt: null }
  const comments = [
    { ...base, id: 'a', body: 'A', createdAt: 1 },
    { ...base, id: 'b', body: 'B', createdAt: 2 },
    { ...base, id: 'a1', body: 'A reply', createdAt: 3, parentId: 'a', author: 'Claude' },
    { ...base, id: 'a2', body: 'reply to the reply', createdAt: 4, parentId: 'a1' },
    { ...base, id: 'b1', body: 'B reply', createdAt: 5, parentId: 'b' }
  ]

  it('groups replies under their top-level comment, one level deep, in order', () => {
    const threads = threadNoteComments(comments)
    expect(threads.map((t) => t.comment.id)).toEqual(['a', 'b'])
    expect(threads[0].replies.map((r) => r.id)).toEqual(['a1', 'a2'])
    expect(threads[1].replies.map((r) => r.id)).toEqual(['b1'])
  })

  it('finds the thread root for any id', () => {
    expect(threadRootOf(comments, 'a2')?.id).toBe('a')
    expect(threadRootOf(comments, 'b')?.id).toBe('b')
    expect(threadRootOf(comments, 'zzz')).toBeNull()
  })
})

describe('anchors and lines', () => {
  it('re-anchors by text when the offsets drifted', () => {
    const doc = 'intro\n\nthe plan is simple\n'
    expect(resolveCommentAnchor({ anchorStart: 0, anchorEnd: 8, anchorText: 'the plan' }, doc)).toEqual({ from: 7, to: 15 })
    expect(resolveCommentAnchor({ anchorStart: 7, anchorEnd: 15, anchorText: 'the plan' }, doc)).toEqual({ from: 7, to: 15 })
    expect(resolveCommentAnchor({ anchorStart: 2, anchorEnd: 4, anchorText: 'gone' }, doc)).toEqual({ from: 2, to: 4 })
  })

  it('counts lines from one', () => {
    const doc = 'a\nb\nc'
    expect(lineOfOffset(doc, 0)).toBe(1)
    expect(lineOfOffset(doc, 2)).toBe(2)
    expect(lineOfOffset(doc, 4)).toBe(3)
    expect(lineOfOffset(doc, 99)).toBe(3)
  })

  it('names the sidecar next to the internal dir', () => {
    expect(noteCommentsSidecarPath('.zennotes', 'inbox/Plan.md')).toBe('.zennotes/comments/inbox/Plan.md.comments.json')
  })
})
