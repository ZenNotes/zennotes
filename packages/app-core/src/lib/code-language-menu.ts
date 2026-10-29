/**
 * The code block language picker (#1014): the label on a block, the "Set Code
 * Block Language…" command and `Space l l` all land here, so a pick is the
 * same one undoable change whichever way it came.
 *
 * The picker lives in the active EditorPane (it is that pane's state), so the
 * label, the palette and the leader key ask for it with a window event
 * (code-language-request.ts), the way the callout type menu is opened.
 */
import { isolateHistory } from '@codemirror/commands'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { fenceLanguageEdit, fenceLanguageToken, isPlainTextFenceTag } from './code-fence-language'
import {
  codeLanguageOptions,
  findCodeLanguageOption,
  type CodeLanguageOption
} from './code-language-catalog'

export interface CodeFence {
  /** Start of the opening fence characters (the FencedCode node). */
  from: number
  to: number
  /** Document offset just past the opening fence characters. */
  markEnd: number
  /** The language word as written, or null. */
  language: string | null
  /** The block's text, piece by piece, as the markdown parser hands it to a
   *  nested language: one piece per line inside a quote or a list item. */
  body: ReadonlyArray<{ from: number; to: number }>
}

export function codeFenceFromNode(state: EditorState, node: SyntaxNode): CodeFence | null {
  if (node.name !== 'FencedCode') return null
  const mark = node.firstChild
  if (!mark || mark.name !== 'CodeMark') return null
  const line = state.doc.lineAt(mark.from)
  const body: Array<{ from: number; to: number }> = []
  for (let child = mark.nextSibling; child; child = child.nextSibling) {
    if (child.name === 'CodeText') body.push({ from: child.from, to: child.to })
  }
  return {
    from: node.from,
    to: node.to,
    markEnd: mark.to,
    language: fenceLanguageToken(line.text, mark.to - line.from),
    body
  }
}

function fencedCodeAround(state: EditorState, pos: number): SyntaxNode | null {
  const tree = ensureSyntaxTree(state, pos, 200) ?? syntaxTree(state)
  for (const side of [1, -1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; node = node.parent) {
      if (node.name === 'FencedCode') return node
    }
  }
  return null
}

/** The fenced block the position is in, its fence lines included, or null. */
export function codeFenceAt(state: EditorState, pos: number): CodeFence | null {
  const node = fencedCodeAround(state, pos)
  if (node) return codeFenceFromNode(state, node)
  // The caret at the very end of a fence line can sit just past the node.
  const line = state.doc.lineAt(pos)
  const inLine = fencedCodeAround(state, line.from + (line.text.length - line.text.trimStart().length))
  return inLine ? codeFenceFromNode(state, inLine) : null
}

/** The block whose opening fence starts at `from`, or null once it is gone. */
export function codeFenceStartingAt(state: EditorState, from: number): CodeFence | null {
  if (from < 0 || from > state.doc.length) return null
  const fence = codeFenceAt(state, from)
  return fence && fence.from === from ? fence : null
}

/** The block's text without its fences (and without a quote's `>` markers). */
export function codeFenceText(state: EditorState, fence: CodeFence): string {
  return fence.body.map((piece) => state.doc.sliceString(piece.from, piece.to)).join('')
}

/**
 * Make `tag` the language of the block whose fence starts at `fenceFrom`, or
 * take its language away with null. Rewrites only the fence's info string, as
 * one Undo step, and leaves the selection where it was. False when there is
 * no such block any more, or nothing to change.
 */
export function setCodeFenceLanguage(view: EditorView, fenceFrom: number, tag: string | null): boolean {
  const { state } = view
  const fence = codeFenceStartingAt(state, fenceFrom)
  if (!fence) return false
  const line = state.doc.lineAt(fence.markEnd)
  const edit = fenceLanguageEdit(line.text, fence.markEnd - line.from, tag)
  if (!edit) return false
  view.dispatch({
    changes: { from: line.from + edit.from, to: line.from + edit.to, insert: edit.insert },
    // Its own history event, so one Undo takes back exactly this and typing
    // right after it never folds into it.
    annotations: isolateHistory.of('full'),
    userEvent: 'input.code-language'
  })
  return true
}

export interface CodeLanguagePick {
  label: string
  /** The tag a pick writes, when it is not the label lowercased. */
  hint?: string
  /** What the find field also matches: the tag and its aliases. */
  keywords: string[]
  checked: boolean
  /** The tag the pick writes; null takes the language away. */
  tag: string | null
  role: 'detected' | 'current' | 'text' | 'language'
}

/**
 * The picker's rows, in order: the guess for an unlabeled block ("Python
 * (detected)"), a row for a language the list does not know (so the current
 * one is always checked), "Text (plain)", then every language by name.
 */
export function codeLanguagePickerItems(
  current: string | null,
  detected: string | null,
  options: readonly CodeLanguageOption[] = codeLanguageOptions()
): CodeLanguagePick[] {
  const rows: CodeLanguagePick[] = []
  const currentKey = current?.trim().toLowerCase() || null
  const plain = currentKey === null || isPlainTextFenceTag(currentKey)
  const currentOption = currentKey && !plain ? findCodeLanguageOption(currentKey, options) : null

  if (currentKey === null && detected) {
    const option = findCodeLanguageOption(detected, options)
    rows.push({
      label: `${option?.name ?? detected} (detected)`,
      hint: detected,
      keywords: [detected, ...(option?.aliases ?? []), 'detected', 'guess'],
      checked: false,
      tag: detected,
      role: 'detected'
    })
  }
  if (currentKey && !plain && !currentOption) {
    rows.push({ label: current!.trim(), keywords: [], checked: true, tag: current!.trim(), role: 'current' })
  }
  rows.push({
    label: 'Text (plain)',
    keywords: ['text', 'plain', 'plaintext', 'txt', 'none', 'no language'],
    checked: plain,
    tag: null,
    role: 'text'
  })
  for (const option of options) {
    rows.push({
      label: option.name,
      hint: option.tag === option.name.toLowerCase() ? undefined : option.tag,
      keywords: [option.tag, ...option.aliases],
      checked: option === currentOption,
      tag: option.tag,
      role: 'language'
    })
  }
  return rows
}
