import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import { CALLOUT_TYPES } from './callout-types'

/**
 * The header of a callout being typed, up to the cursor: `> [!`, `>[!`, or
 * `> [!warn`. Requires the blockquote marker (callouts are blockquotes) and no
 * closing `]` yet — once the type is closed there's nothing left to pick.
 *   group 1 — the `>` prefix (used only to anchor the match to a quote line)
 *   group 2 — the partial type typed so far (may be empty)
 */
const CALLOUT_TRIGGER_RE = /^(\s*>\s?)\[!(\w*)$/

/**
 * CodeMirror completion source for Obsidian-style callout types. Activates when
 * `[!` is typed inside a blockquote line and offers the callout types with an
 * icon and description. Applying inserts `type] ` and lands the caret after it,
 * ready for an optional title.
 */
export function calloutTypeSource(context: CompletionContext): CompletionResult | null {
  const { state, pos } = context
  const line = state.doc.lineAt(pos)
  const textBefore = state.doc.sliceString(line.from, pos)

  const match = textBefore.match(CALLOUT_TRIGGER_RE)
  if (!match) return null

  const partial = match[2]
  const filterFrom = pos - partial.length // position right after `[!`

  return {
    from: filterFrom,
    options: CALLOUT_TYPES.map(
      (def, index): Completion =>
        ({
          // Fold aliases into the matched label so `[!warn`, `[!tldr`, etc. find
          // their canonical entry; `displayLabel` keeps the menu text clean.
          label: def.aliases.length ? `${def.label} ${def.aliases.join(' ')}` : def.label,
          displayLabel: def.label,
          // Preserve the curated `CALLOUT_TYPES` order (common types first)
          // instead of CodeMirror's default alphabetical sort.
          boost: CALLOUT_TYPES.length - index,
          _kind: 'callout',
          _icon: def.icon,
          _group: def.group,
          _subtitle: def.description,
          type: 'callout',
          apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
            const insert = `${def.type}] `
            view.dispatch({
              changes: { from, to, insert },
              selection: { anchor: from + insert.length }
            })
          }
        }) as Completion & {
          _kind: string
          _icon: string
          _group: string
          _subtitle: string
        }
    ),
    filter: true
  }
}
