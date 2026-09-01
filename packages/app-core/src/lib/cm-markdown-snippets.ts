import {
  Facet,
  Prec,
  StateField,
  type EditorState,
  type Extension,
  type TransactionSpec
} from '@codemirror/state'
import { keymap, type EditorView } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'

export type MarkdownSnippetMode = 'inline' | 'block'

export interface MarkdownSnippetRule {
  id: string
  open: string
  close: string
  triggerKeys: readonly string[]
  mode: MarkdownSnippetMode
}

export interface MarkdownSnippetExtensionConfig {
  rules?: readonly MarkdownSnippetRule[]
  shouldHandle?: (view: EditorView) => boolean
}

interface PendingBlockSnippet {
  ruleId: string
  lineFrom: number
}

export const defaultMarkdownSnippetRules: readonly MarkdownSnippetRule[] = [
  { id: 'fenced-code-backtick', open: '```', close: '```', triggerKeys: ['Enter'], mode: 'block' },
  { id: 'fenced-code-tilde', open: '~~~', close: '~~~', triggerKeys: ['Enter'], mode: 'block' },
  { id: 'math-block', open: '$$', close: '$$', triggerKeys: ['Enter'], mode: 'block' },
  { id: 'strong-asterisk', open: '**', close: '**', triggerKeys: ['Space'], mode: 'inline' },
  { id: 'strong-underscore', open: '__', close: '__', triggerKeys: ['Space'], mode: 'inline' },
  { id: 'strikethrough', open: '~~', close: '~~', triggerKeys: ['Space'], mode: 'inline' },
  { id: 'inline-code', open: '`', close: '`', triggerKeys: ['Space'], mode: 'inline' },
  { id: 'highlight', open: '==', close: '==', triggerKeys: ['Space'], mode: 'inline' },
  { id: 'wikilink', open: '[[', close: ']]', triggerKeys: ['Space'], mode: 'inline' },
  { id: 'comment', open: '%%', close: '%%', triggerKeys: ['Space'], mode: 'inline' }
]

const markdownSnippetRulesFacet = Facet.define<
  readonly MarkdownSnippetRule[],
  readonly MarkdownSnippetRule[]
>({
  combine: (values) => values.at(-1) ?? defaultMarkdownSnippetRules
})

// Leading whitespace plus any list/blockquote markers, i.e. everything before a
// fence's own column. Lets a block open inside a list item or quote (`- ```bash`,
// `> $$`) and lets its auto-inserted lines align to the fence column. (#405)
const BLOCK_INDENT_PREFIX_RE = /^[\t ]*(?:(?:[-+*]|\d{1,9}[.)])[\t ]+|>[\t ]?)*/

/** The whitespace to align a block's continuation lines to its fence column:
 *  the leading indent kept as-is, any list/quote marker turned into spaces. */
function blockIndentFor(lineText: string): string {
  const prefix = lineText.match(BLOCK_INDENT_PREFIX_RE)?.[0] ?? ''
  return prefix.replace(/[^\t ]/g, ' ')
}

function isBlockOpenerLine(rule: MarkdownSnippetRule, text: string): boolean {
  const prefix = text.match(BLOCK_INDENT_PREFIX_RE)?.[0] ?? ''
  const content = text.slice(prefix.length).trimEnd()
  if (!content.startsWith(rule.open)) return false
  const after = content.slice(rule.open.length)
  if (rule.open === '$$') return after.trim() === ''
  return true
}

function isBlockCloserLine(rule: MarkdownSnippetRule, text: string): boolean {
  return text.trim() === rule.close
}

function hasUnclosedBlockOpenerAbove(
  state: EditorState,
  lineNumber: number,
  rule: MarkdownSnippetRule
): boolean {
  let open = false
  for (let number = 1; number < lineNumber; number++) {
    const text = state.doc.line(number).text
    if (rule.open === rule.close) {
      if (isBlockOpenerLine(rule, text)) open = !open
    } else if (isBlockOpenerLine(rule, text)) {
      open = true
    } else if (isBlockCloserLine(rule, text)) {
      open = false
    }
  }
  return open
}

function blockPendingAt(
  state: EditorState,
  pos: number,
  rules: readonly MarkdownSnippetRule[]
): PendingBlockSnippet | null {
  const line = state.doc.lineAt(pos)
  if (pos !== line.to) return null

  for (const rule of rules) {
    if (rule.mode !== 'block') continue
    if (!isBlockOpenerLine(rule, line.text)) continue
    if (hasUnclosedBlockOpenerAbove(state, line.number, rule)) continue
    return { ruleId: rule.id, lineFrom: line.from }
  }
  return null
}

const pendingBlockSnippetField = StateField.define<PendingBlockSnippet | null>({
  create: () => null,
  update: (pending, tr) => {
    if (!tr.docChanged) {
      if (!pending) return null
      const selection = tr.state.selection.main
      if (!selection.empty) return null
      const line = tr.state.doc.lineAt(selection.head)
      if (line.from !== pending.lineFrom || selection.head !== line.to) return null
      const rule = tr.state
        .facet(markdownSnippetRulesFacet)
        .find((candidate) => candidate.id === pending.ruleId)
      if (!rule || !isBlockOpenerLine(rule, line.text)) return null
      return pending
    }
    if (!tr.isUserEvent('input')) return null
    const selection = tr.state.selection.main
    if (!selection.empty) return null
    return blockPendingAt(tr.state, selection.head, tr.state.facet(markdownSnippetRulesFacet))
  }
})

export function pendingMarkdownBlockSnippetLineFrom(state: EditorState): number | null {
  return state.field(pendingBlockSnippetField, false)?.lineFrom ?? null
}

export function hasPendingMarkdownBlockSnippet(state: EditorState): boolean {
  return pendingMarkdownBlockSnippetLineFrom(state) != null
}

export function isPendingMarkdownBlockSnippetStart(state: EditorState, from: number): boolean {
  return pendingMarkdownBlockSnippetLineFrom(state) === state.doc.lineAt(from).from
}

function blockSnippetTransaction(
  state: EditorState,
  pending: PendingBlockSnippet,
  rules: readonly MarkdownSnippetRule[]
): TransactionSpec | null {
  const rule = rules.find((candidate) => candidate.id === pending.ruleId)
  if (!rule) return null

  const selection = state.selection.main
  if (!selection.empty) return null
  const line = state.doc.lineAt(selection.head)
  if (line.from !== pending.lineFrom || selection.head !== line.to) return null
  if (!isBlockOpenerLine(rule, line.text)) return null
  if (hasUnclosedBlockOpenerAbove(state, line.number, rule)) return null
  // A `$$` (or nested fence marker) typed inside someone else's code block is
  // code content, not an opener; this line's own unclosed fence is the one
  // legitimate case (#718).
  if (isInsideCode(state, selection.head, line.number)) return null

  // Align to the fence column so a block opened inside a list item keeps its
  // content and closing fence inside the item instead of escaping to col 0 (#405).
  const indent = blockIndentFor(line.text)

  const insert = `${line.text}\n${indent}\n${indent}${rule.close}`
  const cursor = line.from + line.text.length + 1 + indent.length
  return {
    changes: { from: line.from, to: line.to, insert },
    selection: { anchor: cursor }
  }
}

/**
 * True when `pos` sits in code the parser already recognizes: a fenced block or
 * an inline code span. Markdown formatting means nothing there, so no snippet
 * may fire; `==` in a code block used to wrap into a highlight pair the moment
 * a comparison was followed by a space (#718).
 *
 * A fence's own opener line is exempt for block rules, via
 * `exceptFenceOpenedAtLine`: typing ``` parses as an unclosed FencedCode
 * immediately, and that line is exactly what the Enter-to-close snippet is
 * for. Only checked at trigger time, on a settled state, so the tree is
 * current rather than mid-update.
 */
function isInsideCode(
  state: EditorState,
  pos: number,
  exceptFenceOpenedAtLine?: number
): boolean {
  let node = syntaxTree(state).resolveInner(pos, -1)
  while (node) {
    if (node.name === 'InlineCode') return true
    if (node.name === 'FencedCode') {
      const openerLine = state.doc.lineAt(node.from).number
      return exceptFenceOpenedAtLine == null || openerLine !== exceptFenceOpenedAtLine
    }
    if (!node.parent) break
    node = node.parent
  }
  return false
}

function hasOddBackslashRun(text: string, before: number): boolean {
  let count = 0
  for (let i = before - 1; i >= 0 && text[i] === '\\'; i--) count++
  return count % 2 === 1
}

function countUnescapedOccurrences(text: string, token: string): number {
  let count = 0
  for (let index = 0; index <= text.length - token.length; index++) {
    if (text.slice(index, index + token.length) !== token) continue
    if (!hasOddBackslashRun(text, index)) count++
    index += token.length - 1
  }
  return count
}

function isOpeningDelimiter(state: EditorState, rule: MarkdownSnippetRule, from: number): boolean {
  const line = state.doc.lineAt(from)
  const before = state.doc.sliceString(line.from, from)
  if (hasOddBackslashRun(before, before.length)) return false
  if (rule.open === rule.close && countUnescapedOccurrences(before, rule.open) % 2 === 1) {
    return false
  }
  return true
}

function inlineSnippetTransaction(
  state: EditorState,
  rule: MarkdownSnippetRule,
  pos: number
): TransactionSpec | null {
  if (pos < rule.open.length) return null
  const from = pos - rule.open.length
  if (state.doc.sliceString(from, pos) !== rule.open) return null
  if (!isOpeningDelimiter(state, rule, from)) return null
  if (
    rule.open.length > 0 &&
    [...rule.open].every((char) => char === rule.open[0]) &&
    from > 0 &&
    state.doc.sliceString(from - 1, from) === rule.open[0]
  ) {
    return null
  }
  if (state.doc.sliceString(pos, Math.min(state.doc.length, pos + rule.close.length)) === rule.close) {
    return null
  }

  return {
    changes: { from, to: pos, insert: rule.open + rule.close },
    selection: { anchor: from + rule.open.length }
  }
}

export function markdownSnippetTransaction(
  state: EditorState,
  triggerKey: string
): TransactionSpec | null {
  const selection = state.selection.main
  if (!selection.empty) return null

  const rules = state.facet(markdownSnippetRulesFacet)
  const pending = state.field(pendingBlockSnippetField, false)
  if (pending) {
    const rule = rules.find((candidate) => candidate.id === pending.ruleId)
    if (rule?.triggerKeys.includes(triggerKey)) {
      const transaction = blockSnippetTransaction(state, pending, rules)
      if (transaction) return transaction
    }
  }

  // Inside a code block or inline code span, `==`, `**`, a backtick and the
  // rest are code, and wrapping them in formatting pairs is never right (#718).
  if (isInsideCode(state, selection.head)) return null

  for (const rule of rules) {
    if (rule.mode === 'block') continue
    if (!rule.triggerKeys.includes(triggerKey)) continue
    const transaction = inlineSnippetTransaction(state, rule, selection.head)
    if (transaction) return transaction
  }
  return null
}

export function markdownSnippetExtension(config: MarkdownSnippetExtensionConfig = {}): Extension {
  const rules = config.rules ?? defaultMarkdownSnippetRules
  const triggerKeys = [...new Set(rules.flatMap((rule) => rule.triggerKeys))]
  return [
    markdownSnippetRulesFacet.of(rules),
    pendingBlockSnippetField,
    Prec.high(
      keymap.of(
        triggerKeys.map((triggerKey) => ({
          key: triggerKey,
          run: (view) => {
            if (config.shouldHandle && !config.shouldHandle(view)) return false
            const transaction = markdownSnippetTransaction(view.state, triggerKey)
            if (!transaction) return false
            view.dispatch(transaction)
            return true
          }
        }))
      )
    )
  ]
}
