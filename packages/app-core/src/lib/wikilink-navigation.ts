import { useStore } from '../store'
import { parseOutline } from './outline'

/**
 * Open `path` and scroll to the heading matching `headingAnchor`
 * (case-insensitive, like Obsidian). Falls back to opening the note at the top
 * when the heading isn't found. Shared by the editor's wikilink click and the
 * preview pane so `[[Doc#Heading]]` lands on the heading. (#196)
 */
export async function openWikilinkHeading(path: string, headingAnchor: string): Promise<void> {
  const s = useStore.getState()
  let body = s.noteContents[path]?.body
  if (body == null) {
    try {
      body = (await window.zen.readNote(path)).body
    } catch {
      body = ''
    }
  }
  const needle = headingAnchor.trim().toLowerCase()
  const heading = parseOutline(body).find((h) => h.text.trim().toLowerCase() === needle)
  if (heading) {
    await s.openNoteAtOffset(path, heading.from, { scrollMode: 'start' })
  } else {
    await s.selectNote(path)
  }
}
