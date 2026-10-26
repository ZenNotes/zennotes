import type { NoteMeta } from '@shared/ipc'
import type { TagBlock } from '@shared/tag-blocks'

/**
 * The rows the Tags view lists (#837): each matching note, followed by the
 * blocks inside it that carry one of the selected tags. A note tagged only in
 * frontmatter, or one whose blocks have not been read yet, is a note row
 * alone, which is exactly the list the view showed before block results.
 */
export type TagViewRow =
  | { kind: 'note'; key: string; note: NoteMeta; blockCount: number }
  | { kind: 'block'; key: string; note: NoteMeta; block: TagBlock }

export interface TagViewRows {
  rows: TagViewRow[]
  /** Notes listed after the filter. */
  noteCount: number
  /** Blocks listed after the filter. */
  blockCount: number
}

/**
 * Build the Tags view's rows. A block is listed when it carries any selected
 * tag (case-insensitive): the note-level All/Any match already decided which
 * notes appear, and inside a note every block holding one of the tags is a
 * place the user may want to land.
 *
 * The filter keeps a note whose title or path matches together with all its
 * blocks; otherwise the note with only the blocks whose text matches, so
 * typing a word from an idea finds that idea; otherwise, when only the
 * excerpt matches, the note row alone, as the list worked before blocks. The
 * excerpt is the opening of the body, so letting it keep every block would
 * undo the narrowing whenever the idea sits near the top.
 */
export function buildTagViewRows(
  notes: readonly NoteMeta[],
  blocksByPath: ReadonlyMap<string, readonly TagBlock[]>,
  selectedTags: readonly string[],
  filter: string
): TagViewRows {
  const wanted = new Set(selectedTags.map((t) => t.toLowerCase()))
  const q = filter.trim().toLowerCase()
  const rows: TagViewRow[] = []
  let noteCount = 0
  let blockCount = 0
  for (const note of notes) {
    let blocks = (blocksByPath.get(note.path) ?? []).filter((block) =>
      block.tags.some((tag) => wanted.has(tag.toLowerCase()))
    )
    if (q && !note.title.toLowerCase().includes(q) && !note.path.toLowerCase().includes(q)) {
      blocks = blocks.filter((block) => block.text.toLowerCase().includes(q))
      if (blocks.length === 0 && !note.excerpt.toLowerCase().includes(q)) continue
    }
    noteCount += 1
    blockCount += blocks.length
    rows.push({ kind: 'note', key: note.path, note, blockCount: blocks.length })
    for (const block of blocks) {
      rows.push({ kind: 'block', key: `${note.path}\0${block.startLine}`, note, block })
    }
  }
  return { rows, noteCount, blockCount }
}

/** Index of the next note row after `index`, or -1. */
export function nextNoteRowIndex(rows: readonly TagViewRow[], index: number): number {
  for (let i = index + 1; i < rows.length; i++) if (rows[i]?.kind === 'note') return i
  return -1
}

/**
 * Index of the note row `{` moves to from `index`: from a block, its own
 * note; from a note, the note before it. -1 when there is none.
 */
export function previousNoteRowIndex(rows: readonly TagViewRow[], index: number): number {
  for (let i = index - 1; i >= 0; i--) if (rows[i]?.kind === 'note') return i
  return -1
}
