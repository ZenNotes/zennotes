import {
  Facet,
  Prec,
  StateField,
  type EditorState,
  type Extension,
  type TransactionSpec
} from '@codemirror/state'
import { keymap, type EditorView } from '@codemirror/view'

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

function isBlockOpenerLine(rule: MarkdownSnippetRule, text: string): boolean {
  const content = text.trimEnd().trimStart()
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

  const indentMatch = line.text.match(/^[\t ]*/)
  const indent = indentMatch?.[0] ?? ''

  const insert = `${line.text}\n${indent}\n${indent}${rule.close}`
  const cursor = line.from + line.text.length + 1 + indent.length
  return {
    changes: { from: line.from, to: line.to, insert },
    selection: { anchor: cursor }
  }
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
