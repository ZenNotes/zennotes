/**
 * #454: highlights task metadata on task lines in the WYSIWYG editor so it's as
 * scannable in a source note as it is in the Tasks view:
 *   - priority   `!high` / `!med` / `!low` (+ `!h`/`!m`/`!l`/`!medium`) — colored
 *   - due date   `due:YYYY-MM-DD` — a chip; overdue (past + still open) turns red
 *   - `@fields`  `@waiting`, `@key:value` — a secondary (purple) chip
 *
 * These are `Decoration.mark`s: the source text stays fully editable, we only
 * tint it. Only lines that parse as tasks (`TASK_LINE_RE`, outside code) are
 * scanned. Inline `#tags` are left to `cm-hashtags` (which runs document-wide).
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
import { TASK_LINE_RE } from '@shared/tasklists'
import { isTagSkippedContext } from './cm-hashtags'
import { fieldChip, scanTaskMetadata, todayIso } from './task-metadata-tokens'

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view
  const today = todayIso()
  const builder = new RangeSetBuilder<Decoration>()
  for (const { from, to } of view.visibleRanges) {
    const firstLine = state.doc.lineAt(from).number
    const lastLine = state.doc.lineAt(Math.max(from, to - 1)).number
    for (let n = firstLine; n <= lastLine; n++) {
      const line = state.doc.line(n)
      const task = TASK_LINE_RE.exec(line.text)
      if (!task) continue
      // Skip task-looking lines inside a code fence — they aren't real tasks.
      if (isTagSkippedContext(state, line.from)) continue

      const stateChar = task[2]
      const closed = stateChar === 'x' || stateChar === 'X' || stateChar === '-'
      // Scan only the content after the `[ ]` marker (task[1] + state char + `]`).
      const contentStart = task[1].length + task[2].length + 1
      const content = line.text.slice(contentStart)
      const base = line.from + contentStart

      const tokens = scanTaskMetadata(content)
      // RangeSetBuilder needs ascending, non-overlapping ranges; `scanTaskMetadata`
      // already returns them in order and the token types never overlap.
      for (const token of tokens) {
        const chip = fieldChip(token)
        const cls =
          token.kind === 'priority'
            ? `cm-task-prio cm-task-prio-${token.level}`
            : token.kind === 'due'
              ? !closed && (token.date ?? '') < today
                ? 'cm-task-meta cm-task-due-overdue'
                : 'cm-task-meta cm-task-due'
              : chip.variant
                ? `cm-task-meta cm-task-${chip.variant}${chip.invalid ? ' cm-task-meta-invalid' : ''}`
                : 'cm-task-meta cm-task-field'
        builder.add(
          base + token.start,
          base + token.end,
          Decoration.mark({ class: cls, ...(chip.title ? { attributes: { title: chip.title } } : {}) })
        )
      }
    }
  }
  return builder.finish()
}

const taskMetadataPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }
    update(update: ViewUpdate): void {
      if (
        update.docChanged ||
        update.viewportChanged ||
        // A parse cut short by its time budget finishes in a later update
        // that changes nothing else.
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  { decorations: (p) => p.decorations }
)

export const taskMetadataExtension = [taskMetadataPlugin]
