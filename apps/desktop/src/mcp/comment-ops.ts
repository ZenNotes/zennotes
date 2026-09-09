/**
 * Comment operations for the MCP tools and `zn comment` (#738), composed
 * from a backend's note read and comment read/write so a local folder and a
 * ZenNotes server behave the same. The shapes here are what a model sees:
 * threads (a top-level comment with its replies), the anchored text and the
 * line it sits on today, and who said what.
 */

import {
  lineOfOffset,
  resolveCommentAnchor,
  threadNoteComments,
  threadRootOf
} from '@shared/note-comments'
import type { NoteComment, NoteCommentInput } from '@shared/ipc'
import type { VaultBackend } from '../cli/backend.js'

export interface CommentView {
  id: string
  author: string | null
  body: string
  createdAt: number
  updatedAt: number
}

export interface CommentThreadView extends CommentView {
  /** The text the comment was written on, as stored. Empty for a note-level comment. */
  anchorText: string
  /** 1-based line the anchor sits on in the note as it is now. */
  line: number
  resolved: boolean
  resolvedAt: number | null
  replies: CommentView[]
}

function view(comment: NoteComment): CommentView {
  return {
    id: comment.id,
    author: comment.author ?? null,
    body: comment.body,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt
  }
}

export async function listCommentThreads(
  backend: VaultBackend,
  rel: string,
  opts: { includeResolved?: boolean } = {}
): Promise<CommentThreadView[]> {
  const [note, comments] = await Promise.all([backend.readNote(rel), backend.listComments(rel)])
  const doc = note.body
  return threadNoteComments(comments)
    .filter((thread) => opts.includeResolved || thread.comment.resolvedAt == null)
    .map((thread) => ({
      ...view(thread.comment),
      anchorText: thread.comment.anchorText,
      line: lineOfOffset(doc, resolveCommentAnchor(thread.comment, doc).from),
      resolved: thread.comment.resolvedAt != null,
      resolvedAt: thread.comment.resolvedAt,
      replies: thread.replies.map(view)
    }))
}

/**
 * Where a new comment attaches. `anchorText` must appear in the note as
 * written (an exact match first, then one ignoring case); without it the
 * comment is note-level, anchored at the top.
 */
export function anchorForText(
  doc: string,
  anchorText: string | undefined
): Pick<NoteComment, 'anchorStart' | 'anchorEnd' | 'anchorText'> {
  const wanted = (anchorText ?? '').trim()
  if (!wanted) return { anchorStart: 0, anchorEnd: 0, anchorText: '' }
  let at = doc.indexOf(wanted)
  if (at < 0) at = doc.toLowerCase().indexOf(wanted.toLowerCase())
  if (at < 0) {
    throw new Error(
      `anchor_text was not found in the note. Pass the text exactly as it appears (read_note shows it), or omit it for a note-level comment.`
    )
  }
  return {
    anchorStart: at,
    anchorEnd: at + wanted.length,
    anchorText: doc.slice(at, at + wanted.length).replace(/\s+/g, ' ').trim().slice(0, 500)
  }
}

export async function addComment(
  backend: VaultBackend,
  input: { path: string; body: string; anchorText?: string; author?: string }
): Promise<CommentThreadView> {
  const body = input.body.trim()
  if (!body) throw new Error('body must not be empty')
  const note = await backend.readNote(input.path)
  const anchor = anchorForText(note.body, input.anchorText)
  const now = Date.now()
  const current = await backend.listComments(input.path)
  const draft: NoteCommentInput = {
    notePath: input.path,
    ...anchor,
    body,
    author: input.author,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null
  }
  const written = await backend.writeComments(input.path, [...current, draft])
  const created = written.find((c) => c.createdAt === now && c.body === body) ?? written[written.length - 1]
  const threads = await listCommentThreads(backend, input.path, { includeResolved: true })
  return threads.find((t) => t.id === created.id) ?? threads[threads.length - 1]
}

export async function replyToComment(
  backend: VaultBackend,
  input: { path: string; id: string; body: string; author?: string }
): Promise<CommentThreadView> {
  const body = input.body.trim()
  if (!body) throw new Error('body must not be empty')
  const current = await backend.listComments(input.path)
  const root = threadRootOf(current, input.id)
  if (!root) throw new Error(`No comment with id ${input.id} on ${input.path}. Use list_comments to find ids.`)
  const now = Date.now()
  const draft: NoteCommentInput = {
    notePath: input.path,
    anchorStart: root.anchorStart,
    anchorEnd: root.anchorEnd,
    anchorText: root.anchorText,
    body,
    author: input.author,
    parentId: root.id,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null
  }
  await backend.writeComments(input.path, [...current, draft])
  const threads = await listCommentThreads(backend, input.path, { includeResolved: true })
  const thread = threads.find((t) => t.id === root.id)
  if (!thread) throw new Error(`Thread ${root.id} vanished while replying`)
  return thread
}

export async function resolveComment(
  backend: VaultBackend,
  input: { path: string; id: string; resolved?: boolean }
): Promise<CommentThreadView> {
  const current = await backend.listComments(input.path)
  const root = threadRootOf(current, input.id)
  if (!root) throw new Error(`No comment with id ${input.id} on ${input.path}. Use list_comments to find ids.`)
  const resolved = input.resolved ?? true
  const now = Date.now()
  const next = current.map((c) =>
    c.id === root.id ? { ...c, resolvedAt: resolved ? now : null, updatedAt: now } : c
  )
  await backend.writeComments(input.path, next)
  const threads = await listCommentThreads(backend, input.path, { includeResolved: true })
  const thread = threads.find((t) => t.id === root.id)
  if (!thread) throw new Error(`Thread ${root.id} vanished while resolving`)
  return thread
}
