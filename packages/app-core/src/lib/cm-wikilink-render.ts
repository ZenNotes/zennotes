/**
 * WYSIWYG rendering for Obsidian-style `[[wikilinks]]`: hide the `[[ ]]`
 * brackets (and the `target|` part of an aliased link), show the label as a
 * clickable accent link, and navigate to the note on click. The raw `[[...]]`
 * source is revealed on whichever wikilink the cursor is in — matching how the
 * rest of live preview reveals the active token.
 *
 * Image/transclusion embeds (`![[...]]`) are left to the existing embed
 * handling and skipped here.
 *
 * WYSIWYG-only: registered via `wysiwygExtensions()`.
 */
import { syntaxTree } from '@codemirror/language'
import { RangeSetBuilder } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate
} from '@codemirror/view'
import { useStore } from '../store'
import { resolveWikilinkTarget, wikilinkHeadingAnchor } from './wikilinks'
import { openDatabaseFromWikilink, openWikilinkHeading } from './wikilink-navigation'

// Same shape as the Preview pipeline (remarkWikilinks).
const WIKILINK_RE = /(!?)\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g
const hide = Decoration.replace({})
// Quiet edit markers for the revealed `[[ ]]` / `|` when the cursor is in the
// wikilink (overrides the orange link highlight so brackets read as markers).
const bracketMark = Decoration.mark({ class: 'cm-wikilink-bracket' })

/**
 * True when `pos` sits inside a code span or code block — there `[[...]]` is
 * literal text, not a link, so it should render as code (matching the Preview
 * pipeline, whose remark transform never visits code nodes). (#248)
 */
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

function selectionTouches(
  state: EditorView['state'],
  from: number,
  to: number
): boolean {
  for (const range of state.selection.ranges) {
    if (range.empty) {
      if (range.from >= from && range.from <= to) return true
    } else if (Math.max(range.from, from) < Math.min(range.to, to)) {
      return true
    }
  }
  return false
}

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view
  const pending: Array<{ from: number; to: number; deco: Decoration }> = []

  for (const { from, to } of view.visibleRanges) {
    const firstLine = state.doc.lineAt(from).number
    const lastLine = state.doc.lineAt(Math.max(from, to - 1)).number
    for (let n = firstLine; n <= lastLine; n++) {
      const line = state.doc.line(n)
      if (!line.text.includes('[[')) continue
      WIKILINK_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = WIKILINK_RE.exec(line.text)) !== null) {
        if (m[1] === '!') continue // embed — handled elsewhere
        const target = m[2].trim()
        if (!target) continue
        const matchStart = line.from + m.index
        const matchEnd = matchStart + m[0].length
        // `[[...]]` inside a code span/block is literal code — leave it raw. (#248)
        if (isInsideCode(state, matchStart + 2)) continue
        const hasAlias = m[3] != null
        const labelStart = hasAlias
          ? matchStart + 2 + m[2].length + 1 // after `[[target|`
          : matchStart + 2 // after `[[`
        const labelEnd = matchEnd - 2 // before `]]`
        if (labelEnd <= labelStart) continue
        // Cursor inside this wikilink → reveal the raw `[[...]]`, but mute the
        // brackets / pipe so they read as quiet edit markers.
        if (selectionTouches(state, matchStart, matchEnd)) {
          pending.push({ from: matchStart, to: matchStart + 2, deco: bracketMark })
          if (hasAlias) {
            pending.push({ from: labelStart - 1, to: labelStart, deco: bracketMark })
          }
          pending.push({ from: matchEnd - 2, to: matchEnd, deco: bracketMark })
          continue
        }
        pending.push({ from: matchStart, to: labelStart, deco: hide })
        pending.push({
          from: labelStart,
          to: labelEnd,
          deco: Decoration.mark({
            class: 'cm-wikilink',
            attributes: { 'data-target': target }
          })
        })
        pending.push({ from: labelEnd, to: matchEnd, deco: hide })
      }
    }
  }

  pending.sort((a, b) => a.from - b.from || a.to - b.to)
  const builder = new RangeSetBuilder<Decoration>()
  for (const p of pending) builder.add(p.from, p.to, p.deco)
  return builder.finish()
}

const wikilinkRenderPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  { decorations: (p) => p.decorations }
)

/**
 * Open the note a wikilink points to, scrolling to its `#heading` when the
 * target carries one (`[[Doc#Heading]]`). (#196)
 */
function openWikilink(target: string): void {
  const state = useStore.getState()
  const resolved = resolveWikilinkTarget(state.notes, target)
  if (!resolved) {
    // Not a note — maybe a `.base` database; otherwise leave it to other flows.
    openDatabaseFromWikilink(target)
    return
  }

  const focusEditorSoon = (): void => {
    useStore.getState().setFocusedPanel('editor')
    requestAnimationFrame(() => useStore.getState().editorViewRef?.focus())
  }

  const anchor = wikilinkHeadingAnchor(target)
  if (!anchor) {
    void state.selectNote(resolved.path).then(focusEditorSoon)
    return
  }
  void openWikilinkHeading(resolved.path, anchor).then(focusEditorSoon)
}

// Click a rendered wikilink to jump. Intercept on mousedown so CodeMirror
// doesn't first drop the caret into the (hidden) source.
const wikilinkClick = EditorView.domEventHandlers({
  mousedown: (event) => {
    const el = (event.target as HTMLElement | null)?.closest<HTMLElement>('.cm-wikilink')
    const target = el?.dataset.target
    if (!target) return false
    event.preventDefault()
    openWikilink(target)
    return true
  }
})

export const wikilinkRenderExtension = [wikilinkRenderPlugin, wikilinkClick]
