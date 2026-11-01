/**
 * Obsidian-style checkbox toggle for the note editor (Mod+L).
 *
 * One command, applied to every line the selection touches:
 *   - a line with no checkbox becomes one, keeping any indentation,
 *     blockquote prefix, and existing list marker (`* note` -> `* [ ] note`,
 *     plain text -> `- [ ] text`),
 *   - `[ ]` and `[/]` (in progress) check off to `[x]`,
 *   - `[x]` / `[X]` uncheck back to `[ ]`.
 *
 * Forwarded `[>]` and cancelled `[-]` lines are left alone: both are
 * deliberate states with their own commands, and the live-preview checkbox
 * widget refuses to toggle a forwarded marker for the same reason.
 *
 * Each line contributes one minimal change (a single state character, or one
 * marker insertion), so cursors and selections map through naturally and the
 * whole toggle is a single undo step. The exception is checking off a
 * recurring task (#1036): its block is rewritten with the next occurrence
 * above it, and a lone cursor on it stays on the open occurrence.
 */
import type { ChangeSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { recurringCheckOff } from './cm-task-recurrence'

// Leading whitespace plus any run of blockquote markers (`> `, nestable).
const LINE_PREFIX_RE = /^([ \t]*(?:>[ \t]?)*)/
// A list marker after the prefix: bullet or ordered, with its trailing gap.
const LIST_MARKER_RE = /^([-*+]|\d{1,9}[.)])([ \t]+)/
// A task marker after the list marker: `[c]` followed by whitespace or EOL.
const TASK_STATE_RE = /^\[(.)\](?:[ \t]|$)/

/** The minimal change that toggles `line` (text at absolute offset `from`),
 *  or null when the line is intentionally left alone. */
export function checkboxToggleChange(line: string, from: number): ChangeSpec | null {
  const prefix = LINE_PREFIX_RE.exec(line)![1]
  const afterPrefix = line.slice(prefix.length)

  const marker = LIST_MARKER_RE.exec(afterPrefix)
  if (marker) {
    const markerEnd = prefix.length + marker[0].length
    const state = TASK_STATE_RE.exec(line.slice(markerEnd))
    if (state) {
      const stateChar = state[1]
      // Forwarded and cancelled stay untouched; everything else flips
      // between checked and unchecked, matching the checkbox widget.
      if (stateChar === '>' || stateChar === '-') return null
      const at = from + markerEnd + 1
      return { from: at, to: at + 1, insert: /[xX]/.test(stateChar) ? ' ' : 'x' }
    }
    return { from: from + markerEnd, insert: '[ ] ' }
  }

  return { from: from + prefix.length, insert: '- [ ] ' }
}

/** Toggle the checkbox on every line any selection range touches. */
export function toggleCheckbox(view: EditorView): boolean {
  const { state } = view
  const changes: ChangeSpec[] = []
  const seen = new Set<number>()
  let stayOn: { from: number; column: number; length: number } | null = null
  const selected = new Set<number>()
  for (const range of state.selection.ranges) {
    const last = state.doc.lineAt(range.to).number
    for (let n = state.doc.lineAt(range.from).number; n <= last; n += 1) selected.add(n)
  }
  for (const range of state.selection.ranges) {
    const firstLine = state.doc.lineAt(range.from).number
    const lastLine = state.doc.lineAt(range.to).number
    for (let n = firstLine; n <= lastLine; n += 1) {
      if (seen.has(n)) continue
      seen.add(n)
      const line = state.doc.line(n)
      const change = checkboxToggleChange(line.text, line.from)
      if (!change) continue
      const recurring = isCheckOff(change)
        ? recurringCheckOff(state, n, { ticked: (ln) => selected.has(ln) })
        : null
      if (recurring) {
        changes.push(recurring.change)
        // The change rewrites the task's whole subtree; a selected subtask
        // inside it is already handled and must not add a second change.
        for (let m = n + 1; m <= recurring.lastLine; m += 1) seen.add(m)
        if (state.selection.ranges.length === 1 && range.empty) {
          stayOn = { from: line.from, column: range.head - line.from, length: recurring.openLineLength }
        }
      } else {
        changes.push(change)
      }
    }
  }
  if (changes.length > 0) {
    view.dispatch({
      changes,
      userEvent: 'input',
      // The whole line is replaced, which would map the cursor to its start.
      ...(stayOn
        ? { selection: { anchor: stayOn.from + Math.min(stayOn.column, stayOn.length) } }
        : {})
    })
  }
  return true
}

/** True when `change` writes the `x` that checks a task off. */
function isCheckOff(change: ChangeSpec): boolean {
  return typeof change === 'object' && 'insert' in change && change.insert === 'x' && change.to !== undefined
}
