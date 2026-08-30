/**
 * WYSIWYG rendering of ```embed and ```bookmark fences in the live editor, so a
 * URL embed shows as its poster / card while you edit (not just in the reading
 * view). Mirrors the block-math renderer: the whole fenced block is replaced
 * with a block widget, and the raw fence is revealed when the cursor sits in it.
 *
 * The widget DOM is reused while its URL is unchanged (WidgetType.eq), so moving
 * the cursor around the rest of the note never resets a playing video. Stepping
 * the cursor into the block does rebuild it (source revealed, then hidden
 * again); the embed is a click-to-play poster until the user starts it, so that
 * rebuild is an image, not a player reload (see embed-renderers).
 *
 * WYSIWYG-only: registered via `wysiwygExtensions()`.
 */
import { syntaxTree } from '@codemirror/language'
import { RangeSetBuilder, StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view'
import { renderBookmarkElement, renderEmbedElement } from './embed-renderers'

const FENCE_INFO_RE = /^\s*(?:`{3,}|~{3,})\s*([^\s`]*)/

type EmbedKind = 'embed' | 'bookmark'

class EmbedBlockWidget extends WidgetType {
  constructor(
    readonly kind: EmbedKind,
    readonly url: string
  ) {
    super()
  }
  eq(other: EmbedBlockWidget): boolean {
    return other.kind === this.kind && other.url === this.url
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('div')
    el.className = `cm-embed-block cm-embed-block-${this.kind}`

    const content = document.createElement('div')
    content.className = 'cm-embed-content'

    // The media renders into its own element so its async re-render (bookmark
    // metadata does `innerHTML = ''`) never wipes the Edit pill beside it.
    const media = document.createElement('div')
    media.className = 'cm-embed-media'
    if (this.kind === 'bookmark') {
      // A stable token keeps the async metadata fill from landing on a stale
      // (recycled) element; the URL is stable per widget so it works as the key.
      media.setAttribute('data-zen-bookmark-rendered', this.url)
      renderBookmarkElement(media, this.url, this.url)
    } else {
      // Starting a video must not cost the note its keyboard: the poster click
      // is swallowed before it can move focus, and the editor takes (or keeps)
      // focus once the player is in, caret untouched.
      renderEmbedElement(media, this.url, { onActivate: () => view.focus() })
    }
    content.appendChild(media)

    // Clicking the media does its natural thing (start the video, open the link);
    // this "Edit" pill is the discoverable, consistent way to edit the source.
    // It drops the caret into the block, which the StateField renders as source.
    const edit = document.createElement('button')
    edit.type = 'button'
    edit.className = 'cm-embed-edit'
    edit.textContent = 'Edit'
    edit.title = 'Edit source'
    edit.setAttribute('contenteditable', 'false')
    edit.addEventListener('mousedown', (e) => e.preventDefault())
    edit.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const pos = view.posAtDOM(el)
      view.dispatch({ selection: { anchor: pos + 1 }, scrollIntoView: true })
      view.focus()
    })
    content.appendChild(edit)

    el.appendChild(content)
    return el
  }
  // The widget owns its clicks: the poster starts the video and the bookmark
  // anchor opens the link (see the handlers in embed-renderers). Editing is via
  // the Edit pill or vim j/k, never a stray click, so this returns true.
  ignoreEvent(): boolean {
    return true
  }
}

/** Cursor/selection overlaps (or just touches an edge of) `[from, to]`. */
function selectionTouches(state: EditorState, from: number, to: number): boolean {
  for (const range of state.selection.ranges) {
    if (Math.max(range.from, from) <= Math.min(range.to, to)) return true
  }
  return false
}

/** 1-based line range of one ```embed / ```bookmark block (fences included). */
export interface EmbedBlockLineRange {
  fromLine: number
  toLine: number
}

interface EmbedRenderValue {
  decorations: DecorationSet
  /** Every embed/bookmark block, whether currently rendered or revealed. Used by
   *  vertical cursor motion to step *into* a rendered block. */
  blockLines: readonly EmbedBlockLineRange[]
}

function buildEmbedDecorations(state: EditorState): EmbedRenderValue {
  const tree = syntaxTree(state)
  const pending: Array<{ from: number; to: number; deco: Decoration }> = []
  const blockLines: EmbedBlockLineRange[] = []

  tree.iterate({
    enter: (node) => {
      if (node.name !== 'FencedCode') return
      const openLine = state.doc.lineAt(node.from)
      const info = openLine.text.match(FENCE_INFO_RE)?.[1]?.toLowerCase()
      if (info !== 'embed' && info !== 'bookmark') return
      const kind: EmbedKind = info

      const lastLine = state.doc.lineAt(Math.max(node.from, node.to - 1))
      // The URL is the block body (between the fences); take the first non-empty
      // line so trailing blanks/params don't break it.
      let url = ''
      for (let n = openLine.number + 1; n <= lastLine.number; n++) {
        const t = state.doc.line(n).text.trim()
        if (t && !/^(?:`{3,}|~{3,})/.test(t)) {
          url = t
          break
        }
      }
      if (!url) return

      blockLines.push({ fromLine: openLine.number, toLine: lastLine.number })
      // Reveal the raw fence when the cursor is inside it.
      if (selectionTouches(state, openLine.from, lastLine.to)) return
      pending.push({
        from: openLine.from,
        to: lastLine.to,
        deco: Decoration.replace({ block: true, widget: new EmbedBlockWidget(kind, url) })
      })
    }
  })

  pending.sort((a, b) => a.from - b.from || a.to - b.to)
  const builder = new RangeSetBuilder<Decoration>()
  for (const p of pending) builder.add(p.from, p.to, p.deco)
  return { decorations: builder.finish(), blockLines }
}

const embedRenderField = StateField.define<EmbedRenderValue>({
  create: (state) => buildEmbedDecorations(state),
  update(value, tr) {
    if (tr.docChanged || tr.selection || syntaxTree(tr.startState) !== syntaxTree(tr.state)) {
      return buildEmbedDecorations(tr.state)
    }
    return value
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations)
})

/** 1-based line ranges of every ```embed / ```bookmark block (rendered or
 *  revealed), or `[]` when the extension isn't active. Consumed by vim `j`/`k`
 *  and arrow-key navigation to step into a rendered block instead of skipping
 *  its widget. */
export function embedBlockLineRanges(state: EditorState): readonly EmbedBlockLineRange[] {
  return state.field(embedRenderField, false)?.blockLines ?? []
}

export const embedRenderExtension: Extension = [embedRenderField]
