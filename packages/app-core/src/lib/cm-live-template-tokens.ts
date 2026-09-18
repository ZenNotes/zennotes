/**
 * Live preview for the live template tokens (#784): `{{modified_date}}`,
 * `{{modified_time}}` and `{{modified_datetime}}` render as the note's
 * last-saved time wherever the caret is not, and come back as the raw token
 * when the selection touches them so they can be edited or removed. Tokens
 * inside code stay literal, like every other live-preview decoration.
 */
import { syntaxTree } from '@codemirror/language'
import { RangeSetBuilder, StateEffect } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType
} from '@codemirror/view'
import { useStore } from '../store'
import { LIVE_TOKEN_RE, formatLiveToken, liveTokenFromMatch } from './live-template-tokens'

class LiveTokenWidget extends WidgetType {
  constructor(
    private readonly text: string,
    private readonly raw: string
  ) {
    super()
  }
  eq(other: LiveTokenWidget): boolean {
    return other.text === this.text && other.raw === this.raw
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-live-token'
    span.textContent = this.text
    span.title = `Last modified (${this.raw})`
    return span
  }
  ignoreEvent(): boolean {
    return false
  }
}

function isInsideCode(state: EditorView['state'], pos: number): boolean {
  let node = syntaxTree(state).resolveInner(pos, 1)
  while (node) {
    const n = node.name
    if (n === 'FencedCode' || n === 'CodeBlock' || n === 'InlineCode') return true
    if (!node.parent) break
    node = node.parent
  }
  return false
}

function selectionTouches(state: EditorView['state'], from: number, to: number): boolean {
  for (const range of state.selection.ranges) {
    if (range.empty) {
      if (range.from >= from && range.from <= to) return true
    } else if (Math.max(range.from, from) < Math.min(range.to, to)) {
      return true
    }
  }
  return false
}

/**
 * The note's last-saved time. The listing entry is the source of truth (the
 * watcher refreshes it after every save); the open note's own meta is the
 * fallback until the listing has caught up.
 */
function activeNoteModified(): Date | null {
  const state = useStore.getState()
  const path = state.activeNote?.path
  if (!path) return null
  const listed = state.notes.find((note) => note.path === path)?.updatedAt ?? 0
  const at = Math.max(listed, state.activeNote?.updatedAt ?? 0)
  return at > 0 ? new Date(at) : null
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const { state } = view
  const modified = activeNoteModified()
  if (!modified) return builder.finish()
  for (const { from, to } of view.visibleRanges) {
    const firstLine = state.doc.lineAt(from).number
    const lastLine = state.doc.lineAt(Math.max(from, to - 1)).number
    for (let n = firstLine; n <= lastLine; n++) {
      const line = state.doc.line(n)
      if (!line.text.includes('{{')) continue
      LIVE_TOKEN_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = LIVE_TOKEN_RE.exec(line.text)) !== null) {
        const start = line.from + m.index
        const end = start + m[0].length
        if (isInsideCode(state, start + 2)) continue
        if (selectionTouches(state, start, end)) continue
        const text = formatLiveToken(liveTokenFromMatch(m[1], m[2]), modified)
        builder.add(start, end, Decoration.replace({ widget: new LiveTokenWidget(text, m[0]) }))
      }
    }
  }
  return builder.finish()
}

const refreshLiveTokensEffect = StateEffect.define<null>()

const liveTemplateTokenPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    unsubscribe: (() => void) | null = null
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
      // The value moves under the editor with every save (the listing's
      // `updatedAt`) and with the active note itself.
      this.unsubscribe = useStore.subscribe((state, prev) => {
        if (state.notes !== prev.notes || state.activeNote !== prev.activeNote) {
          view.dispatch({ effects: refreshLiveTokensEffect.of(null) })
        }
      })
    }
    update(update: ViewUpdate): void {
      const refreshed = update.transactions.some((tr) =>
        tr.effects.some((effect) => effect.is(refreshLiveTokensEffect))
      )
      if (refreshed || update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.view)
      }
    }
    destroy(): void {
      this.unsubscribe?.()
      this.unsubscribe = null
    }
  },
  { decorations: (plugin) => plugin.decorations }
)

export const liveTemplateTokenExtension = [liveTemplateTokenPlugin]
