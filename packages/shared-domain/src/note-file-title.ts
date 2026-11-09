/**
 * Make a title safe to use as a filename on macOS, Windows, and Linux:
 * strip path separators, control chars, and reserved characters so a title
 * like "RFC / Design Doc" cannot escape into a nonexistent subdirectory.
 *
 * Desktop main names every new note with this. The renderer uses the same
 * rule to find the note a clip link appends to by its name, so a title that
 * held a `?` finds the file main wrote with a `-`.
 */
export function sanitizeNoteFileTitle(raw: string | undefined): string {
  return (
    (raw ?? '')
      .replace(/[\\/:\u0000-\u001f*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200) || 'Untitled'
  )
}
