import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type {
  FocusEvent as ReactFocusEvent,
  InputHTMLAttributes,
  KeyboardEvent as ReactKeyboardEvent
} from 'react'
import { createPortal } from 'react-dom'
import { dropdownRectForElement, type DropdownRect } from '../lib/dropdown-placement'
import type { FolderChoice } from '../lib/folder-picker'
import { isImeComposing } from '../lib/ime'
import { useFolderPicker } from '../lib/use-folder-picker'
import { CheckIcon } from './icons'

/** Settings lists every folder, scrolling, rather than the New note form's
 *  short list; this only bounds a vault with thousands of them. */
const SETTINGS_FOLDER_ROWS = 200
const ROW_HEIGHT = 32

type PassThroughProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'onFocus' | 'onBlur' | 'onKeyDown' | 'role' | 'list'
>

/**
 * A text field for a vault folder (#1033). Focusing it lists the vault's
 * folders under it, typing narrows the list and highlights the first match,
 * and a typed path that matches nothing is still the field's value. The keys
 * are the palettes': the arrows, Ctrl+N / Ctrl+P (Ctrl+J / Ctrl+K), Enter to
 * pick, Escape to close the list. Letters are only ever text.
 *
 * The field stays the caller's: it owns the text and decides what a pick, an
 * Enter on typed text, a blur or an Escape with the list closed do, so each
 * Settings row keeps its own validation and save rules.
 */
export function FolderPickerInput({
  value,
  onChange,
  choices,
  onPick,
  onKeyDown,
  onFocus,
  onBlur,
  current,
  'aria-label': ariaLabel,
  ...inputProps
}: PassThroughProps & {
  value: string
  onChange: (text: string) => void
  choices: readonly FolderChoice[]
  /** A row was picked, by Enter or a click. The list has closed. */
  onPick: (value: string) => void
  /** Every key the picker does not take: Enter with no row highlighted,
   *  Escape with the list closed, and everything else. */
  onKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement>) => void
  onFocus?: () => void
  onBlur?: (event: ReactFocusEvent<HTMLInputElement>) => void
  /** The value saved now, ticked in the list. */
  current?: string | null
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const listId = useId()
  const [open, setOpen] = useState(false)
  // The field also blurs when the window loses focus, and takes focus back
  // with it. Coming back is not landing in the field anew: the list reopens
  // as it was, narrowed to the typed text, instead of listing everything.
  const resumeOnFocus = useRef(false)
  const [rect, setRect] = useState<DropdownRect | null>(null)
  const picker = useFolderPicker(choices, value, SETTINGS_FOLDER_ROWS)
  const shown = open && picker.rows.length > 0
  const rowCount = picker.rows.length

  useLayoutEffect(() => {
    if (!shown) return
    const update = (): void => {
      const el = inputRef.current
      if (el) setRect(dropdownRectForElement(el, { estHeight: rowCount * ROW_HEIGHT + 8 }))
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [shown, rowCount])

  useEffect(() => {
    if (!shown || picker.active < 0) return
    listRef.current
      ?.querySelector<HTMLElement>(`[data-folder-picker-idx="${picker.active}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [shown, picker.active])

  const pick = (choice: FolderChoice): void => {
    setOpen(false)
    picker.reset()
    onPick(choice.value)
  }

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (isImeComposing(e)) {
      onKeyDown?.(e)
      return
    }
    // A closed list (after a pick or Escape) opens again on the keys that
    // move through it, the way a combo box does.
    if (picker.step(e)) {
      setOpen(true)
      return
    }
    const plainEnter =
      e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey
    if (plainEnter && shown && picker.highlighted) {
      e.preventDefault()
      pick(picker.highlighted)
      return
    }
    if (e.key === 'Escape' && shown) {
      // Close the list only; Escape reaching Settings would close it too.
      // Nothing stays highlighted behind a closed list, so opening it again
      // starts from the typed value.
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
      picker.setActive(-1)
      return
    }
    onKeyDown?.(e)
  }

  return (
    <>
      <input
        {...inputProps}
        ref={inputRef}
        value={value}
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={shown}
        aria-controls={shown ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={
          shown && picker.highlighted ? `${listId}-${picker.active}` : undefined
        }
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => {
          onChange(e.target.value)
          picker.typed(e.target.value)
          setOpen(true)
        }}
        onFocus={() => {
          if (!resumeOnFocus.current) picker.reset()
          resumeOnFocus.current = false
          setOpen(true)
          onFocus?.()
        }}
        onBlur={(e) => {
          resumeOnFocus.current = !document.hasFocus()
          setOpen(false)
          onBlur?.(e)
        }}
        onKeyDown={handleKeyDown}
      />
      {shown &&
        rect &&
        createPortal(
          <div
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            data-folder-picker-list=""
            className="fixed z-popover flex flex-col overflow-hidden rounded-xl border border-paper-300 bg-paper-100 shadow-float"
            style={{
              left: rect.left,
              top: rect.top,
              bottom: rect.bottom,
              width: rect.width,
              maxHeight: rect.maxHeight
            }}
            // Rows take the click without taking focus, so the field keeps
            // it and its blur does not save a half-typed path first.
            onMouseDown={(e) => e.preventDefault()}
          >
            <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
              {picker.rows.map((row, i) => (
                <button
                  key={row.value}
                  id={`${listId}-${i}`}
                  type="button"
                  tabIndex={-1}
                  role="option"
                  aria-selected={i === picker.active}
                  data-folder-picker-idx={i}
                  data-folder-picker-option={row.value}
                  onClick={() => pick(row)}
                  onMouseMove={() => picker.setActive(i)}
                  className={[
                    'flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-sm',
                    i === picker.active ? 'bg-paper-200 text-ink-900' : 'text-ink-700'
                  ].join(' ')}
                >
                  <span className="min-w-0 flex-1 truncate">{row.label}</span>
                  {row.value === current && (
                    <CheckIcon width={14} height={14} className="shrink-0 text-accent" aria-hidden="true" />
                  )}
                </button>
              ))}
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
