import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import type { EditorState, TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

export interface TemplateVariable {
  /** Token name matched after `{{` (e.g. "date:FORMAT"). */
  name: string
  /** Text inserted when chosen. */
  insert: string
  detail: string
}

export const TEMPLATE_VARIABLES: TemplateVariable[] = [
  { name: 'title', insert: '{{title}}', detail: 'The note title' },
  { name: 'date', insert: '{{date}}', detail: "Today's date (YYYY-MM-DD)" },
  {
    name: 'date:FORMAT',
    insert: '{{date:YYYY-MM-DD}}',
    detail: 'Custom date format — yyyy MM dd EEEE ww (same tokens as note patterns)'
  },
  { name: 'time', insert: '{{time}}', detail: 'Current time (HH:mm)' },
  { name: 'week', insert: '{{week}}', detail: 'ISO week number' },
  {
    name: 'modified_date',
    insert: '{{modified_date}}',
    detail: 'Live: the date the note was last saved (stays in the note, always current)'
  },
  {
    name: 'modified_time',
    insert: '{{modified_time}}',
    detail: 'Live: the time the note was last saved (HH:mm)'
  },
  {
    name: 'modified_datetime',
    insert: '{{modified_datetime}}',
    detail: 'Live: date and time the note was last saved'
  },
  { name: 'cursor', insert: '{{cursor}}', detail: 'Where the caret lands' }
]

/**
 * Builds the change that applies a chosen variable. The inserted text carries
 * its own `}}`, so the replaced range swallows up to two closing braces
 * already sitting at the caret: with auto-pair brackets on, typing `{{`
 * produced `{{}}` around the caret, and completing inside an existing
 * `{{…}}` pair hits the same leftover (#566). The closers are only swallowed
 * when they can belong to this variable's own `{{`: if an earlier `{{` on
 * the line is still open (prose documenting Handlebars/Jinja syntax), the
 * braces after the caret are its closers, literal note content that must
 * survive the completion. Kept separate from the completion option so it can
 * be tested without a mounted editor.
 */
export function templateVariableApplySpec(
  state: EditorState,
  from: number,
  to: number,
  insert: string
): TransactionSpec {
  const line = state.doc.lineAt(from)
  const prefix = state.doc.sliceString(line.from, from)
  const openBefore = (prefix.match(/\{\{/g) ?? []).length
  const closedBefore = (prefix.match(/\}\}/g) ?? []).length
  const ownsClosers = openBefore <= closedBefore
  const after = state.doc.sliceString(to, to + 2)
  const consumed = !ownsClosers ? 0 : after.startsWith('}}') ? 2 : after.startsWith('}') ? 1 : 0
  return {
    changes: { from, to: to + consumed, insert },
    selection: { anchor: from + insert.length }
  }
}

/**
 * CodeMirror autocomplete source for template `{{variables}}`. Triggers once
 * `{{` has been typed and replaces the partial token with the full `{{…}}`.
 */
export function templateVariableSource(context: CompletionContext): CompletionResult | null {
  const { state, pos } = context
  const line = state.doc.lineAt(pos)
  const before = state.doc.sliceString(line.from, pos)
  const match = before.match(/\{\{\s*([a-zA-Z:]*)$/)
  if (!match) return null
  const from = pos - match[0].length
  const query = match[1].toLowerCase()
  const options: Completion[] = TEMPLATE_VARIABLES.filter(
    (variable) => !query || variable.name.toLowerCase().includes(query)
  ).map(
    (variable) =>
      ({
        label: variable.insert,
        detail: variable.detail,
        type: 'variable',
        // Read by the shared slash-command renderer (`slashCommandRender`) so
        // these rows render with the same icon/label/detail layout.
        _icon: '{}',
        apply: (view: EditorView, _completion: Completion, _from: number, to: number) => {
          view.dispatch(templateVariableApplySpec(view.state, from, to, variable.insert))
        }
      }) as Completion
  )
  if (options.length === 0) return null
  return { from, options, filter: false }
}
