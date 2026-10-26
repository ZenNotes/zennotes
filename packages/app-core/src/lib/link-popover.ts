import { classifyApplicationLink } from '@shared/application-links'
import { externalUrlForLink } from './internal-links'
import { wikilinkReaches, type WikilinkReachContext } from './unresolved-links'
import { findBlockAnchor } from './block-anchors'
import { findHeadingForAnchor } from './heading-anchor'
import { parseOutline } from './outline'
import type { NoteFolder } from '@shared/ipc'
import {
  isSameFileBlockLink,
  isSameFileHeadingLink,
  parseCreateNotePath,
  resolveWikilinkTarget,
  suggestCreateNotePath,
  wikilinkBlockAnchor,
  wikilinkHeadingAnchor
} from './wikilinks'

/** How long the pointer rests on a link before its popover opens. Long
 *  enough that a pointer crossing the text on its way somewhere opens
 *  nothing. */
export const LINK_POPOVER_HOVER_DELAY_MS = 500

/** How long a hover popover survives the pointer leaving the link or the
 *  popover, so the trip between the two does not close it. */
export const LINK_POPOVER_LEAVE_GRACE_MS = 280

export type LinkPopoverTarget = { kind: 'note'; path: string } | { kind: 'missing' }

/**
 * What the link popover shows for a wikilink written in the note at
 * `fromPath`: the note it opens, or an offer to create the note it names.
 * Null for a link the popover has nothing to add to: one into the note
 * being read (`[[#heading]]`, or the note's own name), a `.base` database,
 * a file in the vault, or an address that opens outside the vault.
 */
export function linkPopoverTarget(
  target: string,
  fromPath: string,
  context: WikilinkReachContext
): LinkPopoverTarget | null {
  const name = target.trim()
  if (!name) return null
  if (externalUrlForLink(name, 'wikilink') || classifyApplicationLink(name)) return null
  if (isSameFileHeadingLink(name) || isSameFileBlockLink(name)) return null
  const note = resolveWikilinkTarget(context.notes, name)
  if (note) return note.path === fromPath ? null : { kind: 'note', path: note.path }
  // A database or a file: it has its own tab, and nothing to create.
  if (wikilinkReaches(name, fromPath, context)) return null
  return { kind: 'missing' }
}

/**
 * Where in `body` a link's anchor points: the heading of `[[Doc#Heading]]`,
 * the block of `[[Doc^id]]`. Null for a plain link, or an anchor the note no
 * longer carries; the popover then opens at the top, as following the link
 * would.
 */
export function linkAnchorOffset(body: string, target: string): number | null {
  const heading = wikilinkHeadingAnchor(target)
  if (heading) return findHeadingForAnchor(parseOutline(body), heading)?.from ?? null
  const block = wikilinkBlockAnchor(target)
  if (block) return findBlockAnchor(body, block)?.from ?? null
  return null
}

/**
 * Where creating the note a dead link names puts it: the top folder and the
 * folders under it, as `gD` and the popover's Create would. Null for a link
 * no file can be named after. Surfaces show the folder by its label, since a
 * system folder can live under another directory name.
 */
export function linkCreateDestination(
  target: string
): { folder: NoteFolder; subpath: string } | null {
  try {
    const parsed = parseCreateNotePath(suggestCreateNotePath(target))
    return { folder: parsed.folder, subpath: parsed.subpath }
  } catch {
    return null
  }
}
