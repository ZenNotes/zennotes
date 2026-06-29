import { useStore } from '../store'
import { parseOutline } from './outline'
import { listDatabaseLinkTargets, resolveDatabaseWikilink } from './database-links'

/**
 * If `target` names a `.base` database, open its grid and return true; otherwise
 * return false so the caller can fall back to note resolution / link creation.
 * Shared by every wikilink click surface (live preview, Cmd-click, preview pane)
 * so `[[mydatabase]]` works everywhere. (#238)
 */
export function openDatabaseFromWikilink(target: string): boolean {
  const s = useStore.getState()
  const db = resolveDatabaseWikilink(
    listDatabaseLinkTargets(s.folders, s.vaultSettings),
    target
  )
  if (!db) return false
  void s.openDatabase(db.csvPath)
  return true
}

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
