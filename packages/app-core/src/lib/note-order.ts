import { naturalCompare } from './natural-sort'

export type NoteSortOrder =
  | 'none'
  | 'manual'
  | 'updated-desc'
  | 'updated-asc'
  | 'created-desc'
  | 'created-asc'
  | 'name-asc'
  | 'name-desc'

interface SortableNote {
  readonly title: string
  readonly updatedAt: number
  readonly createdAt: number
}

/** Mobile Browse has no manual drag order; none/manual retain its recent-first fallback. */
export function browseNoteComparator(
  order: NoteSortOrder
): (a: SortableNote, b: SortableNote) => number {
  switch (order) {
    case 'name-asc':
      return (a, b) => naturalCompare(a.title, b.title)
    case 'name-desc':
      return (a, b) => naturalCompare(b.title, a.title)
    case 'updated-asc':
      return (a, b) => a.updatedAt - b.updatedAt
    case 'created-desc':
      return (a, b) => b.createdAt - a.createdAt
    case 'created-asc':
      return (a, b) => a.createdAt - b.createdAt
    default:
      return (a, b) => b.updatedAt - a.updatedAt
  }
}
