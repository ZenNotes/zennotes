/**
 * Frontmatter `tags:` autocomplete. Typing inside the value of a frontmatter
 * `tags:` field (inline list, scalar, or block-list form) surfaces the same
 * existing-tag suggestions as inline `#tags`, but without the leading `#`.
 */
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import type { EditorState } from '@codemirror/state'
import { collectTagCounts, rankTagCompletions } from './cm-hashtag-complete'
import { frontmatterTagsValue, isInsideFrontmatter } from './cm-frontmatter'

/** Characters that terminate a tag token when scanning forward or backward
 *  for the *body* of the token. A leading `#` is intentionally not a start
 *  delimiter: if someone types `#pro` in a frontmatter value, the `#` is
 *  consumed and replaced with the selected tag. */
const TOKEN_BODY_DELIMITERS = /[\s,\[\]"'#]/
const TOKEN_START_DELIMITERS = /[\s,\[\]"']/ 

function tokenEndAt(state: EditorState, pos: number): number {
  const line = state.doc.lineAt(pos)
  const text = line.text
  const col = pos - line.from
  let i = col
  while (i < text.length && !TOKEN_BODY_DELIMITERS.test(text[i] as string)) i++
  return line.from + i
}

function tagTokenAt(
  state: EditorState,
  lineStart: number,
  valueStart: number,
  pos: number
): { from: number; query: string } | null {
  const line = state.doc.lineAt(lineStart)
  const text = line.text
  const cursor = pos - line.from
  if (cursor < valueStart) return null
  let i = cursor - 1
  while (i >= valueStart && !TOKEN_START_DELIMITERS.test(text[i] as string)) i--
  const tokenStart = i + 1
  const token = text.slice(tokenStart, cursor)
  if (token.length < 1) return null
  return { from: line.from + tokenStart, query: token.replace(/^#/, '') }
}

function isUnderTagsKey(state: EditorState, lineNo: number): boolean {
  for (let i = lineNo - 1; i >= 2; i--) {
    const text = state.doc.line(i).text
    const trimmed = text.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const key = text.match(/^([A-Za-z0-9_][\w-]*)\s*:\s*(.*)$/)
    if (key) {
      return key[1].toLowerCase() === 'tags' && key[2].trim() === ''
    }
    if (/^\s*-\s+/.test(text)) continue
    return false
  }
  return false
}

function frontmatterTagMatch(context: CompletionContext): { from: number; query: string } | null {
  const { state, pos } = context
  if (!isInsideFrontmatter(state, pos)) return null
  const line = state.doc.lineAt(pos)
  const text = line.text
  const col = pos - line.from

  const inline = frontmatterTagsValue(text)
  if (inline) {
    if (col < inline.offset) return null
    return tagTokenAt(state, line.from, inline.offset, pos)
  }

  const item = text.match(/^(\s*)-\s+(.*)$/)
  if (item) {
    if (!isUnderTagsKey(state, line.number)) return null
    const valueStart = item[0].length - (item[2] as string).length
    if (col < valueStart) return null
    return tagTokenAt(state, line.from, valueStart, pos)
  }

  return null
}

export function frontmatterTagSource(context: CompletionContext): CompletionResult | null {
  const match = frontmatterTagMatch(context)
  if (!match || match.query.length < 1) return null

  const ranked = rankTagCompletions(match.query, collectTagCounts())
  if (ranked.length === 0) return null

  const options: Completion[] = ranked.map(({ tag, count }) => ({
    label: tag,
    displayLabel: tag,
    detail: count > 1 ? `${count}` : '',
    _icon: '#',
    apply: (view, _completion, _from, to) => {
      const end = tokenEndAt(view.state, to)
      view.dispatch({
        changes: { from: match.from, to: end, insert: tag },
        selection: { anchor: match.from + tag.length }
      })
    }
  }))

  return { from: match.from, options, filter: false }
}
