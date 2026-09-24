/**
 * Render a note's leading YAML frontmatter block (the `---` … `---` at the very
 * top) as compact, muted "properties" instead of full-size body text. This is
 * the in-editor counterpart to how the preview hides frontmatter, and it makes
 * database "record page" notes (whose properties live in frontmatter) read like
 * a property list rather than a wall of big text.
 *
 * The block itself is kept out of the markdown parser by the note grammar
 * (cm-markdown-language.ts); this module only decorates it, plus one editing
 * command (`insertNewlineContinueFrontmatterList`) for the list ergonomics
 * that markdown used to provide by accident.
 */
import { EditorSelection, type EditorState, RangeSetBuilder } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate
} from '@codemirror/view'
import { isFrontmatterFence } from '@shared/markdown-lines'
import { useStore } from '../store'

/** Range of a closed leading `---` … `---` frontmatter block, or null if the
 *  document does not start with one. Used by autocomplete to avoid offering
 *  inline `#tags` inside frontmatter and to offer tags inside frontmatter
 *  `tags:` fields. The same predicate the note grammar scans with, so the
 *  card and the syntax tree always agree on where the block ends. */
export function frontmatterRange(state: EditorState): { from: number; to: number } | null {
  const doc = state.doc
  if (doc.lines < 2 || !isFrontmatterFence(doc.line(1).text)) return null
  for (let i = 2; i <= doc.lines; i++) {
    if (isFrontmatterFence(doc.line(i).text)) {
      return { from: doc.line(1).from, to: doc.line(i).to }
    }
  }
  return null
}

/** A YAML sequence entry: optional indentation, `-`, then either nothing or a
 *  space and the value. `---` does not match (the second dash is not a space). */
const FRONTMATTER_LIST_ITEM_RE = /^(\s*)-(?: +(.*))?$/

/**
 * Enter on a `- item` line inside the frontmatter continues the YAML list.
 *
 * While the whole note was parsed as markdown, `tags:` followed by `  - todo`
 * was a bullet list as far as the editor knew, so Enter added the next `  - `
 * for free and a second Enter on the empty item ended the list. The note
 * grammar now keeps the frontmatter out of markdown (#827), which would have
 * turned those two keystrokes back into plain line breaks. This command keeps
 * the same two moves for YAML sequences: continue the item with the marker at
 * the same indentation, or clear an empty item so the cursor is back at the
 * key level. Everything else returns false and falls through to the default
 * Enter, which copies the line's indentation.
 */
export function insertNewlineContinueFrontmatterList(view: EditorView): boolean {
  const { state } = view
  if (state.readOnly || state.selection.ranges.length > 1) return false
  const range = state.selection.main
  if (!range.empty) return false
  const frontmatter = frontmatterRange(state)
  if (!frontmatter) return false
  const doc = state.doc
  const line = doc.lineAt(range.head)
  // Strictly between the fences: the fence lines belong to the default Enter.
  if (line.number <= doc.lineAt(frontmatter.from).number) return false
  if (line.number >= doc.lineAt(frontmatter.to).number) return false
  const item = line.text.match(FRONTMATTER_LIST_ITEM_RE)
  if (!item) return false
  const indent = item[1]
  const markerEnd = line.from + indent.length + 1
  // Cursor before the marker: a plain line break above the item.
  if (range.head < markerEnd) return false

  if (!/\S/.test(line.text.slice(markerEnd - line.from))) {
    // Second Enter on an empty `- ` ends the list, the way a markdown list
    // does: the marker goes, and the cursor sits at the start of the line.
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: '' },
      selection: EditorSelection.cursor(line.from),
      scrollIntoView: true,
      userEvent: 'delete'
    })
    return true
  }

  const insert = state.lineBreak + indent + '- '
  view.dispatch({
    changes: { from: range.head, insert },
    selection: EditorSelection.cursor(range.head + insert.length),
    scrollIntoView: true,
    userEvent: 'input'
  })
  return true
}

export function isInsideFrontmatter(state: EditorState, pos: number): boolean {
  const range = frontmatterRange(state)
  return range != null && pos >= range.from && pos <= range.to
}

const FRONTMATTER_LINE = Decoration.line({ class: 'cm-frontmatter-line' })
const FRONTMATTER_TOP = Decoration.line({ class: 'cm-frontmatter-line cm-frontmatter-top' })
const FRONTMATTER_BOTTOM = Decoration.line({ class: 'cm-frontmatter-line cm-frontmatter-bottom' })
const FRONTMATTER_KEY = Decoration.mark({ class: 'cm-frontmatter-key' })

function buildFrontmatterDeco(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const range = frontmatterRange(view.state)
  if (!range) return builder.finish()
  const doc = view.state.doc
  const startLine = doc.lineAt(range.from).number
  const endLine = doc.lineAt(range.to).number
  for (let i = startLine; i <= endLine; i++) {
    const line = doc.line(i)
    // Line decoration first (its start side sorts before any mark at the same
    // offset), then the key mark for property lines.
    builder.add(
      line.from,
      line.from,
      i === startLine ? FRONTMATTER_TOP : i === endLine ? FRONTMATTER_BOTTOM : FRONTMATTER_LINE
    )
    if (i !== startLine && i !== endLine) {
      // Mark the key (text before the first `:`) so it reads as a muted label
      // next to its value — a metadata panel, not a wall of text.
      const colon = line.text.indexOf(':')
      if (colon > 0) builder.add(line.from, line.from + colon, FRONTMATTER_KEY)
    }
  }
  return builder.finish()
}

export const frontmatterStyle = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildFrontmatterDeco(view)
    }
    update(update: ViewUpdate): void {
      if (update.docChanged) this.decorations = buildFrontmatterDeco(update.view)
    }
  },
  { decorations: (v) => v.decorations }
)

const TAG_TOKEN_RE = /[^,\s\[\]"'#]+/g

/** A frontmatter `key: value` line, split into its key and value.
 *  `parseFrontmatterFields` (shared-domain) lowercases keys, so `Tags:` is the
 *  tags field as far as the vault index is concerned; anything reading the
 *  same field in the editor has to agree, or a note written with a capital T
 *  gets tags the Tags view lists and the editor refuses to show. */
const FRONTMATTER_KEY_RE = /^(\s*)([A-Za-z0-9_][\w-]*)\s*:\s*(.*)$/

export function frontmatterTagsValue(lineText: string): { value: string; offset: number } | null {
  const match = lineText.match(FRONTMATTER_KEY_RE)
  if (!match || match[2].toLowerCase() !== 'tags') return null
  const value = match[3] ?? ''
  return { value, offset: match[0].length - value.length }
}

/** Which frontmatter lines are `- item` entries under a bare `tags:` key. */
function tagsBlockLineNumbers(state: EditorState): Set<number> {
  const range = frontmatterRange(state)
  if (!range) return new Set()
  const doc = state.doc
  const startLine = doc.lineAt(range.from).number
  const endLine = doc.lineAt(range.to).number
  const lines = new Set<number>()
  let inTags = false
  for (let n = startLine + 1; n < endLine; n++) {
    const text = doc.line(n).text
    const trimmed = text.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const key = text.match(/^([A-Za-z0-9_][\w-]*)\s*:\s*(.*)$/)
    if (key) {
      inTags = key[1].toLowerCase() === 'tags' && key[2].trim() === ''
      continue
    }
    if (inTags && /^\s*-\s+/.test(text)) {
      lines.add(n)
      continue
    }
    if (!/^\s/.test(text)) inTags = false
  }
  return lines
}

function addTagTokens(value: string, valueStartAbs: number, builder: RangeSetBuilder<Decoration>): void {
  TAG_TOKEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TAG_TOKEN_RE.exec(value)) !== null) {
    const token = m[0]
    const tag = token.replace(/^#/, '')
    if (!tag) continue
    const from = valueStartAbs + m.index + (token.length - tag.length)
    const to = from + tag.length
    builder.add(
      from,
      to,
      Decoration.mark({ class: 'cm-frontmatter-tag', attributes: { 'data-tag': tag } })
    )
  }
}

function buildFrontmatterTagDeco(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const range = frontmatterRange(view.state)
  if (!range) return builder.finish()
  const doc = view.state.doc
  const startLine = doc.lineAt(range.from).number
  const endLine = doc.lineAt(range.to).number
  const blockLines = tagsBlockLineNumbers(view.state)
  for (let n = startLine + 1; n < endLine; n++) {
    const line = doc.line(n)
    const text = line.text
    const trimmed = text.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const inline = frontmatterTagsValue(text)
    if (inline) {
      addTagTokens(inline.value, line.from + inline.offset, builder)
      continue
    }
    if (blockLines.has(n)) {
      const item = text.match(/^(\s*)-\s+(.*)$/)
      if (item) {
        const value = item[2] as string
        const valueStart = line.from + item[0].length - value.length
        addTagTokens(value, valueStart, builder)
      }
    }
  }
  return builder.finish()
}

const frontmatterTagPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildFrontmatterTagDeco(view)
    }
    update(update: ViewUpdate): void {
      if (update.docChanged) this.decorations = buildFrontmatterTagDeco(update.view)
    }
  },
  { decorations: (v) => v.decorations }
)

// Clicking a frontmatter tag opens the tag view, mirroring inline hashtags.
const frontmatterTagClick = EditorView.domEventHandlers({
  mousedown: (event) => {
    const target = event.target as HTMLElement | null
    const el = target?.closest<HTMLElement>('.cm-frontmatter-tag')
    const tag = el?.dataset.tag
    if (!tag) return false
    event.preventDefault()
    void useStore.getState().openTagView(tag)
    return true
  }
})

export const frontmatterTagExtension = [frontmatterTagPlugin, frontmatterTagClick]
