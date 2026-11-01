import { useMemo, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { isPaletteNextKey, isPalettePreviousKey } from './palette-nav'
import {
  DEFAULT_FOLDER_PICKER_ROWS,
  filterFolderChoices,
  stepPickerIndex,
  type FolderChoice
} from './folder-picker'

export interface FolderPicker<T extends FolderChoice> {
  /** The rows for the field's text. Every folder until the field is typed
   *  in, even when it arrived filled: landing in it means the user came to
   *  look, or to change it. */
  rows: T[]
  /** The highlighted row, or -1 for the typed value. */
  active: number
  /** The row Enter would pick. A highlight can outlive its row when typing
   *  empties the list, so this reads the row, not just the index. */
  highlighted: T | undefined
  setActive: (index: number) => void
  /** The field took focus: list every folder, highlight none. */
  reset: () => void
  /** The field's text changed: narrow the rows and highlight the first, so
   *  Enter picks it without an arrow key first. The typed value stays one
   *  ArrowUp away, for a folder that does not exist yet. (#467) */
  typed: (text: string) => void
  /** Move the highlight on the palette keys (the arrows, Ctrl+N / Ctrl+P,
   *  Ctrl+J / Ctrl+K). True when the key was one of them. */
  step: (event: KeyboardEvent<HTMLElement>) => boolean
}

/** The keyboard half of a folder picker, shared by every field that has one. */
export function useFolderPicker<T extends FolderChoice>(
  choices: readonly T[],
  text: string,
  limit: number = DEFAULT_FOLDER_PICKER_ROWS
): FolderPicker<T> {
  const [active, setActive] = useState(-1)
  const [narrowed, setNarrowed] = useState(false)
  const rows = useMemo(
    () => filterFolderChoices(choices, narrowed ? text : '', limit),
    [choices, narrowed, text, limit]
  )
  return {
    rows,
    active,
    highlighted: active >= 0 ? rows[active] : undefined,
    setActive,
    reset: () => {
      setActive(-1)
      setNarrowed(false)
    },
    typed: (next) => {
      setNarrowed(true)
      setActive(next.trim() ? 0 : -1)
    },
    step: (event) => {
      const delta = isPaletteNextKey(event) ? 1 : isPalettePreviousKey(event) ? -1 : 0
      if (!delta) return false
      event.preventDefault()
      setActive((current) => stepPickerIndex(current, delta, rows.length))
      return true
    }
  }
}
