import {
  useMemo,
  useRef,
  useState,
  useEffect,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from 'react'
import { createPortal } from 'react-dom'
import type { DatabaseDoc, DbField, DbRow, DbView, FieldType } from '@shared/databases'
import { filterRows, sortRows } from '@shared/database-transforms'
import { useStore } from '../store'
import {
  addRow,
  setCell,
  renameField,
  retypeField,
  deleteField,
  moveColumn,
  moveColumnToField,
  ensureSelectOption,
  updateView,
  fieldsById,
  formatDate,
  optionLabel,
  splitMultiSelect,
  isCheckboxTrue
} from '../lib/database-cells'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { IconButton } from './ui/Button'
import { MoreIcon, TrashIcon, PlusIcon, DocumentIcon, DocumentTextIcon, ArrowUpRightIcon } from './icons'
import { focusEditorNormalMode } from '../lib/editor-focus'
import { isImeComposing } from '../lib/ime'

const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: 'Text',
  number: 'Number',
  checkbox: 'Checkbox',
  date: 'Date',
  select: 'Select',
  multiSelect: 'Multi-select'
}

interface Props {
  csvPath: string
  doc: DatabaseDoc
  view: DbView
  /** True when this grid is the active pane's content — drives auto-focus. */
  isActive: boolean
}

export function DatabaseTableView({ csvPath, doc, view, isActive }: Props): JSX.Element {
  const updateDatabaseRows = useStore((s) => s.updateDatabaseRows)
  const updateDatabaseSchema = useStore((s) => s.updateDatabaseSchema)
  const deleteDatabaseRows = useStore((s) => s.deleteDatabaseRows)
  const openRecordPage = useStore((s) => s.openRecordPage)
  const renameRecordPage = useStore((s) => s.renameRecordPage)
  const focusedPanel = useStore((s) => s.focusedPanel)
  const setFocusedPanel = useStore((s) => s.setFocusedPanel)

  const titleFieldId = doc.fields.find((f) => f.id !== doc.idFieldId)?.id

  const [editing, setEditing] = useState<{ rowId: string; fieldId: string } | null>(null)
  const [renamingField, setRenamingField] = useState<string | null>(null)
  const [fieldMenu, setFieldMenu] = useState<{ fieldId: string; x: number; y: number } | null>(null)
  const [rowMenu, setRowMenu] = useState<{ rowId: string; x: number; y: number } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // #317: header drag-to-reorder columns. Ref holds the field being dragged;
  // state drives the drop-target indicator.
  const dragFieldRef = useRef<string | null>(null)
  const [dragOverFieldId, setDragOverFieldId] = useState<string | null>(null)

  // --- Vim-style keyboard grid ---------------------------------------------
  // The grid is the focus owner; cells bubble their key events up to it. A
  // `data-zen-db-grid` marker tells the global VimNav layer to yield so motions
  // aren't stolen by sidebar/note-list navigation.
  const gridRef = useRef<HTMLDivElement | null>(null)
  const [active, setActive] = useState<{ row: number; col: number }>({ row: 0, col: 0 })
  const gPending = useRef(false)
  const dPending = useRef(false)
  const prevEditing = useRef<typeof editing>(null)

  const map = useMemo(() => fieldsById(doc), [doc])
  const columns = useMemo(() => {
    const order = view.columnOrder ?? doc.fields.map((f) => f.id)
    const hidden = new Set(view.hiddenFieldIds ?? [])
    return order
      .map((id) => map.get(id))
      .filter((f): f is DbField => !!f && !f.hidden && !hidden.has(f.id))
  }, [doc.fields, view.columnOrder, view.hiddenFieldIds, map])

  const rows = useMemo(() => {
    return sortRows(filterRows(doc.rows, view.filters, map), view.sorts, map)
  }, [doc.rows, view.filters, view.sorts, map])

  const anySelected = selected.size > 0
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id))
  const toggleRow = (id: string): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const toggleAll = (): void => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))
  const deleteSelected = (): void => {
    void deleteDatabaseRows(csvPath, [...selected])
    setSelected(new Set())
  }

  // Open a record's page note, then move the cursor into its editor (otherwise
  // focus lingers on the table / sidebar after the tab swaps).
  const openPage = (rowId: string): void => {
    void openRecordPage(csvPath, rowId).then(() => focusEditorNormalMode())
  }

  const commitCell = (rowId: string, field: DbField, value: string): void => {
    if (field.type === 'select' || field.type === 'multiSelect') {
      // Ensure each chosen value exists as an option (schema), then set the cell.
      let next = doc
      const values = field.type === 'multiSelect' ? splitMultiSelect(value) : value ? [value] : []
      for (const v of values) next = ensureSelectOption(next, field.id, v)
      next = setCell(next, rowId, field.id, value)
      updateDatabaseSchema(csvPath, next)
    } else {
      updateDatabaseRows(csvPath, setCell(doc, rowId, field.id, value))
    }
    // Keep the linked page note's filename in step with the title field.
    if (field.id === titleFieldId && doc.pages?.[rowId]) {
      void renameRecordPage(csvPath, rowId)
    }
  }

  // Keep the active cell within bounds as rows/columns change.
  useEffect(() => {
    setActive((a) => ({
      row: Math.max(0, Math.min(a.row, rows.length - 1)),
      col: Math.max(0, Math.min(a.col, columns.length - 1))
    }))
  }, [rows.length, columns.length])

  // Scroll the active cell into view as it moves.
  useEffect(() => {
    const el = gridRef.current?.querySelector('[data-active-cell="true"]') as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])

  // When an inline edit ends (Esc/Enter blurs the input to <body>), return
  // focus to the grid so motions resume. Skip if the user clicked elsewhere.
  useEffect(() => {
    if (prevEditing.current && !editing) {
      const a = document.activeElement
      if (a === document.body || (gridRef.current && a && gridRef.current.contains(a))) {
        gridRef.current?.focus({ preventScroll: true })
      }
    }
    prevEditing.current = editing
  }, [editing])

  // Claim keyboard focus for the grid whenever it is the active pane's content
  // region — on first open, after a Ctrl+O jump back from a record page, after
  // a workspace restore (reopening the app), when the window regains focus, and
  // when focus comes back *down* from the tab strip (Ctrl+J / j, which sets
  // focusedPanel to 'editor') — so vim motions work without clicking a row.
  // Bails while the tab strip is the focused region (Ctrl+K moved up there) and
  // while an interactive control (a cell editor, a header button) owns focus,
  // so it never yanks the caret out from under the user. rAF lets the opening
  // click / restore settle so it can't steal focus back.
  useEffect(() => {
    if (!isActive || focusedPanel === 'tabs') return
    const claimFocus = (): void => {
      const a = document.activeElement as HTMLElement | null
      if (a && a !== document.body && a.closest('input, textarea, button, [contenteditable="true"]'))
        return
      gridRef.current?.focus({ preventScroll: true })
    }
    const raf = requestAnimationFrame(claimFocus)
    window.addEventListener('focus', claimFocus)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('focus', claimFocus)
    }
  }, [isActive, csvPath, focusedPanel])

  const onGridKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (editing) return // the cell's own input owns keys while editing
    // A focused text field inside the grid — the column-name editor, or any
    // cell input — owns its keys too: don't let h/j/k/l motions swallow typed
    // letters (e.g. the "l" in "url"), and let the arrow keys move the caret. (#110)
    const target = e.target as HTMLElement | null
    if (target?.closest('input, textarea') || target?.isContentEditable) return
    if (e.metaKey || e.ctrlKey || e.altKey) return // leave global shortcuts alone
    const lastRow = rows.length - 1
    const lastCol = columns.length - 1
    const clampRow = (n: number): number => Math.max(-1, Math.min(n, lastRow)) // -1 = column-header row
    const clampCol = (n: number): number => Math.max(0, Math.min(n, lastCol))
    const move = (row: number, col: number): void => {
      e.preventDefault()
      setActive({ row: clampRow(row), col: clampCol(col) })
    }
    const cell = (): { row: DbRow; field: DbField } | null => {
      const row = rows[active.row]
      const field = columns[active.col]
      return row && field ? { row, field } : null
    }
    const toggleCheckbox = (row: DbRow, field: DbField): void =>
      commitCell(row.id, field, isCheckboxTrue(row.cells[field.id] ?? '') ? 'false' : 'true')

    // Reset pending multi-key sequences when a different key arrives.
    if (gPending.current && e.key !== 'g') gPending.current = false
    if (dPending.current && e.key !== 'd') dPending.current = false

    switch (e.key) {
      case 'j':
      case 'ArrowDown':
        return move(active.row + 1, active.col)
      case 'k':
      case 'ArrowUp':
        return move(active.row - 1, active.col)
      case 'h':
      case 'ArrowLeft':
        return move(active.row, active.col - 1)
      case 'l':
      case 'ArrowRight':
        return move(active.row, active.col + 1)
      case 'H': {
        // #317: move the current column one step left, keeping the cursor on it.
        e.preventDefault()
        const field = columns[active.col]
        if (field && active.col > 0) {
          updateDatabaseSchema(csvPath, moveColumn(doc, view.id, field.id, 'left'))
          setActive({ row: active.row, col: active.col - 1 })
        }
        return
      }
      case 'L': {
        // #317: move the current column one step right, keeping the cursor on it.
        e.preventDefault()
        const field = columns[active.col]
        if (field && active.col < lastCol) {
          updateDatabaseSchema(csvPath, moveColumn(doc, view.id, field.id, 'right'))
          setActive({ row: active.row, col: active.col + 1 })
        }
        return
      }
      case '0':
      case '^':
        return move(active.row, 0)
      case '$':
        return move(active.row, lastCol)
      case 'G':
        return move(lastRow, active.col)
      case 'g':
        e.preventDefault()
        if (gPending.current) {
          gPending.current = false
          return move(0, active.col)
        }
        gPending.current = true
        return
      case 'd': {
        e.preventDefault()
        if (!dPending.current) {
          dPending.current = true
          return
        }
        dPending.current = false
        const c = cell()
        if (c) void deleteDatabaseRows(csvPath, [c.row.id])
        return
      }
      case 'Enter':
      case 'i': {
        e.preventDefault()
        if (active.row < 0) {
          // On the column header — rename the field, keyboard-only.
          const field = columns[active.col]
          if (field) setRenamingField(field.id)
          return
        }
        const c = cell()
        if (!c) return
        if (c.field.type === 'checkbox') return toggleCheckbox(c.row, c.field)
        setEditing({ rowId: c.row.id, fieldId: c.field.id })
        return
      }
      case ' ': {
        const c = cell()
        if (!c) return
        e.preventDefault()
        if (c.field.type === 'checkbox') return toggleCheckbox(c.row, c.field)
        return toggleRow(c.row.id)
      }
      case 'x': {
        const c = cell()
        if (!c) return
        e.preventDefault()
        return toggleRow(c.row.id)
      }
      case 'o': {
        const c = cell()
        if (!c) return
        e.preventDefault()
        return openPage(c.row.id)
      }
      case 'm': {
        // Open the context menu (like the sidebar's `m`), anchored to the
        // active header or cell. On a header → field menu; on a cell → row menu.
        e.preventDefault()
        if (active.row < 0) {
          const field = columns[active.col]
          if (!field) return
          const r = gridRef.current
            ?.querySelector<HTMLElement>('[data-active-header="true"]')
            ?.getBoundingClientRect()
          return setFieldMenu({ fieldId: field.id, x: r?.left ?? 0, y: r?.bottom ?? 0 })
        }
        const c = cell()
        if (!c) return
        const r = gridRef.current
          ?.querySelector<HTMLElement>('[data-active-cell="true"]')
          ?.getBoundingClientRect()
        return setRowMenu({ rowId: c.row.id, x: r?.left ?? 0, y: r?.bottom ?? 0 })
      }
      case 'a': {
        e.preventDefault()
        updateDatabaseRows(csvPath, addRow(doc))
        setActive((s) => ({ row: rows.length, col: s.col }))
        return
      }
      case 'Escape':
        e.preventDefault()
        if (selected.size > 0) {
          setSelected(new Set())
          return
        }
        gridRef.current?.blur()
        return
      default:
        return
    }
  }

  const sortIndicator = (fieldId: string): string => {
    const s = view.sorts.find((x) => x.fieldId === fieldId)
    return s ? (s.direction === 'asc' ? ' ↑' : ' ↓') : ''
  }

  const rowMenuItems = (rowId: string): ContextMenuItem[] => {
    const multi = selected.has(rowId) && selected.size > 1
    return [
      { label: 'Open page', onSelect: () => openPage(rowId) },
      { kind: 'separator' },
      {
        label: multi ? `Delete ${selected.size} rows` : 'Delete row',
        danger: true,
        onSelect: () =>
          multi ? deleteSelected() : void deleteDatabaseRows(csvPath, [rowId])
      }
    ]
  }

  const fieldMenuItems = (field: DbField): ContextMenuItem[] => [
    { label: 'Sort ascending', onSelect: () => updateDatabaseSchema(csvPath, updateView(doc, view.id, { sorts: [{ fieldId: field.id, direction: 'asc' }] })) },
    { label: 'Sort descending', onSelect: () => updateDatabaseSchema(csvPath, updateView(doc, view.id, { sorts: [{ fieldId: field.id, direction: 'desc' }] })) },
    { label: 'Clear sort', disabled: view.sorts.length === 0, onSelect: () => updateDatabaseSchema(csvPath, updateView(doc, view.id, { sorts: [] })) },
    { kind: 'separator' },
    {
      label: 'Move left',
      hint: 'H',
      disabled: columns[0]?.id === field.id,
      onSelect: () => updateDatabaseSchema(csvPath, moveColumn(doc, view.id, field.id, 'left'))
    },
    {
      label: 'Move right',
      hint: 'L',
      disabled: columns[columns.length - 1]?.id === field.id,
      onSelect: () => updateDatabaseSchema(csvPath, moveColumn(doc, view.id, field.id, 'right'))
    },
    { kind: 'separator' },
    { label: 'Rename field', onSelect: () => setRenamingField(field.id) },
    ...(Object.keys(FIELD_TYPE_LABELS) as FieldType[]).map((t) => ({
      label: `Type: ${FIELD_TYPE_LABELS[t]}`,
      hint: field.type === t ? '●' : undefined,
      onSelect: () => updateDatabaseSchema(csvPath, retypeField(doc, field.id, t))
    })),
    { kind: 'separator' },
    {
      label: 'Delete field',
      danger: true,
      disabled: field.id === doc.idFieldId,
      onSelect: () => updateDatabaseSchema(csvPath, deleteField(doc, field.id))
    }
  ]

  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col"
      onMouseDown={(e) => {
        // Clicking empty space anywhere in the table view (e.g. the large area
        // below the rows) keeps keyboard focus on the grid so vim motions keep
        // working without clicking a row. Cells, headers, and controls manage
        // their own focus, so leave those clicks alone.
        const t = e.target as HTMLElement
        if (t.closest('input, textarea, button, a, [contenteditable="true"], td, th')) return
        e.preventDefault()
        gridRef.current?.focus({ preventScroll: true })
      }}
    >
      {anySelected && (
        <div className="flex shrink-0 items-center gap-3 border-b border-paper-300/70 bg-paper-100 px-3 py-1.5 text-xs">
          <span className="font-medium text-ink-700">{selected.size} selected</span>
          <button
            type="button"
            onClick={deleteSelected}
            className="flex items-center gap-1 rounded px-1.5 py-1 font-medium text-danger hover:bg-danger/10"
          >
            <TrashIcon className="h-3.5 w-3.5" /> Delete
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="text-ink-500 hover:text-ink-900"
          >
            Clear
          </button>
        </div>
      )}
      <div
        ref={gridRef}
        tabIndex={0}
        role="grid"
        data-zen-db-grid
        onKeyDown={onGridKeyDown}
        // The grid is this pane's content region — mark it as the focused
        // 'editor' panel so vim pane navigation (Ctrl+W k → tabs, Ctrl+W h/l →
        // adjacent pane) treats it like the editor on every other surface.
        onFocus={() => {
          if (useStore.getState().focusedPanel !== 'editor') setFocusedPanel('editor')
        }}
        className="min-h-0 flex-1 overflow-auto outline-none focus:outline-none"
      >
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-paper-100">
            <tr className="border-b border-paper-300/70">
              <th className="group/sa w-10 border-r border-paper-300/40 align-middle">
                <div
                  className={[
                    'flex items-center justify-center',
                    anySelected ? '' : 'opacity-0 group-hover/sa:opacity-100'
                  ].join(' ')}
                >
                  <DbCheckbox checked={allSelected} onChange={toggleAll} title="Select all" />
                </div>
              </th>
            {columns.map((field, colIndex) => (
              <th
                key={field.id}
                data-active-header={active.row < 0 && active.col === colIndex}
                // #317: drag a header to reorder its column. Disabled while
                // renaming so the inline input keeps normal text selection.
                draggable={renamingField !== field.id}
                onDragStart={(e) => {
                  dragFieldRef.current = field.id
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', field.id) // some browsers need data set
                }}
                onDragOver={(e) => {
                  const dragged = dragFieldRef.current
                  if (!dragged || dragged === field.id) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  if (dragOverFieldId !== field.id) setDragOverFieldId(field.id)
                }}
                onDragLeave={() => {
                  if (dragOverFieldId === field.id) setDragOverFieldId(null)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  const dragged = dragFieldRef.current
                  dragFieldRef.current = null
                  setDragOverFieldId(null)
                  if (dragged && dragged !== field.id) {
                    updateDatabaseSchema(csvPath, moveColumnToField(doc, view.id, dragged, field.id))
                  }
                }}
                onDragEnd={() => {
                  dragFieldRef.current = null
                  setDragOverFieldId(null)
                }}
                className={[
                  'group/h min-w-32 max-w-[420px] border-r border-paper-300/40 px-2.5 py-2 text-left text-2xs font-medium uppercase tracking-wide text-ink-500',
                  active.row < 0 && active.col === colIndex ? 'ring-2 ring-inset ring-accent' : '',
                  // Drop indicator: the dragged column lands *before* this one.
                  dragOverFieldId === field.id ? 'border-l-2 border-l-accent bg-accent/5' : ''
                ].join(' ')}
              >
                {renamingField === field.id ? (
                  <input
                    autoFocus
                    defaultValue={field.name}
                    onFocus={(e) => e.currentTarget.select()}
                    onBlur={(e) => {
                      updateDatabaseSchema(csvPath, renameField(doc, field.id, e.currentTarget.value))
                      setRenamingField(null)
                      gridRef.current?.focus({ preventScroll: true })
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !isImeComposing(e)) e.currentTarget.blur()
                      else if (e.key === 'Escape') {
                        setRenamingField(null)
                        gridRef.current?.focus({ preventScroll: true })
                      }
                    }}
                    className="w-full rounded border border-accent bg-paper-50 px-1 py-0.5 text-sm text-ink-900 outline-none"
                  />
                ) : (
                  <div className="flex items-center justify-between gap-1">
                    <button
                      type="button"
                      onDoubleClick={() => setRenamingField(field.id)}
                      className="min-w-0 flex-1 truncate text-left"
                      title={`${field.name} · ${FIELD_TYPE_LABELS[field.type]}`}
                    >
                      {field.name}
                      <span className="text-accent">{sortIndicator(field.id)}</span>
                    </button>
                    <IconButton
                      size="sm"
                      className="opacity-0 group-hover/h:opacity-100"
                      title="Field options"
                      onClick={(e) => {
                        const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                        setFieldMenu({ fieldId: field.id, x: r.left, y: r.bottom })
                      }}
                    >
                      <MoreIcon className="h-3.5 w-3.5" />
                    </IconButton>
                  </div>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => {
            const isSel = selected.has(row.id)
            return (
              <tr
                key={row.id}
                onContextMenu={(e) => {
                  // Let the native menu through while editing a cell's input.
                  if ((e.target as HTMLElement).closest('input, textarea')) return
                  e.preventDefault()
                  setRowMenu({ rowId: row.id, x: e.clientX, y: e.clientY })
                }}
                className={[
                  'group/row border-b border-paper-300/30',
                  isSel ? 'bg-accent/8' : 'hover:bg-paper-200/30'
                ].join(' ')}
              >
                <td className="w-10 border-r border-paper-300/40 align-middle">
                  <div
                    className={[
                      'flex items-center justify-center',
                      isSel || anySelected ? '' : 'opacity-0 group-hover/row:opacity-100'
                    ].join(' ')}
                  >
                    <DbCheckbox checked={isSel} onChange={() => toggleRow(row.id)} title="Select row" />
                  </div>
                </td>
                {columns.map((field, colIndex) => {
                  const isActive = active.row === rowIndex && active.col === colIndex
                  const tdClassName = [
                    // #335: cap the column so a long Text value truncates instead
                    // of stretching the column to fill the table.
                    'relative max-w-[420px] border-r border-paper-300/40 p-0 align-top',
                    isActive ? 'ring-2 ring-inset ring-accent' : ''
                  ].join(' ')
                  // Keep keyboard focus on the grid container (not the inner
                  // button) so vim motions keep working; sync active to the click.
                  const onCellMouseDown = (e: ReactMouseEvent): void => {
                    if ((e.target as HTMLElement).closest('input, textarea')) {
                      setActive({ row: rowIndex, col: colIndex })
                      return
                    }
                    e.preventDefault()
                    setActive({ row: rowIndex, col: colIndex })
                    gridRef.current?.focus({ preventScroll: true })
                  }
                  const cell = (
                    <Cell
                      field={field}
                      value={row.cells[field.id] ?? ''}
                      editing={editing?.rowId === row.id && editing?.fieldId === field.id}
                      onStartEdit={() => setEditing({ rowId: row.id, fieldId: field.id })}
                      onEndEdit={() => setEditing(null)}
                      onCommit={(v) => commitCell(row.id, field, v)}
                    />
                  )
                  if (field.id !== titleFieldId) {
                    return (
                      <td
                        key={field.id}
                        data-active-cell={isActive}
                        onMouseDown={onCellMouseDown}
                        className={tdClassName}
                      >
                        {cell}
                      </td>
                    )
                  }
                  // Title cell: a Notion-style page icon on the left whose glyph
                  // reflects whether the record's linked note has body content.
                  const hasContent = !!doc.pageHasContent?.[row.id]
                  const PageGlyph = hasContent ? DocumentTextIcon : DocumentIcon
                  return (
                    <td
                      key={field.id}
                      data-active-cell={isActive}
                      onMouseDown={onCellMouseDown}
                      className={tdClassName}
                    >
                      <div className="flex items-start">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            openPage(row.id)
                          }}
                          title={hasContent ? 'Open page' : 'Open page (empty)'}
                          className={[
                            'flex shrink-0 items-center pl-2 pr-1 pt-2 transition-colors hover:text-accent',
                            hasContent ? 'text-ink-500' : 'text-ink-400'
                          ].join(' ')}
                        >
                          <PageGlyph className="h-4 w-4" />
                        </button>
                        <div className="min-w-0 flex-1">{cell}</div>
                      </div>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          openPage(row.id)
                        }}
                        title="Open page"
                        className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded-md border border-paper-300 bg-paper-100 px-2 py-1 text-2xs font-medium text-ink-600 opacity-0 shadow-sm transition hover:border-paper-400 hover:text-ink-900 group-hover/row:opacity-100"
                      >
                        <ArrowUpRightIcon className="h-3 w-3" /> Open
                      </button>
                    </td>
                  )
                })}
              </tr>
            )
          })}
          <tr>
            <td colSpan={columns.length + 1} className="px-2 py-1.5">
              <button
                type="button"
                onClick={() => updateDatabaseRows(csvPath, addRow(doc))}
                className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-ink-500 hover:bg-paper-200 hover:text-ink-900"
              >
                <PlusIcon className="h-3.5 w-3.5" /> New row
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      </div>

      {fieldMenu && (
        <ContextMenu
          x={fieldMenu.x}
          y={fieldMenu.y}
          items={fieldMenuItems(map.get(fieldMenu.fieldId)!)}
          onClose={() => setFieldMenu(null)}
        />
      )}

      {rowMenu && (
        <ContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          items={rowMenuItems(rowMenu.rowId)}
          onClose={() => setRowMenu(null)}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

function DbCheckbox({
  checked,
  onChange,
  title
}: {
  checked: boolean
  onChange: () => void
  title?: string
}): JSX.Element {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        onChange()
      }}
      className={[
        'flex h-4 w-4 items-center justify-center rounded border transition-colors',
        checked
          ? 'border-accent bg-accent text-white'
          : 'border-paper-400 text-transparent hover:border-ink-500'
      ].join(' ')}
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M5 12l5 5L20 7" />
      </svg>
    </button>
  )
}

interface CellProps {
  field: DbField
  value: string
  editing: boolean
  onStartEdit: () => void
  onEndEdit: () => void
  onCommit: (value: string) => void
}

function Cell({ field, value, editing, onStartEdit, onEndEdit, onCommit }: CellProps): JSX.Element {
  if (field.type === 'checkbox') {
    const checked = isCheckboxTrue(value)
    return (
      <button
        type="button"
        onClick={() => onCommit(checked ? 'false' : 'true')}
        className="flex h-full w-full items-center justify-center px-2 py-1.5"
        title={checked ? 'Checked' : 'Unchecked'}
      >
        <span
          className={[
            'flex h-4 w-4 items-center justify-center rounded border',
            checked ? 'border-accent bg-accent text-white' : 'border-paper-400 text-transparent'
          ].join(' ')}
        >
          ✓
        </span>
      </button>
    )
  }

  if (field.type === 'select' || field.type === 'multiSelect') {
    return (
      <SelectCell field={field} value={value} editing={editing} onStartEdit={onStartEdit} onEndEdit={onEndEdit} onCommit={onCommit} />
    )
  }

  if (editing) {
    return (
      <input
        autoFocus
        type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
        defaultValue={value}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => {
          onCommit(e.currentTarget.value)
          onEndEdit()
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter' && !isImeComposing(e)) e.currentTarget.blur()
          else if (e.key === 'Escape') onEndEdit()
        }}
        className="w-full bg-paper-50 px-2 py-1.5 text-sm text-ink-900 outline-none ring-1 ring-inset ring-accent"
      />
    )
  }

  return (
    <button
      type="button"
      onClick={onStartEdit}
      title={value || undefined}
      className="block h-full w-full px-2 py-1.5 text-left"
    >
      {/* min-h reserves one line so an empty cell keeps the same row height as a
          filled one (otherwise a new/blank row collapses shorter). (#185) */}
      <span className="block min-h-5 truncate text-ink-900">
        {field.type === 'date' ? formatDate(value) : value}
      </span>
    </button>
  )
}

const SELECT_PANEL_WIDTH = 224

function SelectCell({ field, value, editing, onStartEdit, onEndEdit, onCommit }: CellProps): JSX.Element {
  const multi = field.type === 'multiSelect'
  const selected = multi ? splitMultiSelect(value) : value ? [value] : []
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    setRect(editing && triggerRef.current ? triggerRef.current.getBoundingClientRect() : null)
  }, [editing])

  useEffect(() => {
    if (!editing) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t) || panelRef.current?.contains(t)) return
      onEndEdit()
    }
    window.addEventListener('mousedown', onDown, true)
    return () => window.removeEventListener('mousedown', onDown, true)
  }, [editing, onEndEdit])

  const toggle = (optValue: string): void => {
    if (multi) {
      const next = selected.includes(optValue)
        ? selected.filter((v) => v !== optValue)
        : [...selected, optValue]
      onCommit(next.join(', '))
    } else {
      onCommit(selected[0] === optValue ? '' : optValue)
      onEndEdit()
    }
  }

  const chips = (
    <div className="flex flex-wrap gap-1">
      {selected.length === 0 ? (
        <span className="text-ink-400">—</span>
      ) : (
        selected.map((v) => (
          <span
            key={v}
            className="rounded-full bg-accent/15 px-2 py-0.5 text-2xs font-medium text-accent ring-1 ring-accent/30"
          >
            {optionLabel(field, v)}
          </span>
        ))
      )}
    </div>
  )

  // Portal the option list to the body so the table's overflow doesn't clip it;
  // flip above the cell when there isn't room below.
  const placeAbove = !!rect && rect.bottom > window.innerHeight - 280
  const panelStyle: CSSProperties = rect
    ? {
        position: 'fixed',
        left: Math.max(8, Math.min(rect.left, window.innerWidth - SELECT_PANEL_WIDTH - 8)),
        width: Math.max(rect.width, SELECT_PANEL_WIDTH),
        ...(placeAbove ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 })
      }
    : {}

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={onStartEdit}
        className={[
          'block h-full w-full px-2 py-1.5 text-left',
          editing ? 'ring-1 ring-inset ring-accent' : ''
        ].join(' ')}
      >
        {chips}
      </button>
      {editing &&
        rect &&
        createPortal(
          <div
            ref={panelRef}
            style={panelStyle}
            className="z-popover overflow-hidden rounded-lg border border-paper-300 bg-paper-100 py-1 shadow-float"
          >
            <div className="max-h-60 overflow-y-auto">
              {(field.options ?? []).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => toggle(opt.value)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-paper-200"
                >
                  <span className="truncate text-ink-900">{opt.label ?? opt.value}</span>
                  {selected.includes(opt.value) && <span className="text-accent">✓</span>}
                </button>
              ))}
              {(field.options ?? []).length === 0 && (
                <div className="px-3 py-2 text-xs text-ink-500">No options yet — add one below.</div>
              )}
            </div>
            <div className="border-t border-paper-300/60 p-1.5">
              <input
                autoFocus
                value={draft}
                placeholder="Add option…"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter' && !isImeComposing(e) && draft.trim()) {
                    toggle(draft.trim().replace(/,/g, ' '))
                    setDraft('')
                  } else if (e.key === 'Escape') {
                    onEndEdit()
                  }
                }}
                className="w-full rounded border border-paper-300 bg-paper-50 px-2 py-1 text-sm text-ink-900 outline-none focus:border-accent"
              />
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
