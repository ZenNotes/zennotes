import { useEffect, useMemo, useState } from 'react'
import type { NoteMeta } from '@shared/ipc'
import { extractTagBlocks, tagBlockJumpOffset, type TagBlock } from '@shared/tag-blocks'
import { useStore } from '../store'

/**
 * Block-level tag occurrences for the Tags view (#837), indexed on demand.
 *
 * The note-level index (`NoteMeta.tags`) already says which notes carry a tag,
 * so this reads only those notes, through the `readNote` bridge every host
 * implements (a local vault, a remote workspace, the web client), and keeps
 * the blocks found in each one stamped with the note's `updatedAt` and `size`.
 * A watcher update changes the stamp, so a stale entry is never served, and
 * nothing is read at boot or while the Tags view is closed. A note open in the
 * editor is read from its buffer instead, so a block typed a moment ago lists
 * before it is saved.
 */

type Scope = string

interface CachedBlocks {
  stamp: string
  blocks: readonly TagBlock[]
}

interface ReadJob {
  id: string
  scope: Scope
  path: string
  stamp: string
}

const MAX_CONCURRENT_READS = 6
const MAX_CACHED_NOTES = 6000
const MAX_LIVE_BODIES = 64
const NOTIFY_DELAY_MS = 40
const EMPTY_BLOCKS: readonly TagBlock[] = []

let cacheScope: Scope | null = null
const cache = new Map<string, CachedBlocks>()
const liveBodies = new Map<string, { body: string; blocks: readonly TagBlock[] }>()
const queue: ReadJob[] = []
const queuedIds = new Set<string>()
let activeReads = 0
const listeners = new Set<() => void>()
let notifyTimer: ReturnType<typeof setTimeout> | null = null

function stampOf(note: Pick<NoteMeta, 'updatedAt' | 'size'>): string {
  return `${note.updatedAt}:${note.size}`
}

function useScope(): Scope {
  return useStore(
    (s) =>
      `${s.workspaceMode}\0${s.vault?.root ?? ''}\0${s.remoteWorkspaceInfo?.baseUrl ?? ''}\0${
        s.remoteWorkspaceInfo?.profileId ?? ''
      }`
  )
}

/** A different vault or workspace: nothing cached for the old one applies. */
function enterScope(scope: Scope): void {
  if (cacheScope === scope) return
  cacheScope = scope
  cache.clear()
  liveBodies.clear()
  queue.length = 0
  queuedIds.clear()
}

function remember(path: string, entry: CachedBlocks): void {
  cache.delete(path)
  cache.set(path, entry)
  if (cache.size > MAX_CACHED_NOTES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
}

function blocksFromLiveBody(path: string, body: string): readonly TagBlock[] {
  const memo = liveBodies.get(path)
  if (memo && memo.body === body) return memo.blocks
  const blocks = extractTagBlocks(body)
  liveBodies.delete(path)
  liveBodies.set(path, { body, blocks })
  if (liveBodies.size > MAX_LIVE_BODIES) {
    const oldest = liveBodies.keys().next().value
    if (oldest !== undefined) liveBodies.delete(oldest)
  }
  return blocks
}

function scheduleNotify(): void {
  if (notifyTimer !== null) return
  notifyTimer = setTimeout(() => {
    notifyTimer = null
    for (const listener of listeners) listener()
  }, NOTIFY_DELAY_MS)
}

function request(scope: Scope, note: NoteMeta): void {
  const stamp = stampOf(note)
  const id = `${note.path}\0${stamp}`
  if (queuedIds.has(id)) return
  queuedIds.add(id)
  queue.push({ id, scope, path: note.path, stamp })
  pump()
}

function pump(): void {
  while (activeReads < MAX_CONCURRENT_READS && queue.length > 0) {
    const job = queue.shift() as ReadJob
    activeReads += 1
    // Through a promise, so a host without the call rejects instead of
    // throwing inside the effect that asked.
    void Promise.resolve()
      .then(() => window.zen.readNote(job.path))
      .then(
        (content) => {
          if (cacheScope === job.scope) {
            remember(job.path, { stamp: job.stamp, blocks: extractTagBlocks(content.body) })
          }
        },
        () => {
          // Unreadable right now (moved, mid-rename, offline remote): list the
          // note without blocks until its stamp changes, rather than retrying
          // the same read on every render.
          if (cacheScope === job.scope) remember(job.path, { stamp: job.stamp, blocks: EMPTY_BLOCKS })
        }
      )
      .finally(() => {
        activeReads -= 1
        queuedIds.delete(job.id)
        scheduleNotify()
        pump()
      })
  }
}

export interface TagBlockIndex {
  /** Blocks per note path, for every note whose body has been read. */
  blocksByPath: ReadonlyMap<string, readonly TagBlock[]>
  /** Notes still waiting for their body. */
  pending: number
}

/**
 * The tagged blocks of `notes`, filling in as their bodies are read. Pass
 * only the notes the Tags view lists: their count is the cost.
 */
export function useTagBlockIndex(notes: readonly NoteMeta[]): TagBlockIndex {
  const scope = useScope()
  const activeNote = useStore((s) => s.activeNote)
  const noteContents = useStore((s) => s.noteContents)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const listener = (): void => setRevision((r) => r + 1)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      // The last Tags view closed: reads nobody waits for are dropped. Reads
      // already in flight finish into the cache.
      if (listeners.size === 0) {
        for (const job of queue) queuedIds.delete(job.id)
        queue.length = 0
      }
    }
  }, [])

  const { index, missing } = useMemo(() => {
    enterScope(scope)
    const blocksByPath = new Map<string, readonly TagBlock[]>()
    const missing: NoteMeta[] = []
    for (const note of notes) {
      const live =
        activeNote && activeNote.path === note.path
          ? activeNote.body
          : noteContents[note.path]?.body
      if (live != null) {
        blocksByPath.set(note.path, blocksFromLiveBody(note.path, live))
        continue
      }
      const cached = cache.get(note.path)
      if (cached && cached.stamp === stampOf(note)) {
        blocksByPath.set(note.path, cached.blocks)
        continue
      }
      missing.push(note)
    }
    return { index: { blocksByPath, pending: missing.length }, missing }
    // `revision` is not read here: it re-runs this after a batch of reads
    // lands in the cache.
  }, [notes, activeNote, noteContents, scope, revision])

  useEffect(() => {
    for (const note of missing) request(scope, note)
  }, [missing, scope])

  return index
}

/**
 * Open a note at a tagged block's first line, highlighted, the way a task
 * opens from the Tasks view. The offset comes from the body as it is now (the
 * open buffer when there is one), so an edit since the list was built cannot
 * send the caret to a stale position. Recorded as a jump, so Ctrl+O comes
 * back. Resolves false when the note could not be read.
 */
export async function openTaggedBlock(path: string, startLine: number): Promise<boolean> {
  const state = useStore.getState()
  let body =
    state.activeNote?.path === path ? state.activeNote.body : state.noteContents[path]?.body
  if (body == null) {
    try {
      body = (await window.zen.readNote(path)).body
    } catch (err) {
      console.error('open tagged block: readNote failed', err)
      return false
    }
  }
  await useStore.getState().openNoteAtOffset(path, tagBlockJumpOffset(body, startLine), {
    scrollMode: 'center',
    highlightLine: true
  })
  return true
}
