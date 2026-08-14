/**
 * Render a note's leading YAML frontmatter block (the `---` … `---` at the very
 * top) as compact, muted "properties" instead of full-size body text. This is
 * the in-editor counterpart to how the preview hides frontmatter — and it makes
 * database "record page" notes (whose properties live in frontmatter) read like
 * a property list rather than a wall of big text.
 */
import { type EditorState, RangeSetBuilder } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate
} from '@codemirror/view'
import { useStore } from '../store'

/** Range of a closed leading `---` … `---` frontmatter block, or null if the
 *  document does not start with one. Used by autocomplete to avoid offering
 *  inline `#tags` inside frontmatter and to offer tags inside frontmatter
 *  `tags:` fields. */
export function frontmatterRange(state: EditorState): { from: number; to: number } | null {
  const doc = state.doc
  if (doc.lines < 2 || doc.line(1).text.trim() !== '---') return null
  for (let i = 2; i <= doc.lines; i++) {
    if (doc.line(i).text.trim() === '---') {
      return { from: doc.line(1).from, to: doc.line(i).to }
    }
  }
  return null
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
