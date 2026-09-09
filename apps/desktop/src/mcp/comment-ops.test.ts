import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBackend, type VaultBackend } from '../cli/backend'
import { addComment, anchorForText, listCommentThreads, replyToComment, resolveComment } from './comment-ops'

// The comment operations behind the MCP tools and `zn comment` (#738), run
// against a real folder through the local backend so the sidecar the app
// reads is exactly what these write.

let root: string
let backend: VaultBackend
const NOTE = 'inbox/Plan.md'

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'zennotes-comment-ops-'))
  await mkdir(path.join(root, 'inbox'), { recursive: true })
  await writeFile(
    path.join(root, 'inbox', 'Plan.md'),
    '# Plan\n\nShip the beta in October.\n\nThe migration runs at night.\n'
  )
  backend = createBackend({ kind: 'local', root })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('anchorForText', () => {
  const doc = 'Alpha beta\nGamma Delta\n'
  it('finds the passage exactly, then ignoring case, and refuses what is not there', () => {
    expect(anchorForText(doc, 'Gamma')).toEqual({ anchorStart: 11, anchorEnd: 16, anchorText: 'Gamma' })
    expect(anchorForText(doc, 'gamma delta')).toEqual({ anchorStart: 11, anchorEnd: 22, anchorText: 'Gamma Delta' })
    expect(anchorForText(doc, undefined)).toEqual({ anchorStart: 0, anchorEnd: 0, anchorText: '' })
    expect(() => anchorForText(doc, 'omega')).toThrow(/anchor_text was not found/)
  })
})

describe('comment threads on a note', () => {
  it('adds an anchored comment, answers it in a thread, and resolves it', async () => {
    const thread = await addComment(backend, {
      path: NOTE,
      body: 'Is October still realistic?',
      anchorText: 'Ship the beta in October.',
      author: undefined
    })
    expect(thread.author).toBeNull()
    expect(thread.line).toBe(3)
    expect(thread.anchorText).toBe('Ship the beta in October.')
    expect(thread.replies).toEqual([])

    const answered = await replyToComment(backend, {
      path: NOTE,
      id: thread.id,
      body: 'Yes: the migration is the only blocker and it runs at night.',
      author: 'Claude Code'
    })
    expect(answered.id).toBe(thread.id)
    expect(answered.replies).toHaveLength(1)
    expect(answered.replies[0].author).toBe('Claude Code')

    // A reply to the reply lands in the same thread, one level deep.
    const again = await replyToComment(backend, {
      path: NOTE,
      id: answered.replies[0].id,
      body: 'Agreed, keep October.'
    })
    expect(again.id).toBe(thread.id)
    expect(again.replies.map((r) => r.author)).toEqual(['Claude Code', null])

    const open = await listCommentThreads(backend, NOTE)
    expect(open.map((t) => t.id)).toEqual([thread.id])

    const done = await resolveComment(backend, { path: NOTE, id: again.replies[1].id })
    expect(done.id).toBe(thread.id)
    expect(done.resolved).toBe(true)
    expect(await listCommentThreads(backend, NOTE)).toEqual([])
    expect((await listCommentThreads(backend, NOTE, { includeResolved: true }))[0].resolved).toBe(true)

    const reopened = await resolveComment(backend, { path: NOTE, id: thread.id, resolved: false })
    expect(reopened.resolved).toBe(false)

    // The sidecar is where the app reads: same path, same envelope.
    const sidecar = JSON.parse(
      await readFile(path.join(root, '.zennotes', 'comments', 'inbox', 'Plan.md.comments.json'), 'utf8')
    ) as { version: number; comments: Array<Record<string, unknown>> }
    expect(sidecar.version).toBe(1)
    expect(sidecar.comments).toHaveLength(3)
    expect(sidecar.comments[1]).toMatchObject({ parentId: thread.id, author: 'Claude Code' })
    expect(sidecar.comments[0]).not.toHaveProperty('author')
  })

  it('reports the line an anchor sits on after the note moved', async () => {
    const thread = await addComment(backend, {
      path: NOTE,
      body: 'Night runs need a rollback plan.',
      anchorText: 'The migration runs at night.'
    })
    expect(thread.line).toBe(5)
    await writeFile(
      path.join(root, 'inbox', 'Plan.md'),
      '# Plan\n\nA new paragraph first.\n\nShip the beta in October.\n\nThe migration runs at night.\n'
    )
    const [moved] = await listCommentThreads(backend, NOTE)
    expect(moved.line).toBe(7)
  })

  it('refuses an empty body, an unknown id, and text that is not in the note', async () => {
    await expect(addComment(backend, { path: NOTE, body: '   ' })).rejects.toThrow(/empty/)
    await expect(addComment(backend, { path: NOTE, body: 'x', anchorText: 'not here' })).rejects.toThrow(/not found/)
    await expect(replyToComment(backend, { path: NOTE, id: 'nope', body: 'x' })).rejects.toThrow(/No comment with id/)
    await expect(resolveComment(backend, { path: NOTE, id: 'nope' })).rejects.toThrow(/No comment with id/)
    expect(await listCommentThreads(backend, NOTE)).toEqual([])
  })
})
