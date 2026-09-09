import type { NoteComment, NoteCommentInput } from './ipc'

/**
 * Note comments on disk and in memory (#738). A note's comments live beside
 * it as `.zennotes/comments/<note path>.comments.json`; this module is the
 * one place that decides what a comment record looks like, shared by the
 * desktop main process, the MCP server and the CLI (the Go server mirrors it
 * in internal/vault). A comment is anchored to the text it was written on,
 * carries an optional `author` (absent for the vault's owner, the name of an
 * assistant otherwise) and an optional `parentId` that threads a reply under
 * a top-level comment, so a note can be discussed like an issue: comment,
 * answer, resolve.
 */

export const NOTE_COMMENTS_DIR = 'comments'
export const NOTE_COMMENTS_SUFFIX = '.comments.json'
export const MAX_COMMENT_ANCHOR_TEXT_LENGTH = 500
export const MAX_COMMENT_AUTHOR_LENGTH = 80

/** Vault-relative posix path of the sidecar that holds `notePath`'s comments. */
export function noteCommentsSidecarPath(internalDir: string, notePath: string): string {
  return `${internalDir}/${NOTE_COMMENTS_DIR}/${notePath}${NOTE_COMMENTS_SUFFIX}`
}

function newCommentId(): string {
  const cryptoApi = globalThis.crypto as { randomUUID?: () => string } | undefined
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID()
  // Node before 19 and very old browsers: a time-salted random id is still
  // unique enough for one note's sidecar.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function normalizeCommentAuthor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const author = value.replace(/\s+/g, ' ').trim().slice(0, MAX_COMMENT_AUTHOR_LENGTH)
  return author || undefined
}

/**
 * Validate one comment record from any source (the app, the file, a tool).
 * A comment with no body is dropped; everything else is coerced into shape.
 */
export function normalizeNoteComment(
  input: NoteCommentInput,
  notePath: string,
  now: number = Date.now()
): NoteComment | null {
  const body = typeof input.body === 'string' ? input.body.trim() : ''
  if (!body) return null
  const rawStart = Number.isFinite(input.anchorStart) ? Math.max(0, Math.floor(input.anchorStart)) : 0
  const rawEnd = Number.isFinite(input.anchorEnd) ? Math.max(0, Math.floor(input.anchorEnd)) : rawStart
  const anchorStart = Math.min(rawStart, rawEnd)
  const anchorEnd = Math.max(rawStart, rawEnd)
  const anchorText =
    typeof input.anchorText === 'string'
      ? input.anchorText.replace(/\s+/g, ' ').trim().slice(0, MAX_COMMENT_ANCHOR_TEXT_LENGTH)
      : ''
  const author = normalizeCommentAuthor(input.author)
  const parentId = typeof input.parentId === 'string' && input.parentId.trim() ? input.parentId.trim() : null
  const comment: NoteComment = {
    id: typeof input.id === 'string' && input.id.trim() ? input.id.trim() : newCommentId(),
    notePath,
    anchorStart,
    anchorEnd,
    anchorText,
    body,
    createdAt: finiteOr(input.createdAt, now),
    updatedAt: finiteOr(input.updatedAt, now),
    resolvedAt: typeof input.resolvedAt === 'number' && Number.isFinite(input.resolvedAt) ? input.resolvedAt : null
  }
  if (author) comment.author = author
  if (parentId) comment.parentId = parentId
  return comment
}

/**
 * Validate a whole sidecar (`{ version, comments }` or a bare array): drop
 * malformed and duplicate records, keep creation order. A reply whose parent
 * is missing is kept as a comment of its own rather than lost.
 */
export function normalizeNoteComments(raw: unknown, notePath: string, now: number = Date.now()): NoteComment[] {
  const values = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { comments?: unknown }).comments)
      ? (raw as { comments: unknown[] }).comments
      : []
  const seen = new Set<string>()
  const comments: NoteComment[] = []
  for (const value of values) {
    if (!value || typeof value !== 'object') continue
    const comment = normalizeNoteComment(value as NoteCommentInput, notePath, now)
    if (!comment || seen.has(comment.id)) continue
    seen.add(comment.id)
    comments.push(comment)
  }
  comments.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  const ids = new Set(comments.map((c) => c.id))
  for (const comment of comments) {
    if (comment.parentId && (!ids.has(comment.parentId) || comment.parentId === comment.id)) {
      delete comment.parentId
    }
  }
  return comments
}

/** A top-level comment with the replies threaded under it, in creation order. */
export interface NoteCommentThread {
  comment: NoteComment
  replies: NoteComment[]
}

/**
 * Group a note's comments into threads. Replies attach to the top-level
 * comment their `parentId` names; a reply to a reply lands in the same
 * thread, so a thread stays one level deep like a review conversation.
 */
export function threadNoteComments(comments: NoteComment[]): NoteCommentThread[] {
  const byId = new Map(comments.map((c) => [c.id, c] as const))
  const rootOf = (comment: NoteComment): NoteComment => {
    let current = comment
    const visited = new Set<string>()
    while (current.parentId && byId.has(current.parentId) && !visited.has(current.id)) {
      visited.add(current.id)
      current = byId.get(current.parentId)!
    }
    return current
  }
  const threads = new Map<string, NoteCommentThread>()
  for (const comment of comments) {
    const root = rootOf(comment)
    if (root === comment) {
      if (!threads.has(comment.id)) threads.set(comment.id, { comment, replies: [] })
      continue
    }
    let thread = threads.get(root.id)
    if (!thread) {
      thread = { comment: root, replies: [] }
      threads.set(root.id, thread)
    }
    thread.replies.push(comment)
  }
  return comments.filter((c) => rootOf(c) === c).map((c) => threads.get(c.id)!)
}

/** The top-level comment `id` belongs to (itself when it is one), or null. */
export function threadRootOf(comments: NoteComment[], id: string): NoteComment | null {
  for (const thread of threadNoteComments(comments)) {
    if (thread.comment.id === id || thread.replies.some((r) => r.id === id)) return thread.comment
  }
  return null
}

export interface ResolvedCommentAnchor {
  from: number
  to: number
}

/**
 * Where a comment's anchor sits in `doc` now: the stored offsets when the
 * text there still matches, else the first occurrence of the anchored text,
 * else the (clamped) stored offsets.
 */
export function resolveCommentAnchor(
  comment: Pick<NoteComment, 'anchorStart' | 'anchorEnd' | 'anchorText'>,
  doc: string
): ResolvedCommentAnchor {
  const docLength = doc.length
  const from = Math.max(0, Math.min(docLength, comment.anchorStart))
  const to = Math.max(from, Math.min(docLength, comment.anchorEnd))
  const selected = doc.slice(from, to)
  if (!comment.anchorText || selected === comment.anchorText) {
    return { from, to }
  }
  const found = doc.indexOf(comment.anchorText)
  if (found >= 0) return { from: found, to: found + comment.anchorText.length }
  return { from, to }
}

export function selectionToCommentAnchor(
  doc: string,
  from: number,
  to: number
): Pick<NoteComment, 'anchorStart' | 'anchorEnd' | 'anchorText'> {
  const start = Math.max(0, Math.min(doc.length, Math.min(from, to)))
  const end = Math.max(start, Math.min(doc.length, Math.max(from, to)))
  const selected = doc.slice(start, end).replace(/\s+/g, ' ').trim()
  return {
    anchorStart: start,
    anchorEnd: end,
    anchorText: selected.slice(0, MAX_COMMENT_ANCHOR_TEXT_LENGTH)
  }
}

export function commentQuote(comment: Pick<NoteComment, 'anchorText'>): string {
  return comment.anchorText.trim() || 'Current cursor position'
}

/** 1-based line number of `offset` in `doc`. */
export function lineOfOffset(doc: string, offset: number): number {
  const at = Math.max(0, Math.min(doc.length, offset))
  let line = 1
  for (let i = 0; i < at; i += 1) if (doc.charCodeAt(i) === 10) line += 1
  return line
}
