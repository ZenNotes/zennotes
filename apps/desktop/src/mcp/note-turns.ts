/**
 * Tool calls are handled concurrently, and a read of a note followed by a write
 * of it would lose whatever landed in between, so whatever edits one note takes
 * turns: the tools the agent edit recorder wraps, and the link rewrite after an
 * attachment moves.
 */

import { realpathSync } from 'node:fs'
import path from 'node:path'
import { foldMcpScopePath } from '@shared/mcp-scope'

const queues = new Map<string, Promise<unknown>>()

export function oneAtATime<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.then(run, run)
  queues.set(key, next)
  const forget = (): void => {
    if (queues.get(key) === next) queues.delete(key)
  }
  next.then(forget, forget)
  return next
}

/** Where a path really leads, through folder links; what does not exist yet
 *  stays as written. */
function realPath(abs: string): string {
  const below: string[] = []
  let at = abs
  for (;;) {
    try {
      return path.join(realpathSync.native(at), ...below)
    } catch {
      const parent = path.dirname(at)
      if (parent === at) return abs
      below.unshift(path.basename(at))
      at = parent
    }
  }
}

/**
 * One turn per note, however a path spells it: the tools take a client's text
 * and the link rewrite the listed path. The path is read the way the vault reads
 * it, followed through links, then folded as a case- or normalization-insensitive
 * volume would. Two notes a sensitive volume keeps apart only wait for each
 * other. All of it is synchronous, so a call keeps the place it arrived in.
 */
export function noteTurn<T>(root: string, rel: string, run: () => Promise<T>): Promise<T> {
  return oneAtATime(foldMcpScopePath(realPath(path.resolve(root, rel))), run)
}
