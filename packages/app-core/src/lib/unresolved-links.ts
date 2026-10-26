import type { FolderEntry, NoteMeta, VaultSettings } from '@shared/ipc'
import { collectUnresolvedLinks, type UnresolvedLinkGroup } from '@shared/unresolved-links'
import { resolveAssetPathAmong, type AssetPathRef } from './asset-path-resolution'
import {
  listDatabaseLinkTargets,
  resolveDatabaseWikilink,
  type DatabaseLinkTarget
} from './database-links'
import { isSameFileBlockLink, isSameFileHeadingLink, resolveWikilinkTarget } from './wikilinks'

type NoteRef = Pick<NoteMeta, 'path' | 'title' | 'folder'>

/** The vault lists a wikilink can reach into. */
export interface WikilinkReachContext {
  notes: NoteRef[]
  databases: DatabaseLinkTarget[]
  assets: ReadonlyArray<AssetPathRef>
}

/**
 * Whether a wikilink target written in the note at `fromPath` reaches
 * something: a note, a spot in this note, a `.base` database, or a file in
 * the vault. Anything else would create a note when followed.
 *
 * The one decision behind both the editor's unresolved look (#768) and the
 * Unresolved Links view, so a link the editor draws as broken is exactly a
 * link the view lists. `fromPath` matters for files only: an embed resolves
 * relative to the note it sits in.
 */
export function wikilinkReaches(
  target: string,
  fromPath: string,
  context: WikilinkReachContext
): boolean {
  return (
    resolveWikilinkTarget(context.notes, target) != null ||
    isSameFileHeadingLink(target) ||
    isSameFileBlockLink(target) ||
    resolveDatabaseWikilink(context.databases, target) != null ||
    resolveAssetPathAmong(context.assets, fromPath, target) != null
  )
}

/** Database link targets for a vault, or none when its folders cannot be read. */
export function databaseLinkTargetsFor(
  folders: FolderEntry[] | null | undefined,
  vaultSettings: VaultSettings | null | undefined
): DatabaseLinkTarget[] {
  if (!Array.isArray(folders) || !vaultSettings) return []
  try {
    return listDatabaseLinkTargets(folders, vaultSettings)
  } catch {
    return []
  }
}

/**
 * Every missing note the vault links to, grouped by the note each link names,
 * from the index's per-note link lists. See `collectUnresolvedLinks`.
 */
export function vaultUnresolvedLinks<N extends NoteRef & Pick<NoteMeta, 'wikilinks'>>(
  notes: N[],
  context: Omit<WikilinkReachContext, 'notes'>
): UnresolvedLinkGroup<N>[] {
  const reach: WikilinkReachContext = { ...context, notes }
  return collectUnresolvedLinks(notes, (target, note) => wikilinkReaches(target, note.path, reach))
}
