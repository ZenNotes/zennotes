/**
 * `zn comment ...` (#738): list, add, reply to and resolve the comments on a
 * note, the same operations the MCP tools expose, so a script or an agent
 * without MCP can join a review thread.
 */

import type { VaultBackend } from '../backend.js'
import { getBool, getString, type ParsedArgs } from '../args.js'
import { emitJson, emitLine, emitOk } from '../format.js'
import {
  addComment,
  listCommentThreads,
  replyToComment,
  resolveComment,
  type CommentThreadView
} from '../../mcp/comment-ops.js'

function requirePath(args: ParsedArgs, usage: string): string {
  const rel = getString(args, 'path') ?? args.positionals[0]
  if (!rel) throw new Error(`Usage: ${usage}`)
  return rel
}

function requireBody(args: ParsedArgs, positionalIndex: number, usage: string): string {
  const body = getString(args, 'body') ?? args.positionals[positionalIndex]
  if (!body || !body.trim()) throw new Error(`Usage: ${usage}`)
  return body
}

function when(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16)
}

function printThread(thread: CommentThreadView): void {
  const who = thread.author ?? 'You'
  const state = thread.resolved ? '  (resolved)' : ''
  emitLine(`${thread.id}  ${who}  ${when(thread.createdAt)}  line ${thread.line}${state}`)
  if (thread.anchorText) emitLine(`  > ${thread.anchorText}`)
  emitLine(`  ${thread.body.replace(/\n/g, '\n  ')}`)
  for (const reply of thread.replies) {
    emitLine(`    ${reply.id}  ${reply.author ?? 'You'}  ${when(reply.createdAt)}`)
    emitLine(`      ${reply.body.replace(/\n/g, '\n      ')}`)
  }
}

export async function cmdCommentList(vault: VaultBackend, args: ParsedArgs): Promise<void> {
  const rel = requirePath(args, 'zn comment list <path> [--all] [--json]')
  const threads = await listCommentThreads(vault, rel, { includeResolved: getBool(args, 'all') })
  if (getBool(args, 'json')) {
    emitJson(threads)
    return
  }
  if (threads.length === 0) {
    emitLine(getBool(args, 'all') ? 'No comments.' : 'No open comments. Pass --all to include resolved ones.')
    return
  }
  threads.forEach((thread, index) => {
    if (index > 0) emitLine('')
    printThread(thread)
  })
}

export async function cmdCommentAdd(vault: VaultBackend, args: ParsedArgs): Promise<void> {
  const usage = 'zn comment add <path> "<body>" [--anchor "<text from the note>"] [--author <name>]'
  const rel = requirePath(args, usage)
  const body = requireBody(args, 1, usage)
  const thread = await addComment(vault, {
    path: rel,
    body,
    anchorText: getString(args, 'anchor'),
    author: getString(args, 'author')
  })
  if (getBool(args, 'json')) {
    emitJson(thread)
    return
  }
  emitOk(`Commented on ${rel} (${thread.id}${thread.anchorText ? `, line ${thread.line}` : ''})`)
}

export async function cmdCommentReply(vault: VaultBackend, args: ParsedArgs): Promise<void> {
  const usage = 'zn comment reply <path> <id> "<body>" [--author <name>]'
  const rel = requirePath(args, usage)
  const id = getString(args, 'id') ?? args.positionals[1]
  if (!id) throw new Error(`Usage: ${usage}`)
  const body = requireBody(args, 2, usage)
  const thread = await replyToComment(vault, { path: rel, id, body, author: getString(args, 'author') })
  if (getBool(args, 'json')) {
    emitJson(thread)
    return
  }
  emitOk(`Replied in ${thread.id} on ${rel} (${thread.replies.length} ${thread.replies.length === 1 ? 'reply' : 'replies'})`)
}

export async function cmdCommentResolve(vault: VaultBackend, args: ParsedArgs): Promise<void> {
  const usage = 'zn comment resolve <path> <id> [--reopen]'
  const rel = requirePath(args, usage)
  const id = getString(args, 'id') ?? args.positionals[1]
  if (!id) throw new Error(`Usage: ${usage}`)
  const reopen = getBool(args, 'reopen')
  const thread = await resolveComment(vault, { path: rel, id, resolved: !reopen })
  if (getBool(args, 'json')) {
    emitJson(thread)
    return
  }
  emitOk(`${reopen ? 'Reopened' : 'Resolved'} ${thread.id} on ${rel}`)
}
