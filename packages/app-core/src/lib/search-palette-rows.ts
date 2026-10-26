import type { NoteMeta } from '@shared/ipc'
import type { TagBlock } from '@shared/tag-blocks'

/** Tagged blocks listed under one note before the "+N more" row (#837). */
export const SEARCH_BLOCKS_PER_NOTE = 2

/**
 * A row of the Search notes palette. With a `#tag` in the query (and the
 * "Show tagged blocks in note search" setting on), a note is followed by up to
 * SEARCH_BLOCKS_PER_NOTE of its tagged blocks and, when it has more, a row
 * that opens the rest in the Tags view. The create row stays last and is
 * added by the palette itself.
 */
export type SearchPaletteRow =
  | { kind: 'note'; key: string; note: NoteMeta }
  | { kind: 'block'; key: string; note: NoteMeta; block: TagBlock }
  | { kind: 'more'; key: string; note: NoteMeta; hidden: number }

export interface SearchPaletteRowInput {
  /** The ranked note results, as `searchNoteIndex` returns them. */
  results: readonly NoteMeta[]
  /** Every listable note carrying all the query's tags. With free text, a note
   *  whose tagged block matches it is listed even when its title, path and
   *  excerpt do not, since the idea can sit anywhere in the body. */
  tagged: readonly NoteMeta[]
  blocksByPath: ReadonlyMap<string, readonly TagBlock[]>
  /** The query's `#tag` tokens, lowercased. */
  tagTokens: readonly string[]
  freeText: string
  /** The "Show tagged blocks in note search" setting. */
  enabled: boolean
  /** Most note rows to list. */
  limit: number
}

/**
 * Build the palette's rows.
 *
 * Without a tag, or with the setting off, every result is a plain note row,
 * exactly the list the palette always showed. With tags, notes must still
 * carry all of them (the search already decided that); under each note the
 * blocks carrying ANY of the tags are listed, those carrying all of them
 * first, then in document order.
 *
 * Free text after the tags narrows the blocks to those whose text contains it
 * (the Tags view filter's rule), and a note with a matching block is listed
 * first. A note that matched only by its title, path or excerpt is a plain
 * note row: its blocks did not match what was typed.
 */
export function buildSearchPaletteRows(input: SearchPaletteRowInput): SearchPaletteRow[] {
  const { results, tagged, blocksByPath, tagTokens, enabled, limit } = input
  if (!enabled || tagTokens.length === 0) {
    return results.map((note) => ({ kind: 'note', key: note.path, note }))
  }

  const wanted = new Set(tagTokens.map((t) => t.toLowerCase()))
  const q = input.freeText.trim().toLowerCase()

  const blocksFor = (note: NoteMeta): TagBlock[] => {
    const carrying = (blocksByPath.get(note.path) ?? []).filter((block) =>
      block.tags.some((tag) => wanted.has(tag.toLowerCase()))
    )
    const narrowed = q ? carrying.filter((block) => block.text.toLowerCase().includes(q)) : carrying
    const carriesAll = (block: TagBlock): boolean => {
      const have = new Set(block.tags.map((tag) => tag.toLowerCase()))
      for (const tag of wanted) if (!have.has(tag)) return false
      return true
    }
    // Stable: blocks carrying every tag keep their document order, then the rest.
    return [...narrowed.filter(carriesAll), ...narrowed.filter((b) => !carriesAll(b))]
  }

  let notes: readonly NoteMeta[] = results
  if (q) {
    const rank = new Map(results.map((note, i) => [note.path, i]))
    const withBlocks = tagged
      .filter((note) => blocksFor(note).length > 0)
      .sort(
        (a, b) =>
          (rank.get(a.path) ?? Infinity) - (rank.get(b.path) ?? Infinity) ||
          b.updatedAt - a.updatedAt
      )
    const listed = new Set(withBlocks.map((note) => note.path))
    notes = [...withBlocks, ...results.filter((note) => !listed.has(note.path))].slice(0, limit)
  }

  const rows: SearchPaletteRow[] = []
  for (const note of notes) {
    rows.push({ kind: 'note', key: note.path, note })
    const blocks = blocksFor(note)
    for (const block of blocks.slice(0, SEARCH_BLOCKS_PER_NOTE)) {
      rows.push({ kind: 'block', key: `${note.path}\0${block.startLine}`, note, block })
    }
    if (blocks.length > SEARCH_BLOCKS_PER_NOTE) {
      rows.push({
        kind: 'more',
        key: `${note.path}\0more`,
        note,
        hidden: blocks.length - SEARCH_BLOCKS_PER_NOTE
      })
    }
  }
  return rows
}
