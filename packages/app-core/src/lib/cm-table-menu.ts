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

  for (const item of items) {
    if (item.kind === 'sep') {
      const sep = document.createElement('div')
      sep.className = 'cm-table-menu-sep'
      menu.append(sep)
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
  }

  document.body.append(menu)
  openMenu = menu

  // Position, flipping to stay on-screen.
  const rect = menu.getBoundingClientRect()
  const x = Math.min(req.x, window.innerWidth - rect.width - 8)
  const y = Math.min(req.y, window.innerHeight - rect.height - 8)
  menu.style.left = `${Math.max(8, x)}px`
  menu.style.top = `${Math.max(8, y)}px`

  // Keyboard navigation (Vim-friendly): j/k or ↓/↑ move the highlight, Enter
  // invokes, Esc closes. Lets the whole action set be driven without a mouse.
  const enabledButtons = Array.from(
    menu.querySelectorAll<HTMLButtonElement>('.cm-table-menu-item:not(:disabled)')
  )
  let activeIndex = 0
  const focusItem = (i: number): void => {
    if (enabledButtons.length === 0) return
    activeIndex = (i + enabledButtons.length) % enabledButtons.length
    enabledButtons[activeIndex].focus()
  }

  const onDown = (e: MouseEvent): void => {
    if (!menu.contains(e.target as Node)) closeTableContextMenu()
  }
  const NAV_KEYS = ['Escape', 'ArrowDown', 'j', 'ArrowUp', 'k', 'Enter', ' ']
  const onKey = (e: KeyboardEvent): void => {
    if (!NAV_KEYS.includes(e.key)) return
    // Consume the key fully so it can't also drive global/editor shortcuts
    // while the menu is open.
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') closeTableContextMenu()
    else if (e.key === 'ArrowDown' || e.key === 'j') focusItem(activeIndex + 1)
    else if (e.key === 'ArrowUp' || e.key === 'k') focusItem(activeIndex - 1)
    else enabledButtons[activeIndex]?.click()
  }
  // Defer so the originating contextmenu/right-click doesn't immediately close it.
  setTimeout(() => {
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    focusItem(0)
  }, 0)

  teardown = () => {
    window.removeEventListener('mousedown', onDown, true)
    window.removeEventListener('keydown', onKey, true)
    menu.remove()
    if (openMenu === menu) openMenu = null
    teardown = null
    if (!actioned) previouslyFocused?.focus?.()
  }
}

function alignItem(
  label: string,
  align: ColumnAlign,
  col: number,
  model: MarkdownTable,
  apply: TableMenuRequest['apply'],
  row: number
): MenuItem {
  const active = model.aligns[col] === align
  return {
    kind: 'item',
    label: active ? `${label} ✓` : label,
    run: () =>
      apply(setColumnAlign(model, col, active ? 'none' : align), { row, col })
  }
}
