/**
 * A note cover's frontmatter, folded to one line in Live Preview.
 *
 * A cover is plain frontmatter (`banner`, `banner_y`, and for an Unsplash
 * photo `banner_credit` and `banner_credit_url`), and an Unsplash URL alone
 * runs to a few hundred characters. The cover drawn above the note already
 * shows the picture and its credit, so in Edit and in Split's editor those
 * lines fold into one muted line in the properties card, `cover · Unsplash
 * photo by Jane Doe`, at the place of the first of them. The other properties
 * stay as they were.
 *
 * Which lines are the cover's, and what the line says, come from the shared
 * cover reader (`readNoteCoverLines` in shared-domain), so the fold cannot
 * disagree with the cover drawn above it: no cover drawn, nothing folds. A
 * pane with covers hidden in Settings keeps the raw lines, since they are then
 * the only place the cover shows.
 *
 * The fold is decoration only. The document never changes, so select-all,
 * copy, find and undo all see the raw text. The lines open for editing
 * whenever the selection touches one of them (an arrow key, `j`/`k`, a click
 * on the line, a search hit) and fold again once it leaves, the same rule
 * Live Preview uses to show a heading's `#` (cm-source-reveal.ts): a note
 * opened to be read keeps them folded until the editor takes the focus.
 *
 * Getting in from the keyboard: the line stands for several lines, and a
 * pixel-based vertical motion would land on either end of it, or skip the
 * cover lines a fold hides further down. So `j`/`k` (cm-vim-display-line.ts)
 * and the arrow keys (cm-math-nav.ts) step into a folded line logically, one
 * line at a time, the way they step into a rendered math block. Opening or
 * closing the fold changes the card's height above the caret, which would
 * shift the caret on screen, so the editor scrolls the caret's line back to
 * where it was drawn (`keepCaretInPlace`).
 */
import {
  EditorSelection,
  EditorState,
  StateField,
  type Extension,
  type SelectionRange,
  type Text,
  type Transaction
} from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view'
import { isFrontmatterFence } from '@shared/markdown-lines'
import { readNoteCoverLines, type NoteCover } from '@shared/note-cover'
import { isUnsplashImageUrl } from '@shared/unsplash'
import { frontmatterEnd, noteCoverDrawn } from './cm-note-cover'
import { builtinCoverForAsset } from './note-cover-gallery'
import { revealedSelectionRanges } from './cm-source-reveal'

/** The word the folded line starts with, styled as a property key. */
const COVER_LABEL = 'cover'

/** A run of consecutive cover lines, 1-based document line numbers. */
export interface CoverFoldLineRange {
  fromLine: number
  toLine: number
}

interface CoverFoldInfo {
  /** In document order; the folded line stands in place of the first. */
  runs: readonly CoverFoldLineRange[]
  text: string
}

interface CoverFoldValue {
  info: CoverFoldInfo | null
  /** End of the frontmatter, so an edit below it skips the re-read. */
  end: number
  folded: boolean
  decorations: DecorationSet
}

function webHost(url: string): string | null {
  try {
    return new URL(url).hostname || null
  } catch {
    return null
  }
}

function vaultFileName(href: string): string {
  const name = href.slice(href.lastIndexOf('/') + 1)
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

/** What the folded line says after `cover`, or null for nothing more. */
function coverFoldDetail(cover: NoteCover): string | null {
  const { target } = cover
  if (target.kind === 'url') {
    if (isUnsplashImageUrl(target.url)) {
      return cover.credit ? `Unsplash photo by ${cover.credit.name}` : 'Unsplash photo'
    }
    const host = webHost(target.url)
    return host ? `image from ${host}` : null
  }
  // A gradient or a gallery photo is known by the file name its pick wrote.
  const builtin = builtinCoverForAsset(target.href)
  if (builtin) return builtin.title
  return vaultFileName(target.href) || null
}

/** The folded line's text: `cover · Unsplash photo by Jane Doe`, `cover ·
 *  lisbon.jpg`, `cover · Dusk`, `cover · image from example.com`, or
 *  `cover`. */
export function coverFoldText(cover: NoteCover): string {
  const detail = coverFoldDetail(cover)
  return detail ? `${COVER_LABEL} · ${detail}` : COVER_LABEL
}

function readFoldInfo(state: EditorState): { info: CoverFoldInfo | null; end: number } {
  const end = frontmatterEnd(state)
  if (end === 0 || !state.facet(noteCoverDrawn)) return { info: null, end }
  const found = readNoteCoverLines(`${state.sliceDoc(0, end)}\n`)
  if (!found || found.lines.length === 0) return { info: null, end }
  const runs: CoverFoldLineRange[] = []
  for (const bodyLine of found.lines) {
    // The reader counts the opening fence as line 0; the document, as line 1.
    const line = bodyLine + 1
    const last = runs[runs.length - 1]
    if (last && last.toLine === line - 1) last.toLine = line
    else runs.push({ fromLine: line, toLine: line })
  }
  return { info: { runs, text: coverFoldText(found.cover) }, end }
}

function touchesCoverLines(doc: Text, info: CoverFoldInfo, ranges: readonly SelectionRange[]): boolean {
  for (const run of info.runs) {
    const from = doc.line(run.fromLine).from
    const to = doc.line(run.toLine).to
    if (ranges.some((range) => range.from <= to && range.to >= from)) return true
  }
  return false
}

function foldedIn(state: EditorState, info: CoverFoldInfo | null): boolean {
  return !!info && !touchesCoverLines(state.doc, info, revealedSelectionRanges(state))
}

class CoverFoldWidget extends WidgetType {
  constructor(readonly text: string) {
    super()
  }

  eq(other: CoverFoldWidget): boolean {
    return other.text === this.text
  }

  toDOM(): HTMLElement {
    const line = document.createElement('span')
    line.className = 'cm-frontmatter-cover'
    line.setAttribute('data-frontmatter-cover', '')
    line.title = this.text
    const label = document.createElement('span')
    label.className = 'cm-frontmatter-key'
    label.textContent = COVER_LABEL
    line.append(label, this.text.slice(COVER_LABEL.length))
    return line
  }

  // The editor takes the click (below), so it must see the event.
  ignoreEvent(): boolean {
    return false
  }
}

const HIDDEN_COVER_LINES = Decoration.replace({})

function foldDecorations(doc: Text, info: CoverFoldInfo): DecorationSet {
  return Decoration.set(
    info.runs.map((run, index) => {
      const last = doc.line(run.toLine)
      if (index === 0) {
        return Decoration.replace({ widget: new CoverFoldWidget(info.text) }).range(doc.line(run.fromLine).from, last.to)
      }
      // A later run (`banner_y` written under keys added after the cover)
      // goes away with the line break above it, so it takes no row.
      return HIDDEN_COVER_LINES.range(doc.line(run.fromLine - 1).to, last.to)
    })
  )
}

function foldValue(state: EditorState, info: CoverFoldInfo | null, end: number): CoverFoldValue {
  const folded = foldedIn(state, info)
  return { info, end, folded, decorations: folded && info ? foldDecorations(state.doc, info) : Decoration.none }
}

/** Whether an edit can change what the frontmatter says. */
function frontmatterMayChange(tr: Transaction, end: number): boolean {
  if (end > 0) return tr.changes.touchesRange(0, Math.min(tr.startState.doc.length, end + 1)) !== false
  // No closed block yet: the closing fence can be typed anywhere under an
  // opening one.
  return isFrontmatterFence(tr.state.doc.line(1).text)
}

const coverFoldField = StateField.define<CoverFoldValue>({
  create(state) {
    const { info, end } = readFoldInfo(state)
    return foldValue(state, info, end)
  },
  update(value, tr) {
    let { info, end } = value
    if (
      tr.startState.facet(noteCoverDrawn) !== tr.state.facet(noteCoverDrawn) ||
      (tr.docChanged && frontmatterMayChange(tr, value.end))
    ) {
      ;({ info, end } = readFoldInfo(tr.state))
    } else if (tr.docChanged) {
      end = tr.changes.mapPos(end)
    }
    if (info === value.info && foldedIn(tr.state, info) === value.folded) {
      return tr.docChanged ? { ...value, end, decorations: value.decorations.map(tr.changes) } : value
    }
    return foldValue(tr.state, info, end)
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations)
})

/** The folded cover lines, for the motions that step into them a line at a
 *  time; empty while they are open, or when nothing folds. */
export function coverFoldLineRanges(state: EditorState): readonly CoverFoldLineRange[] {
  const value = state.field(coverFoldField, false)
  return value?.folded && value.info ? value.info.runs : []
}

// A click on the folded line opens it with the caret at the start of the
// first cover line, where the line was drawn. Left to the editor, the click
// would land on either end of the hidden text, and the end is a line or two
// further down once the lines open.
const coverFoldClick = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false
    const target = event.target as Element | null
    if (!target?.closest?.('[data-frontmatter-cover]')) return false
    const value = view.state.field(coverFoldField, false)
    if (!value?.folded || !value.info) return false
    view.dispatch({
      selection: EditorSelection.cursor(view.state.doc.line(value.info.runs[0].fromLine).from),
      userEvent: 'select.pointer'
    })
    view.focus()
    return true
  }
})

/** Between the transaction that opens or closes the fold and the measure
 *  that scrolls for it. The transaction extender below needs the view, to
 *  read where the caret's line is drawn before the layout changes. */
interface CaretAnchor {
  view: EditorView | null
  /** The head the fold opened or closed around, and the screen height its
   *  line is to be drawn at. */
  pending: { head: number; top: number; until: number } | null
}

const caretAnchorField = StateField.define<CaretAnchor>({
  create: () => ({ view: null, pending: null }),
  update: (value) => value
})

/**
 * Room to scroll. A note shorter than the window cannot scroll, so opening
 * the fold from below would still push the caret down, and closing it after
 * a scroll would let the browser clamp the scroll back and drop the text. So
 * when the caret's line needs a scroll the note is too short for, an empty
 * box below the text makes the room, and goes again once the view is back
 * inside the note's own height. It only ever covers blank editor background.
 */
class CaretAnchorView {
  private room: HTMLElement | null = null

  constructor(readonly view: EditorView) {
    view.state.field(caretAnchorField).view = view
  }

  update(update: ViewUpdate): void {
    update.state.field(caretAnchorField).view = update.view
    if (this.room) this.releaseRoom()
  }

  /** Scroll to `top`, making room below the note when it is too short. */
  scrollTo(top: number): void {
    const scroller = this.view.scrollDOM
    if (top > scroller.scrollHeight - scroller.clientHeight) {
      if (!this.room) {
        this.room = document.createElement('div')
        this.room.setAttribute('aria-hidden', 'true')
        this.room.setAttribute('data-cover-fold-room', '')
        this.room.style.cssText = 'position:absolute;left:0;width:1px;height:1px;pointer-events:none;visibility:hidden'
        scroller.appendChild(this.room)
      }
      this.room.style.top = `${Math.ceil(top + scroller.clientHeight) - 1}px`
    }
    scroller.scrollTop = top
  }

  /** Drop the room once the scroll position fits the note without it. */
  releaseRoom(): void {
    this.view.requestMeasure({
      key: this,
      read: (view) => {
        if (!this.room) return false
        // The note's own height, read without taking the room away: hiding
        // it for the reading would let the browser clamp the scroll.
        const scroller = view.scrollDOM
        const content = view.contentDOM
        const height = content.offsetTop + content.offsetHeight + (parseFloat(getComputedStyle(scroller).paddingBottom) || 0)
        return scroller.scrollTop <= Math.max(0, height - scroller.clientHeight) + 1
      },
      write: (fits) => {
        if (!fits || !this.room) return
        this.room.remove()
        this.room = null
      }
    })
  }

  destroy(): void {
    this.room?.remove()
    const anchor = this.view.state.field(caretAnchorField, false)
    if (anchor?.view === this.view) anchor.view = null
  }
}

const caretAnchorView = ViewPlugin.fromClass(CaretAnchorView, {
  eventObservers: {
    scroll() {
      this.releaseRoom()
    }
  }
})

/**
 * Opening or closing the fold grows or shrinks the card above the caret: `k`
 * from under the card onto its last cover line would draw the caret a line or
 * two lower than the folded line it stepped onto, and leaving the lines
 * downward would pull it up. So the transaction that opens or closes them
 * notes the screen height the head's line is drawn at now (for a head on the
 * folded line, that line's), and asks for a scroll, which the handler below
 * answers once the new layout is measured by putting the line back there. It
 * answers the first scroll request for that head, whoever asks
 * (codemirror-vim asks again after every motion), and runs after Vim's
 * scrolloff in the same measure, so its scroll is the one that stands. A
 * note scrolled to its very top has nothing above to scroll into, so there
 * closing the lines under the caret still pulls the text up.
 */
const keepCaretInPlace = EditorState.transactionExtender.of((tr) => {
  const anchor = tr.startState.field(caretAnchorField, false)
  const view = anchor?.view
  if (!anchor || !view || !tr.selection || tr.docChanged || tr.reconfigured) return null
  const head = tr.newSelection.main.head
  if (anchor.pending?.head !== head) anchor.pending = null
  const value = tr.startState.field(coverFoldField, false)
  if (!value?.info) return null
  // A note being read keeps its cover lines folded wherever the caret is.
  const reading = revealedSelectionRanges(tr.startState).length === 0
  const folded = reading || !touchesCoverLines(tr.startState.doc, value.info, tr.newSelection.ranges)
  if (folded === value.folded) return null
  let top: number
  let bottom: number
  let scroller: DOMRect
  try {
    // Settle a measure still pending from a key pressed in the same frame
    // (any layout query does), so the heights read here are the ones on
    // screen.
    view.lineBlockAtHeight(0)
    const block = view.lineBlockAt(head)
    top = view.documentTop + block.top
    bottom = view.documentTop + block.bottom
    scroller = view.scrollDOM.getBoundingClientRect()
  } catch {
    // A transaction built while the view is updating cannot read layout.
    return null
  }
  // Off screen, the editor's own scrolling applies.
  if (top < scroller.top || bottom > scroller.bottom) return null
  // A cover line folded further down is drawn at the end of the line above
  // it: stepping down onto it opens it under that line, stepping up, in its
  // place.
  const headLine = tr.startState.doc.lineAt(head).number
  const laterRun = value.folded && value.info.runs.findIndex((run) => headLine >= run.fromLine && headLine <= run.toLine) > 0
  const fromAbove = tr.startState.selection.main.head < head
  anchor.pending = { head, top: laterRun && fromAbove ? bottom : top, until: Date.now() + 1000 }
  return { effects: EditorView.scrollIntoView(head) }
})

const caretAnchorScroll = EditorView.scrollHandler.of((view, range) => {
  const anchor = view.state.field(caretAnchorField, false)
  const pending = anchor?.pending
  const plugin = view.plugin(caretAnchorView)
  if (!anchor || !pending || !plugin) return false
  anchor.pending = null
  if (range.head !== pending.head || Date.now() > pending.until) return false
  plugin.scrollTo(view.scrollDOM.scrollTop + view.documentTop + view.lineBlockAt(pending.head).top - pending.top)
  return true
})

/** Live Preview's cover fold. Folds only in an editor that draws the note's
 *  cover (`noteCoverDrawn`, from the pane's cover placement). */
export const coverFoldExtension: Extension = [
  coverFoldField,
  coverFoldClick,
  caretAnchorField,
  caretAnchorView,
  keepCaretInPlace,
  caretAnchorScroll
]
