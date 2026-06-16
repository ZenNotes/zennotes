import { Prec, type EditorState, type Extension, type TransactionSpec } from '@codemirror/state'
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

function hasBlockCloserBelow(
  state: EditorState,
  lineNumber: number,
  indent: string,
  close: string
): boolean {
  const expected = indent + close
  for (let number = lineNumber + 1; number <= state.doc.lines; number++) {
    if (state.doc.line(number).text.trimEnd() === expected) return true
  }
  return false
}

function blockSnippetTransaction(
  state: EditorState,
  rule: MarkdownSnippetRule,
  pos: number
): TransactionSpec | null {
  const line = state.doc.lineAt(pos)
  if (pos !== line.to) return null

  const before = state.doc.sliceString(line.from, pos)
  const indentLength = before.search(/[^\t ]/)
  const indent = indentLength === -1 ? before : before.slice(0, indentLength)
  if (before.slice(indent.length) !== rule.open) return null
  if (hasBlockCloserBelow(state, line.number, indent, rule.close)) return null

  const insert = `${indent}${rule.open}\n${indent}\n${indent}${rule.close}`
  const cursor = line.from + indent.length + rule.open.length + 1 + indent.length
  return {
    changes: { from: line.from, to: line.to, insert },
    selection: { anchor: cursor }
  }
}

function inlineSnippetTransaction(
  state: EditorState,
  rule: MarkdownSnippetRule,
  pos: number
): TransactionSpec | null {
  if (pos < rule.open.length) return null
  const from = pos - rule.open.length
  if (state.doc.sliceString(from, pos) !== rule.open) return null
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
  triggerKey: string,
  rules: readonly MarkdownSnippetRule[] = defaultMarkdownSnippetRules
): TransactionSpec | null {
  const selection = state.selection.main
  if (!selection.empty) return null

  for (const rule of rules) {
    if (!rule.triggerKeys.includes(triggerKey)) continue
    const transaction =
      rule.mode === 'block'
        ? blockSnippetTransaction(state, rule, selection.head)
        : inlineSnippetTransaction(state, rule, selection.head)
    if (transaction) return transaction
  }
  return null
}

export function markdownSnippetExtension(config: MarkdownSnippetExtensionConfig = {}): Extension {
  const rules = config.rules ?? defaultMarkdownSnippetRules
  const triggerKeys = [...new Set(rules.flatMap((rule) => rule.triggerKeys))]
  return Prec.high(
    keymap.of(
      triggerKeys.map((triggerKey) => ({
        key: triggerKey,
        run: (view) => {
          if (config.shouldHandle && !config.shouldHandle(view)) return false
          const transaction = markdownSnippetTransaction(view.state, triggerKey, rules)
          if (!transaction) return false
          view.dispatch(transaction)
          return true
        }
      }))
    )
  )
}
