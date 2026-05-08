import type { NoteFolder, NoteMeta } from '@shared/ipc'
import {
  getSidebarEdgePrefetchPaths,
  SIDEBAR_PROGRESSIVE_INITIAL_ROWS
} from './sidebar-progressive'

export type NotePrefetchSortOrder =
  | 'none'
  | 'updated-desc'
  | 'updated-asc'
  | 'created-desc'
  | 'created-asc'
  | 'name-asc'
  | 'name-desc'

export const INITIAL_VISIBLE_NOTE_PREFETCH_BATCH_SIZE = 24
export const INITIAL_PREFETCH_FOLDERS: readonly NoteFolder[] = [
  'quick',
  'inbox',
  'archive',
  'trash'
]

function noteSortComparator(order: NotePrefetchSortOrder): ((a: NoteMeta, b: NoteMeta) => number) | null {
  switch (order) {
    case 'updated-asc':
      return (a, b) => a.updatedAt - b.updatedAt
    case 'updated-desc':
      return (a, b) => b.updatedAt - a.updatedAt
    case 'created-asc':
      return (a, b) => a.createdAt - b.createdAt
    case 'created-desc':
      return (a, b) => b.createdAt - a.createdAt
    case 'name-asc':
      return (a, b) => a.title.localeCompare(b.title)
    case 'name-desc':
      return (a, b) => b.title.localeCompare(a.title)
    case 'none':
      return null
  }
}

export function selectInitialVisibleNotePrefetchPaths(
  notes: readonly NoteMeta[],
  noteSortOrder: NotePrefetchSortOrder,
  options: {
    folders?: readonly NoteFolder[]
    batchSize?: number
    visibleRows?: number
    edgeRows?: number
  } = {}
): string[] {
  const folders = options.folders ?? INITIAL_PREFETCH_FOLDERS
  const batchSize = Math.max(
    0,
    Math.floor(options.batchSize ?? INITIAL_VISIBLE_NOTE_PREFETCH_BATCH_SIZE)
  )
  if (notes.length === 0 || folders.length === 0 || batchSize === 0) return []

  const visibleRows = Math.max(
    0,
    Math.floor(options.visibleRows ?? SIDEBAR_PROGRESSIVE_INITIAL_ROWS)
  )
  if (visibleRows === 0) return []

  const comparator = noteSortComparator(noteSortOrder)
  const queues = folders
    .map((folder) => {
      const folderNotes = notes
        .filter((note) => note.folder === folder)
        .slice()
        .sort(comparator ?? ((a, b) => a.siblingOrder - b.siblingOrder))
      const visiblePaths = folderNotes.slice(0, visibleRows).map((note) => note.path)
      return getSidebarEdgePrefetchPaths(visiblePaths, options.edgeRows)
    })
    .filter((paths) => paths.length > 0)

  const selected = new Set<string>()
  let madeProgress = true
  while (selected.size < batchSize && madeProgress) {
    madeProgress = false
    for (const queue of queues) {
      while (queue.length > 0) {
        const path = queue.shift()
        if (!path || selected.has(path)) continue
        selected.add(path)
        madeProgress = true
        break
      }
      if (selected.size >= batchSize) return [...selected]
    }
  }

  return [...selected]
}
