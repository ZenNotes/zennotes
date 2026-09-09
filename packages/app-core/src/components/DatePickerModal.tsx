import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import {
  addMonths,
  buildMonthGrid,
  datePickerMoveForKey,
  firstOfMonth,
  formatISODate,
  monthTitle,
  moveDate,
  parseISODate,
  startOfDay
} from '../lib/date-picker'
import { isImeComposing } from '../lib/ime'
import { resolveWeekStartDay } from '../lib/week-start'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'
import { ChevronLeftIcon, ChevronRightIcon } from './icons'

export interface DatePickerOptions {
  title?: string
  description?: string
  /** `YYYY-MM-DD` the picker opens on; today when absent or malformed. */
  initialDate?: string
  okLabel?: string
}

const DAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

/**
 * The calendar behind `@date` (#743). Keyboard first: it opens with the
 * selected day focused, so arrows move and Enter inserts without a Tab
 * anywhere; typing a digit from the grid jumps to the text field for a date
 * typed outright. The grid always shows the month of the selected day, so a
 * move can never land on a day the user cannot see. Carries
 * `data-prompt-modal` like the text prompt so VimNav and the list views hand
 * the keyboard over while it is open.
 */
export function DatePickerModal({
  options,
  onSubmit,
  onCancel
}: {
  options: DatePickerOptions
  onSubmit: (iso: string) => void
  onCancel: () => void
}): JSX.Element {
  const vimMode = useStore((s) => s.vimMode)
  const weekStart = useStore((s) => s.calendarWeekStart)
  const firstDay = resolveWeekStartDay(weekStart)
  const today = useMemo(() => startOfDay(new Date()), [])
  const [selected, setSelected] = useState<Date>(
    () => (options.initialDate ? parseISODate(options.initialDate) : null) ?? today
  )
  const [anchor, setAnchor] = useState<Date>(() => firstOfMonth(selected))
  const [typed, setTyped] = useState(() => formatISODate(selected))
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const selectedCellRef = useRef<HTMLButtonElement>(null)
  // Set by a keyboard move in the grid; the effect below consumes it.
  const refocusGridRef = useRef(false)

  const selectedIso = formatISODate(selected)
  const todayIso = formatISODate(today)
  const grid = useMemo(() => buildMonthGrid(anchor, firstDay), [anchor, firstDay])
  const dayLabels = useMemo(
    () => Array.from({ length: 7 }, (_, i) => DAY_LABELS[(firstDay + i) % 7]),
    [firstDay]
  )
  // Roving tabindex: one cell is reachable by Tab, the selected day when the
  // grid shows it, else the first of the month being browsed.
  const tabbableIso = grid.some((day) => formatISODate(day) === selectedIso)
    ? selectedIso
    : formatISODate(anchor)

  function select(next: Date): void {
    setSelected(next)
    setAnchor(firstOfMonth(next))
    setTyped(formatISODate(next))
    setError(null)
  }

  // A keyboard move re-renders the grid with a new selected cell; put focus
  // on it so the next arrow continues from there. A move into another month
  // replaces every cell, which drops focus to the body before this effect
  // runs, so the decision to refocus is recorded by the move itself rather
  // than read from where focus happens to be.
  useEffect(() => {
    if (!refocusGridRef.current) return
    refocusGridRef.current = false
    selectedCellRef.current?.focus()
  }, [selectedIso])

  function submitTyped(): void {
    const parsed = parseISODate(typed.trim())
    if (!parsed) {
      setError('Type a real date as YYYY-MM-DD.')
      return
    }
    onSubmit(formatISODate(parsed))
  }

  const hint = vimMode
    ? 'h j k l or arrows move, t is today. PageUp/PageDown change the month, with Shift the year. Enter inserts.'
    : 'Arrows move. PageUp/PageDown change the month, with Shift the year. Enter inserts.'

  return (
    <Modal
      size="xs"
      layer="modal"
      onClose={onCancel}
      initialFocus={selectedCellRef}
      data={{ 'data-prompt-modal': '', 'data-date-picker': '' }}
    >
      <Modal.Header title={options.title ?? 'Insert date'} description={options.description} />
      <div className="px-5 pt-3">
        <input
          ref={inputRef}
          value={typed}
          placeholder="YYYY-MM-DD"
          aria-label="Date"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            const value = e.target.value
            setTyped(value)
            setError(null)
            // The grid follows a complete date as it is typed; partial input
            // leaves the last valid day selected.
            const parsed = parseISODate(value.trim())
            if (parsed) {
              setSelected(parsed)
              setAnchor(firstOfMonth(parsed))
            }
          }}
          onKeyDown={(e) => {
            if (isImeComposing(e)) return
            if (e.key === 'Enter') {
              e.preventDefault()
              submitTyped()
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              gridRef.current
                ?.querySelector<HTMLButtonElement>(`[data-date-cell="${tabbableIso}"]`)
                ?.focus()
            }
          }}
          className="w-full rounded-md border border-paper-300 bg-paper-50 px-2.5 py-1.5 text-sm text-ink-900 outline-none focus:border-accent"
        />
        {error && <div className="mt-2 text-xs text-danger">{error}</div>}
        <div className="mt-3 flex items-center justify-between">
          <button
            type="button"
            onClick={() => setAnchor((a) => addMonths(a, -1))}
            className="rounded p-1 text-ink-500 transition-colors hover:bg-paper-200 hover:text-ink-800"
            aria-label="Previous month"
          >
            <ChevronLeftIcon className="h-4 w-4" />
          </button>
          <span data-date-picker-month className="text-sm font-medium text-ink-800">
            {monthTitle(anchor)}
          </span>
          <button
            type="button"
            onClick={() => setAnchor((a) => addMonths(a, 1))}
            className="rounded p-1 text-ink-500 transition-colors hover:bg-paper-200 hover:text-ink-800"
            aria-label="Next month"
          >
            <ChevronRightIcon className="h-4 w-4" />
          </button>
        </div>
        <div
          ref={gridRef}
          role="grid"
          aria-label="Calendar"
          className="mt-2 grid grid-cols-7 gap-y-1"
          onKeyDown={(e) => {
            if (isImeComposing(e)) return
            if (e.metaKey || e.ctrlKey || e.altKey) return
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onSubmit(selectedIso)
              return
            }
            if (/^\d$/.test(e.key)) {
              // A digit means "let me type it": hand the keystroke to the
              // text field as the first character of a fresh date.
              e.preventDefault()
              setTyped(e.key)
              setError(null)
              inputRef.current?.focus()
              return
            }
            const move = datePickerMoveForKey(e.key, { shift: e.shiftKey, vimMode })
            if (!move) return
            e.preventDefault()
            refocusGridRef.current = true
            select(moveDate(selected, move, firstDay, today))
          }}
        >
          {dayLabels.map((label, i) => (
            <div
              key={`${label}-${i}`}
              role="columnheader"
              className="text-center text-2xs font-medium uppercase text-ink-400"
            >
              {label}
            </div>
          ))}
          {grid.map((day) => {
            const iso = formatISODate(day)
            const inMonth = day.getMonth() === anchor.getMonth()
            const isSelected = iso === selectedIso
            const isToday = iso === todayIso
            return (
              <button
                key={iso}
                ref={isSelected ? selectedCellRef : undefined}
                type="button"
                role="gridcell"
                aria-selected={isSelected}
                data-date-cell={iso}
                tabIndex={iso === tabbableIso ? 0 : -1}
                onClick={() => {
                  select(day)
                  onSubmit(iso)
                }}
                className={[
                  'flex h-8 items-center justify-center rounded text-sm transition-colors',
                  isSelected
                    ? 'bg-accent font-semibold text-white'
                    : isToday
                      ? 'font-semibold text-accent ring-1 ring-inset ring-accent/50 hover:bg-paper-200'
                      : inMonth
                        ? 'text-ink-700 hover:bg-paper-200'
                        : 'text-ink-400 hover:bg-paper-200'
                ].join(' ')}
              >
                {day.getDate()}
              </button>
            )
          })}
        </div>
        <div className="mt-3 flex items-start justify-between gap-3 text-xs text-ink-400">
          <span>{hint}</span>
          <button
            type="button"
            onClick={() => select(today)}
            className="shrink-0 rounded px-1.5 py-0.5 text-ink-500 transition-colors hover:bg-paper-200 hover:text-accent"
          >
            Today
          </button>
        </div>
      </div>
      <Modal.Footer>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => onSubmit(selectedIso)}>
          {options.okLabel ?? 'Insert'}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
