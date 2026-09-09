import type { NoteMeta } from '@shared/ipc'
import { resolveAssetPathAmong, type AssetPathRef } from './asset-path-resolution'
import { extractWikilinkTargets, resolveWikilinkTarget, suggestCreateNotePath } from './wikilinks'

type NoteRef = Pick<NoteMeta, 'path' | 'title' | 'folder'>

/** A wikilink that names a file in the vault rather than a note. */
export interface AttachmentLink {
  target: string
  /** Vault-relative path of the file the wikilink resolves to. */
  assetPath: string
}

/** A wikilink no note or file answers; the panel offers to create the note. */
export interface MissingLink {
  target: string
  suggestedPath: string
}

export interface OutgoingWikilinks<T extends NoteRef> {
  resolved: T[]
  attachments: AttachmentLink[]
  missing: MissingLink[]
}

/**
 * Sorts a note's `[[wikilinks]]` (embeds included, the scanner reads `![[x]]`
 * the same) into the notes they reach, the files they reach, and the targets
 * nothing answers. The Connections panel shows each bucket differently, and
 * the distinction between the last two is what #757 was about: an embedded
 * `![[assets/diagram.png]]` used to land in `missing`, and the panel offered
 * to create `assets/diagram.png.md` for it. A wikilink is a file when the
 * asset list has a file it resolves to, by the same rules that render the
 * embed; a name with a file-like extension that resolves to nothing is still
 * missing.
 *
 * First occurrence decides: a target appears in one bucket at most, a note
 * reached by two spellings (`[[Doc]]` and `[[Doc#Heading]]`) is listed once.
 */
export function classifyOutgoingWikilinks<T extends NoteRef>(args: {
  body: string
  notePath: string
  noteTitle: string
  notes: T[]
  assets: ReadonlyArray<AssetPathRef>
}): OutgoingWikilinks<T> {
  const { body, notePath, noteTitle, notes, assets } = args
  const seenTargets = new Set<string>()
  const seenPaths = new Set<string>()
  const resolved: T[] = []
  const attachments: AttachmentLink[] = []
  const missing: MissingLink[] = []
  const selfTitle = noteTitle.toLowerCase()

  for (const rawTarget of extractWikilinkTargets(body)) {
    const target = rawTarget.trim()
    if (!target) continue
    const targetKey = target.toLowerCase()
    if (seenTargets.has(targetKey)) continue
    seenTargets.add(targetKey)

    const note = resolveWikilinkTarget(notes, target)
    if (note) {
      if (note.folder === 'trash' || note.path === notePath) continue
      if (seenPaths.has(note.path)) continue
      seenPaths.add(note.path)
      resolved.push(note)
      continue
    }

    const assetPath = resolveAssetPathAmong(assets, notePath, target)
    if (assetPath) {
      if (seenPaths.has(assetPath)) continue
      seenPaths.add(assetPath)
      attachments.push({ target, assetPath })
      continue
    }

    if (targetKey === selfTitle) continue
    missing.push({ target, suggestedPath: suggestCreateNotePath(target) })
  }

  return { resolved, attachments, missing }
}
