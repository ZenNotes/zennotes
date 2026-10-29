/**
 * Covers for the Gallery's cards, read on demand.
 *
 * The vault index (NoteMeta) carries no cover, and giving it one would change
 * the desktop scan, the Go server and the phones' vault code. So a card asks
 * for its note's cover when it comes on screen: the note is read through the
 * same bridge read the editor uses (an open note's buffer, when there is one,
 * is fresher and costs nothing) and its frontmatter goes through the shared
 * parser. A 1000-note folder reads the twenty notes on screen, not a
 * thousand.
 *
 * Each answer is kept against the note's path and its `updatedAt`, so a note
 * edited elsewhere is read again and an unchanged one never is. The cache is
 * per workspace (a local vault, a remote server): switching clears it.
 */
import type { NoteMeta } from '@shared/ipc'
import { readNoteCover, type NoteCover } from '@shared/note-cover'

type CoverNote = Pick<NoteMeta, 'path' | 'updatedAt'>

interface CoverEntry {
  updatedAt: number
  cover: NoteCover | null
}

/** Enough for every card of a large folder scrolled end to end; past it the
 *  oldest answers go first. */
const DEFAULT_LIMIT = 5000

export class GalleryCoverCache {
  private entries = new Map<string, CoverEntry>()
  private pending = new Map<string, Promise<NoteCover | null>>()
  private scope = ''

  constructor(private readonly limit: number = DEFAULT_LIMIT) {}

  /** Point the cache at a workspace; a different one starts it empty. */
  setScope(scope: string): void {
    if (scope === this.scope) return
    this.scope = scope
    this.entries.clear()
    this.pending.clear()
  }

  /** The note's cover when it is known for this version of the note: a cover,
   *  null for none, undefined while it has not been read. */
  peek(note: CoverNote): NoteCover | null | undefined {
    const entry = this.entries.get(note.path)
    return entry && entry.updatedAt === note.updatedAt ? entry.cover : undefined
  }

  /**
   * The note's cover, reading it once. Calls for the same version of a note
   * share one read. A note that cannot be read has no cover until it changes:
   * a card draws its placeholder rather than asking again on every scroll.
   */
  load(note: CoverNote, readBody: (path: string) => Promise<string>): Promise<NoteCover | null> {
    const known = this.peek(note)
    if (known !== undefined) return Promise.resolve(known)
    const key = `${note.path}\0${note.updatedAt}`
    const inFlight = this.pending.get(key)
    if (inFlight) return inFlight
    const scope = this.scope
    const read = readBody(note.path)
      .then((body) => readNoteCover(body), () => null)
      .then((cover) => {
        if (this.scope === scope) {
          this.pending.delete(key)
          this.remember(note, cover)
        }
        return cover
      })
    this.pending.set(key, read)
    return read
  }

  get size(): number {
    return this.entries.size
  }

  private remember(note: CoverNote, cover: NoteCover | null): void {
    this.entries.delete(note.path)
    this.entries.set(note.path, { updatedAt: note.updatedAt, cover })
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }
}

/** The one cache every Gallery tab shares. */
export const galleryCoverCache = new GalleryCoverCache()

/**
 * Run `work` over `items`, at most `limit` at a time, in order. Stops taking
 * new items once `cancelled()` says so; items already started finish.
 */
export async function runLimited<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
  cancelled: () => boolean = () => false
): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length && !cancelled()) {
      const item = items[next++]
      try {
        await work(item)
      } catch {
        // One failed item does not stop the rest.
      }
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker)
  await Promise.all(workers)
}
