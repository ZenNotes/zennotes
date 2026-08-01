/**
 * Right-click context menu for the WYSIWYG table widget. Self-contained DOM
 * menu (the widget lives outside React), mapping Obsidian's table action set
 * onto the pure ops in `markdown-table.ts`. Each action produces a new table
 * model and hands it to `apply`, which re-serializes and commits.
 */
import {
  deleteColumn,
  deleteRow,
  duplicateColumn,
  duplicateRow,
  insertColumn,
  insertRow,
  moveColumn,
  moveRow,
  setColumnAlign,
  sortByColumn,
  columnCount,
  type ColumnAlign,
  type MarkdownTable
} from './markdown-table'

export interface TableMenuRequest {
  x: number
  y: number
  /** Clicked cell — `row === -1` is the header row. */
  row: number
  col: number
  model: MarkdownTable
  apply: (next: MarkdownTable, focus?: { row: number; col: number }) => void
}

type MenuItem =
  | { kind: 'sep' }
  | { kind: 'item'; label: string; disabled?: boolean; run: () => void }

let openMenu: HTMLElement | null = null
let teardown: (() => void) | null = null

export function closeTableContextMenu(): void {
  if (teardown) teardown()
}

export function openTableContextMenu(req: TableMenuRequest): void {
  closeTableContextMenu()
  const { row, col, model, apply } = req
  // Restore focus to whatever opened the menu (e.g. a table cell) on close,
  // unless an action ran — that focuses its own target cell.
  const previouslyFocused = document.activeElement as HTMLElement | null
  let actioned = false
  const lastRow = model.rows.length - 1
  const lastCol = columnCount(model) - 1
  const onBody = row >= 0

  const items: MenuItem[] = [
    {
      kind: 'item',
      label: 'Add row above',
      disabled: !onBody,
      run: () => apply(insertRow(model, row), { row, col })
    },
    {
      kind: 'item',
      label: 'Add row below',
      run: () => {
        const at = onBody ? row + 1 : 0
        apply(insertRow(model, at), { row: at, col })
      }
    },
    {
      kind: 'item',
      label: 'Add column before',
      run: () => apply(insertColumn(model, col), { row, col })
    },
    {
      kind: 'item',
      label: 'Add column after',
      run: () => apply(insertColumn(model, col + 1), { row, col: col + 1 })
    },
    { kind: 'sep' },
    {
      kind: 'item',
      label: 'Move row up',
      disabled: !onBody || row === 0,
      run: () => apply(moveRow(model, row, row - 1), { row: row - 1, col })
    },
    {
      kind: 'item',
      label: 'Move row down',
      disabled: !onBody || row === lastRow,
      run: () => apply(moveRow(model, row, row + 1), { row: row + 1, col })
    },
    {
      kind: 'item',
      label: 'Move column left',
      disabled: col === 0,
      run: () => apply(moveColumn(model, col, col - 1), { row, col: col - 1 })
    },
    {
      kind: 'item',
      label: 'Move column right',
      disabled: col === lastCol,
      run: () => apply(moveColumn(model, col, col + 1), { row, col: col + 1 })
    },
    { kind: 'sep' },
    {
      kind: 'item',
      label: 'Duplicate row',
      disabled: !onBody,
      run: () => apply(duplicateRow(model, row), { row: row + 1, col })
    },
    {
      kind: 'item',
      label: 'Duplicate column',
      run: () => apply(duplicateColumn(model, col), { row, col: col + 1 })
    },
    { kind: 'sep' },
    {
      kind: 'item',
      label: 'Delete row',
      disabled: !onBody,
      run: () => apply(deleteRow(model, row))
    },
    {
      kind: 'item',
      label: 'Delete column',
      disabled: columnCount(model) <= 1,
      run: () => apply(deleteColumn(model, col))
    },
    { kind: 'sep' },
    alignItem('Align left', 'left', col, model, apply, row),
    alignItem('Align center', 'center', col, model, apply, row),
    alignItem('Align right', 'right', col, model, apply, row),
    alignItem('Align default', 'none', col, model, apply, row),
    { kind: 'sep' },
    {
      kind: 'item',
      label: 'Sort column (A → Z)',
      run: () => apply(sortByColumn(model, col, 'asc'))
    },
    {
      kind: 'item',
      label: 'Sort column (Z → A)',
      run: () => apply(sortByColumn(model, col, 'desc'))
    }
  ]

  const menu = document.createElement('div')
  menu.className = 'cm-table-menu'
  menu.setAttribute('role', 'menu')
  // Mark as a context menu so the app's global capture-phase key handlers
  // (VimNav note-list nav, pane focus, the list views) stand down while it's
  // open — otherwise j/k/Enter leak past the menu to the sidebar. (#437)
  menu.setAttribute('data-ctx-menu', '')

  const itemEntries: { el: HTMLButtonElement; label: string; disabled: boolean }[] = []
  const separators: HTMLElement[] = []
  for (const item of items) {
    if (item.kind === 'sep') {
      const sep = document.createElement('div')
      sep.className = 'cm-table-menu-sep'
      menu.append(sep)
      separators.push(sep)
      continue
    }
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'cm-table-menu-item'
    button.textContent = item.label
    if (item.disabled) {
      button.disabled = true
    } else {
      button.addEventListener('mousedown', (e) => e.preventDefault())
      button.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        actioned = true
        item.run()
        closeTableContextMenu()
      })
    }
    menu.append(button)
    itemEntries.push({ el: button, label: item.label, disabled: !!item.disabled })
  }

  // Type-to-filter header (mirrors the sidebar context menu) — hidden until the
  // user starts typing. (#438)
  const filterBar = document.createElement('div')
  filterBar.className = 'cm-table-menu-filter'
  filterBar.hidden = true
  const filterText = document.createElement('span')
  filterText.className = 'cm-table-menu-filter-text'
  const filterCount = document.createElement('span')
  filterCount.className = 'cm-table-menu-filter-count'
  filterBar.append(
    Object.assign(document.createElement('span'), {
      className: 'cm-table-menu-filter-label',
      textContent: 'filter'
    }),
    filterText,
    filterCount
  )
  menu.prepend(filterBar)
  const emptyEl = document.createElement('div')
  emptyEl.className = 'cm-table-menu-empty'
  emptyEl.textContent = 'No matches'
  emptyEl.hidden = true
  menu.append(emptyEl)

  document.body.append(menu)
  openMenu = menu

  // Position, flipping to stay on-screen.
  const rect = menu.getBoundingClientRect()
  const x = Math.min(req.x, window.innerWidth - rect.width - 8)
  const y = Math.min(req.y, window.innerHeight - rect.height - 8)
  menu.style.left = `${Math.max(8, x)}px`
  menu.style.top = `${Math.max(8, y)}px`

  // Keyboard navigation (Vim-friendly): j/k or ↓/↑ move the highlight, Enter
  // invokes, Esc closes. Any other printable character narrows the menu by
  // case-insensitive substring on the label, like the sidebar context menu;
  // Backspace deletes a character, Esc clears the filter before closing. j/k
  // stay reserved for movement (so they can't be filter characters), matching
  // that menu. (#438)
  let enabledButtons: HTMLButtonElement[] = []
  let activeIndex = 0
  let query = ''
  const setLabel = (btn: HTMLButtonElement, label: string, q: string): void => {
    const idx = q ? label.toLowerCase().indexOf(q) : -1
    if (idx < 0) {
      btn.textContent = label
      return
    }
    btn.textContent = ''
    btn.append(
      document.createTextNode(label.slice(0, idx)),
      Object.assign(document.createElement('span'), {
        className: 'cm-table-menu-match',
        textContent: label.slice(idx, idx + q.length)
      }),
      document.createTextNode(label.slice(idx + q.length))
    )
  }
  const applyFilter = (): void => {
    const q = query.trim().toLowerCase()
    for (const entry of itemEntries) {
      const match = q === '' || entry.label.toLowerCase().includes(q)
      entry.el.hidden = !match
      if (match) setLabel(entry.el, entry.label, q)
    }
    // Separators only make sense in the full, grouped list.
    for (const sep of separators) sep.hidden = q !== ''
    enabledButtons = itemEntries.filter((e) => !e.disabled && !e.el.hidden).map((e) => e.el)
    filterBar.hidden = q === ''
    filterText.textContent = query
    filterCount.textContent = String(enabledButtons.length)
    emptyEl.hidden = enabledButtons.length > 0
    if (enabledButtons.length === 0) return
    activeIndex = Math.min(activeIndex, enabledButtons.length - 1)
    enabledButtons[activeIndex].focus()
  }
  const focusItem = (i: number): void => {
    if (enabledButtons.length === 0) return
    activeIndex = (i + enabledButtons.length) % enabledButtons.length
    enabledButtons[activeIndex].focus()
  }

  const onDown = (e: MouseEvent): void => {
    if (!menu.contains(e.target as Node)) closeTableContextMenu()
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (query) {
        query = ''
        activeIndex = 0
        applyFilter()
      } else {
        closeTableContextMenu()
      }
      return
    }
    const plainKey = !e.metaKey && !e.ctrlKey && !e.altKey
    if (e.key === 'ArrowDown' || (plainKey && e.key === 'j')) {
      e.preventDefault()
      e.stopPropagation()
      focusItem(activeIndex + 1)
      return
    }
    if (e.key === 'ArrowUp' || (plainKey && e.key === 'k')) {
      e.preventDefault()
      e.stopPropagation()
      focusItem(activeIndex - 1)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      enabledButtons[activeIndex]?.click()
      return
    }
    if (e.key === 'Backspace') {
      if (query) {
        e.preventDefault()
        e.stopPropagation()
        query = query.slice(0, -1)
        activeIndex = 0
        applyFilter()
      }
      return
    }
    // A single printable character (no modifiers) narrows the menu.
    if (!plainKey) return
    if (e.key.length === 1) {
      e.preventDefault()
      e.stopPropagation()
      query += e.key
      activeIndex = 0
      applyFilter()
    }
  }
  // Defer so the originating contextmenu/right-click doesn't immediately close it.
  let tornDown = false
  setTimeout(() => {
    if (tornDown) return
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    applyFilter()
  }, 0)

  teardown = () => {
    tornDown = true
    window.removeEventListener('mousedown', onDown, true)
    window.removeEventListener('keydown', onKey, true)
    menu.remove()
    if (openMenu === menu) openMenu = null
    teardown = null
    if (!actioned) previouslyFocused?.focus?.()
  }
}

/**
 * One entry of the alignment radio group, ticked when the column already has
 * it. Choosing an alignment sets it — including "Align default", which is how a
 * column goes back to none.
 *
 * Picking the active alignment used to clear it, an invisible toggle: a column
 * with no alignment renders identically to a left-aligned one, so choosing
 * "Align left" twice looked like "nothing happened, then nothing happened",
 * and choosing it once on a fresh column looked like the first pick was
 * ignored. A ticked group with an explicit default says what the state is and
 * only ever moves it where you point. (#485)
 */
function alignItem(
  label: string,
  align: ColumnAlign,
  col: number,
  model: MarkdownTable,
  apply: TableMenuRequest['apply'],
  row: number
): MenuItem {
  const current = model.aligns[col] ?? 'none'
  return {
    kind: 'item',
    label: current === align ? `${label} ✓` : label,
    run: () => apply(setColumnAlign(model, col, align), { row, col })
  }
}
