/**
 * The callout actions in the editor (#1016): the right-click menu, the "Set
 * Callout Type…" and "Remove Callout" palette commands, and `Space l a` all
 * land here, so each is one undoable change made the same way.
 *
 * The type menu lives in the active EditorPane (it is that pane's state), so
 * the palette and the leader key ask for it with a window event, the way the
 * keyboard opens the editor's context menu.
 */
import { EditorSelection } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import {
  calloutTargetAt,
  changeCalloutType,
  removeCallout,
  turnIntoCallout,
  type CalloutEdit,
  type CalloutRefusal,
  type CalloutTarget
} from './callout-transform'
import { useToastStore } from './toast'

export const ZEN_OPEN_CALLOUT_MENU_EVENT = 'zen:open-callout-type-menu'

/** Open the callout type menu at the caret of the active editor. */
export function requestCalloutTypeMenu(): void {
  window.dispatchEvent(new Event(ZEN_OPEN_CALLOUT_MENU_EVENT))
}

export interface CalloutRange {
  from: number
  to: number
}

export function editorCalloutTarget(view: EditorView, range: CalloutRange): CalloutTarget {
  return calloutTargetAt(view.state.doc.toString(), range)
}

const REFUSAL_MESSAGE: Record<CalloutRefusal, string> = {
  code: 'A callout cannot go inside a code block.',
  frontmatter: 'A callout cannot go in the note’s properties.',
  blank: 'Put the cursor in a paragraph, or select lines, to make a callout.'
}

export function calloutRefusalMessage(reason: CalloutRefusal): string {
  return REFUSAL_MESSAGE[reason]
}

function liveSelection(view: EditorView): { anchor: number; head: number } {
  const main = view.state.selection.main
  return { anchor: main.anchor, head: main.head }
}

function apply(view: EditorView, edit: CalloutEdit): void {
  view.dispatch({
    changes: edit.changes,
    selection: EditorSelection.single(edit.selection.anchor, edit.selection.head),
    scrollIntoView: true,
    // Not `input.type`: history would fold the change into typing that came
    // just before it, and one Undo has to take back exactly this.
    userEvent: 'input.callout'
  })
}

/**
 * Make what `range` targets a callout of `type`: change the callout it is in,
 * or turn its block into one. False when the range refuses a callout.
 */
export function setCalloutType(view: EditorView, range: CalloutRange, type: string): boolean {
  const doc = view.state.doc.toString()
  const target = calloutTargetAt(doc, range)
  if (target.kind === 'callout') {
    const edit = changeCalloutType(target.callout, type, liveSelection(view))
    if (edit) apply(view, edit)
    return true
  }
  if (target.kind === 'block') {
    apply(view, turnIntoCallout(doc, target, type, liveSelection(view)))
    return true
  }
  return false
}

/** Remove the callout `range` is in. False when it is in none. */
export function removeCalloutIn(view: EditorView, range: CalloutRange): boolean {
  const doc = view.state.doc.toString()
  const target = calloutTargetAt(doc, range)
  if (target.kind !== 'callout') return false
  apply(view, removeCallout(doc, target.callout, liveSelection(view)))
  return true
}

/** The "Remove Callout" command: the callout at the caret, or a toast. */
export function removeCalloutAtCursor(view: EditorView): void {
  const main = view.state.selection.main
  if (!removeCalloutIn(view, { from: main.from, to: main.to })) {
    useToastStore.getState().addToast('The cursor is not in a callout.', 'info')
  }
}
