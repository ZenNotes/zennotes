import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'

interface DateShortcut {
  label: string
  detail: string
  insert: string
  searchText: string
  icon: string
}

function formatISODate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function formatSearchText(label: string, date: Date): string {
  return [
    label,
    formatISODate(date),
    date.toLocaleDateString(undefined, { weekday: 'long' }),
    date.toLocaleDateString(undefined, { month: 'long' }),
    String(date.getDate())
  ]
    .join(' ')
    .toLowerCase()
}

function buildShortcuts(now = new Date()): DateShortcut[] {
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const offsets = [
    { label: 'Today', days: 0 },
    { label: 'Yesterday', days: -1 },
    { label: 'Tomorrow', days: 1 }
  ]

  return offsets.map(({ label, days }) => {
    const date = new Date(base)
    date.setDate(base.getDate() + days)
    return {
      label,
      detail: formatISODate(date),
      insert: formatISODate(date),
      searchText: formatSearchText(label, date),
      icon: String(date.getDate())
    }
  })
}

function dateShortcutMatch(context: CompletionContext): {
  replaceFrom: number
  filterFrom: number
  query: string
} | null {
  const { state, pos } = context
  const line = state.doc.lineAt(pos)
  const textBefore = state.doc.sliceString(line.from, pos)
  const match = textBefore.match(/(?:^|[\s([{}])(@[^\s@]*)$/)
  if (!match) return null

  const token = match[1]
  const replaceFrom = pos - token.length
  return {
    replaceFrom,
    filterFrom: replaceFrom + 1,
    query: token.slice(1).toLowerCase()
  }
}

export function dateShortcutSource(context: CompletionContext): CompletionResult | null {
  const match = dateShortcutMatch(context)
  if (!match) return null

  const options = buildShortcuts()
    .filter((item) => !match.query || item.searchText.includes(match.query))
    .map(
      (item): Completion => ({
        label: item.label,
        detail: item.detail,
        type: 'text',
        _kind: 'date',
        _icon: item.icon,
        apply: (view: EditorView, _completion: Completion, _from: number, to: number) => {
          const anchor = match.replaceFrom + item.insert.length
          view.dispatch({
            changes: { from: match.replaceFrom, to, insert: item.insert },
            selection: { anchor }
          })
        }
      } as Completion & { _kind: 'date'; _icon: string })
    )

  if (options.length === 0) return null

  return {
    from: match.filterFrom,
    options,
    filter: false
  }
}
