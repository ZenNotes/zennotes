/**
 * Telling a change that came from disk apart from the other ways a note's
 * text changes underneath its editor, and what to do about it (#852).
 *
 * The editor applies every body update the store hands it as a minimal,
 * non-undoable change, and CodeMirror maps the existing undo steps through
 * it. For another pane typing, or a rename rewriting the title heading or a
 * link, that is right: the user's own edits still fit the text and undo keeps
 * working (the reason the minimal change exists). For the file changing on
 * disk it is not. The steps land on text nobody in this app wrote, undoing
 * one produced a document neither the user nor the other program ever had,
 * and the save that follows every edit wrote it to disk a moment later. A
 * reopened note already starts clean when its text changed elsewhere; a note
 * that never left the screen now does the same.
 *
 * The editor cannot see the difference in the body alone, so the store says
 * it: a per-note disk revision, bumped in the same update that takes a body
 * from disk (a watcher event, a resync after a remote feed came back) and
 * left alone by every in-app writer. An editor remembers the revision it
 * last accounted for, re-baselines whenever it starts showing another path,
 * and treats a body change under an unchanged path with a moved revision as
 * the disk speaking.
 */
import { history } from '@codemirror/commands'
import type { Compartment } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

export function isDiskChange(args: {
  /** The editor's path changed (a tab switch, or a rename of the note it shows). */
  pathChanged: boolean
  /** The text the store holds differs from the editor's document. */
  bodyChanged: boolean
  /** The store's disk revision for the path about to be shown. */
  diskRevision: number
  /** The revision this editor last accounted for. */
  seenDiskRevision: number
}): boolean {
  return !args.pathChanged && args.bodyChanged && args.diskRevision !== args.seenDiskRevision
}

/** Drop a view's undo history where it stands: there is no clear command, so
 *  the field is removed and added back empty, the idiom every reset in the
 *  editor uses (#247). */
export function resetUndoHistory(view: EditorView, compartment: Compartment): void {
  view.dispatch({ effects: compartment.reconfigure([]) })
  view.dispatch({ effects: compartment.reconfigure(history()) })
}
