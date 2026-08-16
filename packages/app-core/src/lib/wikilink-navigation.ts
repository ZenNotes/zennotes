import { useStore } from '../store'
import { findBlockAnchor } from './block-anchors'
import { parseOutline } from './outline'
import { listDatabaseLinkTargets, resolveDatabaseWikilink } from './database-links'
import { wikilinkBlockAnchor, wikilinkHeadingAnchor } from './wikilinks'

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
  const body = await noteBody(path)
  const needle = headingAnchor.trim().toLowerCase()
  const heading = parseOutline(body).find((h) => h.text.trim().toLowerCase() === needle)
  if (heading) {
    await useStore.getState().openNoteAtOffset(path, heading.from, { scrollMode: 'start' })
  } else {
    await useStore.getState().selectNote(path)
  }
}

/**
 * Open `path` and scroll to the block marked `^blockAnchor`. The block-level
 * twin of {@link openWikilinkHeading}, with the same fallback: an id the note
 * no longer carries opens the note at the top rather than going nowhere. (#601)
 */
export async function openWikilinkBlock(path: string, blockAnchor: string): Promise<void> {
  const block = findBlockAnchor(await noteBody(path), blockAnchor)
  if (block) {
    await useStore.getState().openNoteAtOffset(path, block.from, { scrollMode: 'start' })
  } else {
    await useStore.getState().selectNote(path)
  }
}

/**
 * Open the note at `path` at whatever a raw wikilink target points to: a
 * `#heading`, a `^block`, or the top of the note.
 *
 * Every click surface used to repeat this branch, which is why `^block` links
 * quietly opened the note and stopped there for as long as they did: adding an
 * anchor kind meant remembering six call sites. (#601)
 */
export async function openWikilinkTarget(path: string, target: string): Promise<void> {
  const heading = wikilinkHeadingAnchor(target)
  if (heading) return openWikilinkHeading(path, heading)

  const block = wikilinkBlockAnchor(target)
  if (block) return openWikilinkBlock(path, block)

  await useStore.getState().selectNote(path)
}

/** The note's body from the store, falling back to a read, then to empty. */
async function noteBody(path: string): Promise<string> {
  const cached = useStore.getState().noteContents[path]?.body
  if (cached != null) return cached
  try {
    return (await window.zen.readNote(path)).body
  } catch {
    return ''
  }
}
