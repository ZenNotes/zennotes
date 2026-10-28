/**
 * The note cover, in the editor: a block widget above the first line, so the
 * banner scrolls away with the text the way a Notion cover does.
 *
 * The widget is only a slot. The cover itself (the image, its buttons, the
 * reposition mode) is the same React component the Read view shows, portalled
 * into the slot by the pane, so the two surfaces cannot drift apart. CodeMirror
 * may drop and rebuild a widget's DOM when it leaves and re-enters the viewport,
 * which is why the slot reports every element it creates and every one it
 * destroys instead of being handed over once.
 *
 * The slot spans the whole pane, not the capped text column: a plugin measures
 * how far the column sits from the scroller's edges and the slot bleeds out by
 * that much. Horizontal margins only; CodeMirror measures a block widget by its
 * border box, so the gap under the cover is padding, never a vertical margin.
 */
import { Facet, StateField, type EditorState, type Extension } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType
} from '@codemirror/view'
import { isFrontmatterFence } from '@shared/markdown-lines'
import { readNoteCover } from '@shared/note-cover'

/** Told about each slot element the widget creates (`alive`) or destroys. */
export type NoteCoverSlotSink = (slot: HTMLElement, alive: boolean) => void

/** True in an editor whose pane draws the note's cover, in the slot above the
 *  first line or pinned above the editor. The cover's frontmatter folds only
 *  there (cm-cover-fold.ts): with covers hidden, those lines are the only
 *  place the cover shows. */
export const noteCoverDrawn = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean)
})

const noteCoverSlotSink = Facet.define<NoteCoverSlotSink, NoteCoverSlotSink | null>({
  combine: (sinks) => sinks[0] ?? null
})

class NoteCoverSlotWidget extends WidgetType {
  constructor(private readonly sink: NoteCoverSlotSink) {
    super()
  }

  eq(other: NoteCoverSlotWidget): boolean {
    return other.sink === this.sink
  }

  toDOM(): HTMLElement {
    const slot = document.createElement('div')
    slot.className = 'cm-note-cover-slot'
    slot.setAttribute('data-note-cover-slot', '')
    this.sink(slot, true)
    return slot
  }

  destroy(dom: HTMLElement): void {
    this.sink(dom, false)
  }

  ignoreEvent(): boolean {
    return true
  }
}

/** Where the leading frontmatter ends, or 0 without one. Same fence rule as
 *  the frontmatter card, so a cover never shows for a block the editor does
 *  not treat as frontmatter. */
export function frontmatterEnd(state: EditorState): number {
  const doc = state.doc
  if (doc.lines < 2 || !isFrontmatterFence(doc.line(1).text)) return 0
  for (let i = 2; i <= doc.lines; i++) {
    if (isFrontmatterFence(doc.line(i).text)) return doc.line(i).to
  }
  return 0
}

interface CoverFieldValue {
  shown: boolean
  /** End of the frontmatter, so an edit below it skips the re-read. */
  end: number
  decorations: DecorationSet
}

function computeCover(state: EditorState): CoverFieldValue {
  const end = frontmatterEnd(state)
  const sink = state.facet(noteCoverSlotSink)
  const shown = !!sink && end > 0 && readNoteCover(`${state.sliceDoc(0, end)}\n`) !== null
  return {
    shown,
    end,
    decorations: shown && sink
      ? Decoration.set([
          Decoration.widget({ widget: new NoteCoverSlotWidget(sink), block: true, side: -1 }).range(0)
        ])
      : Decoration.none
  }
}

const noteCoverField = StateField.define<CoverFieldValue>({
  create: computeCover,
  update(value, tr) {
    if (tr.startState.facet(noteCoverSlotSink) !== tr.state.facet(noteCoverSlotSink)) {
      return computeCover(tr.state)
    }
    if (!tr.docChanged) return value
    // Typing in the body cannot add or remove a cover; only an edit that
    // reaches the frontmatter (or the line after it, where a fence may form)
    // can.
    if (!tr.changes.touchesRange(0, Math.min(tr.startState.doc.length, value.end + 1))) {
      return { ...value, end: tr.changes.mapPos(value.end) }
    }
    return computeCover(tr.state)
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.editorAttributes.from(field, (value): Record<string, string> =>
      value.shown ? { class: 'zen-has-note-cover' } : {}
    )
  ]
})

const coverBleed = ViewPlugin.fromClass(
  class {
    private last = ''

    constructor(view: EditorView) {
      this.schedule(view)
    }

    update(update: ViewUpdate): void {
      if (update.geometryChanged || update.docChanged || update.viewportChanged) {
        this.schedule(update.view)
      }
    }

    private schedule(view: EditorView): void {
      if (!view.state.field(noteCoverField).shown) return
      view.requestMeasure({
        key: this,
        read: (v) => {
          const scroller = v.scrollDOM.getBoundingClientRect()
          const content = v.contentDOM.getBoundingClientRect()
          const style = getComputedStyle(v.contentDOM)
          const left = content.left - scroller.left + (parseFloat(style.paddingLeft) || 0)
          const right =
            scroller.left + v.scrollDOM.clientWidth - content.right + (parseFloat(style.paddingRight) || 0)
          return `${Math.max(0, Math.round(left))}px ${Math.max(0, Math.round(right))}px`
        },
        write: (measured, v) => {
          if (measured === this.last) return
          this.last = measured
          const [left, right] = measured.split(' ')
          v.dom.style.setProperty('--zen-cover-bleed-left', left!)
          v.dom.style.setProperty('--zen-cover-bleed-right', right!)
        }
      })
    }
  }
)

/** True when this editor draws a cover above its first line. */
export function editorShowsNoteCover(state: EditorState): boolean {
  return state.field(noteCoverField, false)?.shown ?? false
}

/** The cover slot, for an editor whose pane portals the cover into it. */
export function noteCoverExtension(sink: NoteCoverSlotSink): Extension {
  return [noteCoverSlotSink.of(sink), noteCoverField, coverBleed, noteCoverDrawn.of(true)]
}

/** For an editor whose pane pins the cover above it instead. */
export const pinnedNoteCoverExtension: Extension = noteCoverDrawn.of(true)
