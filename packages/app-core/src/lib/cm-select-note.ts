import type { EditorState } from '@codemirror/state'
import type { Command } from '@codemirror/view'
import { leadingTitleHeading } from '@shared/note-heading-sync'

/**
 * Select all, short of the note's title (#1006).
 *
 * A new note is written as `# <title>`, and a rename keeps that heading in
 * step with the file name (#455), so the leading H1 is the note's title as
 * much as the file name is; Live Preview shows it as the large heading at the
 * top of the page. CodeMirror's select all took it along with the text, so
 * typing or pasting over a select all replaced the title too.
 *
 * From the note's text, select all now selects that text: from the first
 * non-blank line under the title to the end of the note. A second press
 * selects the whole note, frontmatter and title included, as select all did
 * before. The first press does too when the cursor is on the title or above
 * it (there the user is editing the title, not the text under it) and in a
 * note without a leading `# ` heading, which has no title to leave out.
 */
function textUnderTitle(state: EditorState): { from: number; to: number; titleEnd: number } | null {
  const heading = leadingTitleHeading(state.doc.toString())
  if (!heading) return null
  const doc = state.doc
  for (let n = doc.lineAt(heading.to).number + 1; n <= doc.lines; n++) {
    const line = doc.line(n)
    if (line.text.trim()) return { from: line.from, to: doc.length, titleEnd: heading.to }
  }
  return null
}

export const selectNoteText: Command = ({ state, dispatch }) => {
  const text = textUnderTitle(state)
  const { ranges, main } = state.selection
  const inText = text !== null && ranges.every((range) => range.from > text.titleEnd)
  const textSelected =
    text !== null && ranges.length === 1 && main.from === text.from && main.to === text.to
  dispatch(
    state.update({
      selection:
        text && inText && !textSelected
          ? { anchor: text.from, head: text.to }
          : { anchor: 0, head: state.doc.length },
      userEvent: 'select'
    })
  )
  return true
}
