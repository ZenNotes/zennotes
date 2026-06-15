import type { EditorState } from '@codemirror/state'

const FENCE_START_RE = /^\s*(`{3,}|~{3,})/
const FENCE_END_RE = /^\s*(`{3,}|~{3,})\s*$/

export function isClosedFencedCodeBlock(
  state: EditorState,
  from: number,
  to: number
): boolean {
  const firstLine = state.doc.lineAt(from)
  const lastLine = state.doc.lineAt(Math.max(from, to - 1))
  if (lastLine.number <= firstLine.number) return false

  const opener = firstLine.text.match(FENCE_START_RE)?.[1]
  const closer = lastLine.text.match(FENCE_END_RE)?.[1]
  if (!opener || !closer) return false

  return closer[0] === opener[0] && closer.length >= opener.length
}
