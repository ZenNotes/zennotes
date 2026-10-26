import type { EditorView } from '@codemirror/view'
import { useStore, type LinkPopoverState, type PreviewAnchorRect } from '../store'
import { linkRangeAtCursor } from './internal-links'
import {
  LINK_POPOVER_HOVER_DELAY_MS,
  LINK_POPOVER_LEAVE_GRACE_MS,
  linkPopoverTarget
} from './link-popover'
import { databaseLinkTargetsFor } from './unresolved-links'

/**
 * Opening the link popover: from the pointer resting on a `[[wikilink]]`
 * (hover intent below), or from a key on the link under the cursor (`K`, the
 * editor shortcut). Kept out of the component so the editor's handlers and
 * Vim actions reach it without mounting anything.
 */

/** Screen rect of the document range `from..to`, for placing the popover. */
export function rangeRect(view: EditorView, from: number, to: number): PreviewAnchorRect | null {
  const start = view.coordsAtPos(from, 1)
  const end = view.coordsAtPos(to, -1)
  if (!start || !end) return null
  // A link wrapped onto a second line ends left of where it starts; its
  // first line is where the eye is, so hang the popover off that.
  const right = end.top > start.top + 2 ? start.left + 1 : Math.max(end.right, start.left + 1)
  return {
    left: start.left,
    top: start.top,
    right,
    bottom: end.bottom,
    width: right - start.left,
    height: end.bottom - start.top
  }
}

/**
 * Show the popover for `target`, written in the note at `sourcePath`, when
 * the popover has something for it (a note, or a note to create). False for
 * a link it leaves to other surfaces: a database, a file, an address, or a
 * spot in the note being read.
 */
export function requestLinkPopover(args: {
  target: string
  sourcePath: string | null
  anchorRect: PreviewAnchorRect
  mode: LinkPopoverState['mode']
  focus: boolean
}): boolean {
  const s = useStore.getState()
  const shows = linkPopoverTarget(args.target, args.sourcePath ?? '', {
    notes: s.notes,
    databases: databaseLinkTargetsFor(s.folders, s.vaultSettings),
    assets: s.assetFiles
  })
  if (!shows) return false
  void s.openLinkPopover({
    target: args.target.trim(),
    path: shows.kind === 'note' ? shows.path : null,
    anchorRect: args.anchorRect,
    mode: args.mode,
    focus: args.focus,
    created: false
  })
  return true
}

/** The note an editor view shows: the popover's own editor shows the
 *  popover's note, so `K` inside it chains to the next link. */
function notePathOfView(view: EditorView): string | null {
  const s = useStore.getState()
  if (view.dom.closest('[data-link-popover]')) return s.linkPopover?.path ?? null
  return s.selectedPath ?? null
}

/**
 * `K` (Vim) and the editor shortcut: the popover for the wikilink under the
 * cursor, with the keyboard moved into it. False when the cursor is not on a
 * wikilink the popover can show, so the key falls through.
 */
export function openLinkPopoverAtCursor(view: EditorView): boolean {
  const pos = view.state.selection.main.head
  const line = view.state.doc.lineAt(pos)
  const link = linkRangeAtCursor(line.text, pos - line.from)
  if (!link || link.kind !== 'wikilink') return false
  const anchorRect = rangeRect(view, line.from + link.from, line.from + link.to)
  if (!anchorRect) return false
  return requestLinkPopover({
    target: link.target,
    sourcePath: notePathOfView(view),
    anchorRect,
    mode: 'pinned',
    focus: true
  })
}

// ---- Hover intent ---------------------------------------------------------
//
// The pointer has to rest on a link before its popover opens, and may cross
// the gap between link and popover without closing it. One link is "under
// the pointer" at a time; `shownKey` is the link whose popover the pointer
// opened, so coming back to it cancels a pending close instead of reopening.

let pointerKey: string | null = null
let shownKey: string | null = null
// Moving from a link onto the popover fires the popover's pointerenter
// before the editor's mouseleave, so a close armed by the second must check
// where the pointer actually is.
let pointerOnPopover = false
let openTimer: ReturnType<typeof setTimeout> | null = null
let closeTimer: ReturnType<typeof setTimeout> | null = null

function clearOpenTimer(): void {
  if (openTimer) clearTimeout(openTimer)
  openTimer = null
}

function clearCloseTimer(): void {
  if (closeTimer) clearTimeout(closeTimer)
  closeTimer = null
}

function scheduleHoverClose(): void {
  clearCloseTimer()
  closeTimer = setTimeout(() => {
    closeTimer = null
    const s = useStore.getState()
    // A popover the user has worked in waits for Escape or a click outside.
    if (s.linkPopover?.mode !== 'hover') return
    if (pointerOnPopover) return
    if (pointerKey !== null && pointerKey === shownKey) return
    shownKey = null
    s.closeLinkPopover()
  }, LINK_POPOVER_LEAVE_GRACE_MS)
}

/**
 * The pointer is over the wikilink `target` in the note at `sourcePath`.
 * Called on every pointer move over a link, so it does nothing new until the
 * link changes. `rect` is read when the popover opens, after the rest.
 */
export function pointerOverWikilink(
  target: string,
  sourcePath: string | null,
  rect: () => PreviewAnchorRect | null
): void {
  const key = `${sourcePath ?? ''}\n${target.trim().toLowerCase()}`
  if (key === pointerKey) return
  pointerKey = key
  clearOpenTimer()
  const s = useStore.getState()
  if (key === shownKey && s.linkPopover) {
    clearCloseTimer()
    return
  }
  // Moving onto another link starts the old popover's goodbye.
  if (s.linkPopover?.mode === 'hover') scheduleHoverClose()
  if (!s.linkPopoverOnHover) return
  openTimer = setTimeout(() => {
    openTimer = null
    if (pointerKey !== key) return
    const now = useStore.getState()
    // Never swap out a popover the user is working in.
    if (now.linkPopover?.mode === 'pinned' || !now.linkPopoverOnHover) return
    const anchorRect = rect()
    if (!anchorRect) return
    if (requestLinkPopover({ target, sourcePath, anchorRect, mode: 'hover', focus: false })) {
      shownKey = key
      clearCloseTimer()
    }
  }, LINK_POPOVER_HOVER_DELAY_MS)
}

/** The pointer left whatever link it was on. */
export function pointerLeftWikilink(): void {
  if (pointerKey === null) return
  pointerKey = null
  clearOpenTimer()
  if (useStore.getState().linkPopover?.mode === 'hover') scheduleHoverClose()
}

export function pointerEnteredLinkPopover(): void {
  pointerOnPopover = true
  clearCloseTimer()
}

export function pointerLeftLinkPopover(): void {
  pointerOnPopover = false
  if (useStore.getState().linkPopover?.mode === 'hover') scheduleHoverClose()
}

/** Forget any pending hover: the popover was closed some other way. */
export function resetLinkPopoverHover(): void {
  clearOpenTimer()
  clearCloseTimer()
  pointerKey = null
  shownKey = null
  pointerOnPopover = false
}
