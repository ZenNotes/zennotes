import { useStore } from '../store'
import { offerCreateNoteFromLink } from './create-note-from-link'
import { externalFileLink, openExternalFileLink } from './external-file-link'
import { externalLinkUrl, resolveInternalNoteHref } from './internal-links'
import { resolveWikilinkPath } from './wikilinks'
import {
  openDatabaseFromWikilink,
  openWikilinkTarget
} from './wikilink-navigation'

/**
 * Follow a link target from the active note. The `target` is either a
 * `[[wikilink]]` name (e.g. `Doc` or `Doc#Heading`) or a Markdown/URL href
 * (e.g. `Note.md`, `https://…`, `~/file.txt`). Routes, in order, to an external
 * URL, a relative Markdown link, a wikilink, a `.base` database, a file outside
 * the vault, or (for a dead link) an offer to create the note.
 *
 * Shared so links follow the same way wherever they're rendered — the main
 * editor's click / Cmd-click handlers and the WYSIWYG table cell both call this
 * (#445). Returns true when it handled the target.
 */
export function followLinkTarget(target: string): boolean {
  const external = externalLinkUrl(target)
  if (external) {
    window.open(external, '_blank')
    return true
  }
  const state = useStore.getState()
  const focusSoon = (): void => {
    state.setFocusedPanel('editor')
    requestAnimationFrame(() => useStore.getState().editorViewRef?.focus())
  }
  const internal = resolveInternalNoteHref(state.selectedPath, target, state.notes)
  if (internal) {
    if (internal.anchor) void openWikilinkTarget(internal.path, `#${internal.anchor}`).then(focusSoon)
    else void state.selectNote(internal.path).then(focusSoon)
    return true
  }
  const wikilinkPath = resolveWikilinkPath(state.notes, target, state.selectedPath)
  if (wikilinkPath) {
    void openWikilinkTarget(wikilinkPath, target).then(focusSoon)
    return true
  }
  if (openDatabaseFromWikilink(target)) {
    focusSoon()
    return true
  }
  // A link to a file outside the vault (`~/…`, `file://…`, an absolute path):
  // open it with the OS default app instead of treating it as a note. (#424)
  if (externalFileLink(target)) {
    void openExternalFileLink(target)
    return true
  }
  // Dead link — don't leave it a silent dead end. Offer to create the note (with
  // a confirmation), matching the `gd` follow-link path. (Discord: dead links)
  void offerCreateNoteFromLink(target)
  return true
}
