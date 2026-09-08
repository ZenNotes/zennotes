import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import type { TimeFormat } from '@shared/app-config'
import { useStore } from '../store'
import { formatISODate } from './date-picker'
import { promptDate } from './date-prompt-requests'

interface DateShortcut {
  label: string
  detail: string
  insert: string
  /** When set, computed fresh at apply time (used for the current time). */
  dynamicInsert?: () => string
  /** Opens the calendar instead of inserting `insert` (#743). */
  pick?: boolean
  searchText: string
  icon: string
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Wall-clock time in the given format: `14:30` (24h) or `2:30 PM` (12h). */
export function formatClockTime(date: Date, format: TimeFormat): string {
  const minutes = pad2(date.getMinutes())
  if (format === '12h') {
    const suffix = date.getHours() < 12 ? 'AM' : 'PM'
    const hour = date.getHours() % 12 || 12
    return `${hour}:${minutes} ${suffix}`
  }
  return `${pad2(date.getHours())}:${minutes}`
}

function currentTimeFormat(): TimeFormat {
  return useStore.getState().timeFormat
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

  const dates = offsets.map(({ label, days }): DateShortcut => {
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

  // #344: `@time` (or `@now`) inserts the current wall-clock time in the
  // configured 12h/24h format, computed fresh when the item is applied.
  const nowText = formatClockTime(now, currentTimeFormat())
  const time: DateShortcut = {
    label: 'Now',
    detail: nowText,
    insert: nowText,
    dynamicInsert: () => formatClockTime(new Date(), currentTimeFormat()),
    searchText: `now time clock ${nowText.toLowerCase()}`,
    icon: '🕘'
  }

  // #743: any other day. Its detail names the outcome, since there is no
  // date to preview until the calendar returns one.
  const pick: DateShortcut = {
    label: 'Date…',
    detail: 'Pick any date',
    insert: '',
    pick: true,
    searchText: 'date… date pick picker calendar choose any other day',
    icon: '📅'
  }

  return [...dates, time, pick]
}

/**
 * Trades the `@…` trigger for the calendar. The trigger goes first, so a
 * dismissed picker leaves the text as if nothing was typed, and the picked
 * date lands exactly where the `@` stood. The position is re-clamped at
 * insert time: the modal blocks editing, but a note switched underneath it
 * (a sync, a remote change) can still shorten the document.
 */
function pickDate(view: EditorView, from: number, to: number): void {
  view.dispatch({ changes: { from, to, insert: '' }, selection: { anchor: from } })
  void promptDate({ initialDate: formatISODate(new Date()) }).then((iso) => {
    if (iso) {
      const at = Math.min(from, view.state.doc.length)
      view.dispatch({
        changes: { from: at, insert: iso },
        selection: { anchor: at + iso.length }
      })
    }
    view.focus()
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
          if (item.pick) {
            pickDate(view, match.replaceFrom, to)
            return
          }
          const insert = item.dynamicInsert ? item.dynamicInsert() : item.insert
          view.dispatch({
            changes: { from: match.replaceFrom, to, insert },
            selection: { anchor: match.replaceFrom + insert.length }
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
