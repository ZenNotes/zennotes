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
import type { DatabaseDoc, DbField, DbRow, DbView, FieldType, SelectOptionsSource } from '@shared/databases'
import { viewRows } from '@shared/database-transforms'
import { useStore } from '../store'
import {
  addRowInView,
  setCell,
  renameField,
  retypeField,
  deleteField,
  moveColumn,
  moveColumnToField,
  setColumnHidden,
  isLastVisibleColumn,
  setViewPicks,
  clearViewPicks,
  removeFromViewPicks,
  viewHasPicks,
  pickedRowCount,
  ensureSelectOption,
  setFieldOptionsSource,
  updateView,
  fieldsById,
  formatDate,
  optionLabel,
  splitMultiSelect,
  splitNoteLinks,
  joinNoteLinks,
  isCheckboxTrue
} from '../lib/database-cells'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { Button, IconButton } from './ui/Button'
import { DatabasePicksStrip } from './DatabasePicksStrip'
import { MoreIcon, TrashIcon, PlusIcon, DocumentIcon, DocumentTextIcon, ArrowUpRightIcon } from './icons'
import { focusEditorNormalMode } from '../lib/editor-focus'
import { isImeComposing } from '../lib/ime'
import { isPaletteNextKey, isPalettePreviousKey } from '../lib/palette-nav'
import { isOverlayOrDialogOpen } from '../lib/overlay-open'
import { databaseGridKeyAction } from '../lib/database-grid-keys'
import { useDatabaseViewCommand } from '../lib/database-view-commands'
import { useToastStore } from '../lib/toast'
import { resolveWikilinkTarget } from '../lib/wikilinks'
import { followLinkTarget } from '../lib/follow-link'
import { NoteSuggestRows, stepSuggestIndex, useNoteSuggestions } from './DatabaseNoteSuggest'
import { PromptModal } from './PromptModal'

const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: 'Text',
  number: 'Number',
  checkbox: 'Checkbox',
  date: 'Date',
  select: 'Select',
  multiSelect: 'Multi-select',
  note: 'Note link',
  noteMulti: 'Note links'
}

interface Props {
  csvPath: string
  doc: DatabaseDoc
  view: DbView
  /** True when this grid is the active pane's content — drives auto-focus. */
  isActive: boolean
  /** Open the header's Columns popover for this view. */
  onOpenColumns?: () => void
}

export function DatabaseTableView({ csvPath, doc, view, isActive, onOpenColumns }: Props): JSX.Element {
  const updateDatabaseRows = useStore((s) => s.updateDatabaseRows)
  const updateDatabaseSchema = useStore((s) => s.updateDatabaseSchema)
  const deleteDatabaseRows = useStore((s) => s.deleteDatabaseRows)
  const openRecordPage = useStore((s) => s.openRecordPage)
  const renameRecordPage = useStore((s) => s.renameRecordPage)
  const focusedPanel = useStore((s) => s.focusedPanel)
  const setFocusedPanel = useStore((s) => s.setFocusedPanel)
  const vimMode = useStore((s) => s.vimMode)

  const titleFieldId = doc.fields.find((f) => f.id !== doc.idFieldId)?.id

  const [editing, setEditing] = useState<{ rowId: string; fieldId: string } | null>(null)
  const [renamingField, setRenamingField] = useState<string | null>(null)
  const [fieldMenu, setFieldMenu] = useState<{ fieldId: string; x: number; y: number } | null>(null)
  const [rowMenu, setRowMenu] = useState<{ rowId: string; x: number; y: number } | null>(null)
  // Folder / tag prompt for a select field's options source (#500). Suggestions
  // read the note list at open time via getState — no store subscription, so
  // the grid doesn't re-render on every vault change.
  const [sourcePrompt, setSourcePrompt] = useState<{
    fieldId: string
    kind: 'folder' | 'tag'
  } | null>(null)
  const sourcePromptSuggestions = useMemo(() => {
    if (!sourcePrompt) return []
    const notes = useStore.getState().notes
    if (sourcePrompt.kind === 'folder') {
      const dirs = new Set(
        notes.map((n) => n.path.split('/').slice(0, -1).join('/')).filter(Boolean)
      )
      return [...dirs].sort().map((value) => ({ value }))
    }
    const tags = new Set(notes.flatMap((n) => n.tags.map((t) => t.toLowerCase())))
    return [...tags].sort().map((value) => ({ value }))
  }, [sourcePrompt])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // Edit picks: every row shows, the picked ones selected, and the selection
  // bar offers Update picks or Cancel instead of its usual actions.
  const [editingPicks, setEditingPicks] = useState(false)
  const hasPicks = viewHasPicks(view)
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

  // While editing picks the view shows every row (no picks, no filters) in
  // its sort order, so any record can be picked or unpicked.
  const rows = useMemo(
    () => viewRows(doc.rows, editingPicks ? { sorts: view.sorts, filters: [] } : view, map),
    [doc.rows, view, map, editingPicks]
  )

  // Another view is another set of picks and columns: leave edit mode and
  // the selection behind when the tab switches, and leave edit mode when the
  // picks go away from under it (Show All Rows from the palette).
  useEffect(() => {
    setEditingPicks(false)
    setSelected(new Set())
  }, [view.id])
  useEffect(() => {
    if (editingPicks && !hasPicks) setEditingPicks(false)
  }, [editingPicks, hasPicks])
  // A row added while editing (the header's + Row included) joins the picks;
  // check it here too, or Update picks would drop it again.
  const picksAtEditStart = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!editingPicks) return
    const fresh = (view.pickedRowIds ?? []).filter((id) => !picksAtEditStart.current.has(id))
    if (fresh.length === 0) return
    for (const id of fresh) picksAtEditStart.current.add(id)
    setSelected((prev) => new Set([...prev, ...fresh]))
  }, [editingPicks, view.pickedRowIds])

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

  // --- picked rows ---------------------------------------------------------
  /** Make the selected rows this view's picks (or update them while editing). */
  const pickSelected = (): void => {
    if (selected.size === 0) return
    updateDatabaseSchema(csvPath, setViewPicks(doc, view.id, selected))
    setSelected(new Set())
    setEditingPicks(false)
  }
  const startEditPicks = (): void => {
    const live = new Set(doc.rows.map((r) => r.id))
    picksAtEditStart.current = new Set(view.pickedRowIds ?? [])
    setSelected(new Set((view.pickedRowIds ?? []).filter((id) => live.has(id))))
    setEditingPicks(true)
  }
  const cancelEditPicks = (): void => {
    setSelected(new Set())
    setEditingPicks(false)
  }
  const showAllRows = (): void => {
    updateDatabaseSchema(csvPath, clearViewPicks(doc, view.id))
    cancelEditPicks()
  }
  // Show Only Selected Rows from the palette (or a key bound to it).
  useDatabaseViewCommand(csvPath, isActive, (command) => {
    if (command !== 'pick-selected') return
    if (selected.size === 0) {
      // Name x only where Vim mode is on, as every key hint does.
      const how = useStore.getState().vimMode
        ? 'Space or x in the grid, or the row checkboxes'
        : 'the row checkboxes, or Space in the grid'
      useToastStore.getState().addToast(`Select rows first: ${how}.`, 'info')
      return
    }
    pickSelected()
  })

  /** Add a row; in a picks view it joins the picks so it does not vanish the
   *  moment it is made. */
  const addRowHere = (): void => {
    const added = addRowInView(doc, view.id)
    if (added.picksChanged) updateDatabaseSchema(csvPath, added.doc)
    else updateDatabaseRows(csvPath, added.doc)
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
  // Claims ONLY while the store says the content region owns the keyboard:
  // when another panel holds it (tab strip via Ctrl+K, or the sidebar via
  // Focus Sidebar / the boot default), stealing focus here re-routed every
  // key to the grid while the sidebar painted its vim cursor and `m` hint,
  // and the hinted key opened nothing. A null focusedPanel still claims: the
  // boot fallback only assigns 'sidebar' when the sidebar is open, so a
  // workspace restore with the sidebar hidden leaves it null, and bailing
  // there left the restored grid deaf until a mouse click. Also bails while
  // an interactive control (a cell editor, a header button) owns focus, so
  // it never yanks the caret out from under the user. rAF lets the opening
  // click / restore settle so it can't steal focus back.
  useEffect(() => {
    if (!isActive || (focusedPanel !== 'editor' && focusedPanel !== null)) return
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
    // Which keys answer in which mode lives in databaseGridKeyAction: with
    // Vim mode off only the arrows, Enter, Space, Escape and the menu keys.
    const action = databaseGridKeyAction(e, useStore.getState().vimMode)
    // Reset pending multi-key sequences when a different key arrives.
    if (gPending.current && action !== 'g') gPending.current = false
    if (dPending.current && action !== 'd') dPending.current = false
    if (!action) return
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

    switch (action) {
      case 'down':
        return move(active.row + 1, active.col)
      case 'up':
        return move(active.row - 1, active.col)
      case 'left':
        return move(active.row, active.col - 1)
      case 'right':
        return move(active.row, active.col + 1)
      case 'move-column-left': {
        // #317: move the current column one step left, keeping the cursor on it.
        e.preventDefault()
        const field = columns[active.col]
        if (field && active.col > 0) {
          updateDatabaseSchema(csvPath, moveColumn(doc, view.id, field.id, 'left'))
          setActive({ row: active.row, col: active.col - 1 })
        }
        return
      }
      case 'move-column-right': {
        // #317: move the current column one step right, keeping the cursor on it.
        e.preventDefault()
        const field = columns[active.col]
        if (field && active.col < lastCol) {
          updateDatabaseSchema(csvPath, moveColumn(doc, view.id, field.id, 'right'))
          setActive({ row: active.row, col: active.col + 1 })
        }
        return
      }
      case 'first-column':
        return move(active.row, 0)
      case 'last-column':
        return move(active.row, lastCol)
      case 'last-row':
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
      case 'edit': {
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
      case 'space': {
        const c = cell()
        if (!c) return
        e.preventDefault()
        if (c.field.type === 'checkbox') return toggleCheckbox(c.row, c.field)
        return toggleRow(c.row.id)
      }
      case 'select': {
        const c = cell()
        if (!c) return
        e.preventDefault()
        return toggleRow(c.row.id)
      }
      case 'open-page': {
        const c = cell()
        if (!c) return
        e.preventDefault()
        return openPage(c.row.id)
      }
      case 'columns': {
        // The Columns popover, to pick the few columns this view shows (the
        // header's Columns button and the palette's Choose Database Columns
        // do it with Vim off). Never behind a menu or a dialog.
        if (isOverlayOrDialogOpen()) return
        e.preventDefault()
        onOpenColumns?.()
        return
      }
      case 'create-pages': {
        // Every record's page at once (o opens one).
        e.preventDefault()
        void useStore.getState().createAllRecordPages(csvPath)
        return
      }
      case 'menu': {
        // Open the context menu (m with Vim on, like the sidebar's; Shift+F10
        // or the Context Menu key in either mode), anchored to the active
        // header or cell. On a header → field menu; on a cell → row menu.
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
      case 'add-row': {
        e.preventDefault()
        addRowHere()
        setActive((s) => ({ row: rows.length, col: s.col }))
        return
      }
      case 'escape':
        e.preventDefault()
        if (editingPicks) {
          cancelEditPicks()
          return
        }
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
    const pickItems: ContextMenuItem[] = []
    if (!editingPicks && selected.size > 0) {
      pickItems.push({ label: 'Show only selected rows', onSelect: pickSelected })
    }
    if (!editingPicks && hasPicks) {
      pickItems.push({
        label: "Remove from this view's picks",
        onSelect: () => {
          const ids = multi ? [...selected] : [rowId]
          updateDatabaseSchema(csvPath, removeFromViewPicks(doc, view.id, ids))
          if (multi) setSelected(new Set())
        }
      })
    }
    return [
      { label: 'Open page', onSelect: () => openPage(rowId) },
      ...(pickItems.length > 0 ? ([{ kind: 'separator' }, ...pickItems] as ContextMenuItem[]) : []),
      { kind: 'separator' },
      {
        label: multi ? `Delete ${selected.size} rows` : 'Delete row',
        danger: true,
        onSelect: () =>
          multi ? deleteSelected() : void deleteDatabaseRows(csvPath, [rowId])
      }
    ]
  }

  // Key hints name the grid's letters only where they work: in Vim mode.
  const fieldMenuItems = (field: DbField): ContextMenuItem[] => [
    { label: 'Sort ascending', onSelect: () => updateDatabaseSchema(csvPath, updateView(doc, view.id, { sorts: [{ fieldId: field.id, direction: 'asc' }] })) },
    { label: 'Sort descending', onSelect: () => updateDatabaseSchema(csvPath, updateView(doc, view.id, { sorts: [{ fieldId: field.id, direction: 'desc' }] })) },
    { label: 'Clear sort', disabled: view.sorts.length === 0, onSelect: () => updateDatabaseSchema(csvPath, updateView(doc, view.id, { sorts: [] })) },
    { kind: 'separator' },
    {
      label: 'Move left',
      hint: vimMode ? 'H' : undefined,
      disabled: columns[0]?.id === field.id,
      onSelect: () => updateDatabaseSchema(csvPath, moveColumn(doc, view.id, field.id, 'left'))
    },
    {
      label: 'Move right',
      hint: vimMode ? 'L' : undefined,
      disabled: columns[columns.length - 1]?.id === field.id,
      onSelect: () => updateDatabaseSchema(csvPath, moveColumn(doc, view.id, field.id, 'right'))
    },
    {
      // In this view only: another saved view keeps its own columns.
      label: 'Hide column',
      disabled: isLastVisibleColumn(doc, view, field.id),
      onSelect: () => updateDatabaseSchema(csvPath, setColumnHidden(doc, view.id, field.id, true))
    },
    {
      label: 'Choose columns…',
      hint: vimMode ? 'c' : undefined,
      disabled: !onOpenColumns,
      onSelect: () => onOpenColumns?.()
    },
    { kind: 'separator' },
    { label: 'Rename field', onSelect: () => setRenamingField(field.id) },
    ...(Object.keys(FIELD_TYPE_LABELS) as FieldType[]).map((t) => ({
      label: `Type: ${FIELD_TYPE_LABELS[t]}`,
      hint: field.type === t ? '●' : undefined,
      onSelect: () => updateDatabaseSchema(csvPath, retypeField(doc, field.id, t))
    })),
    // Where a select field's popover discovers options beyond the hand-added
    // list: nowhere (manual), every note, a folder, or a tag. (#500)
    ...(field.type === 'select' || field.type === 'multiSelect'
      ? ([
          { kind: 'separator' },
          {
            label: 'Options: manual only',
            hint: !field.optionsSource ? '●' : undefined,
            onSelect: () =>
              updateDatabaseSchema(csvPath, setFieldOptionsSource(doc, field.id, null))
          },
          {
            label: 'Options: all notes',
            hint: field.optionsSource?.kind === 'notes' ? '●' : undefined,
            onSelect: () =>
              updateDatabaseSchema(
                csvPath,
                setFieldOptionsSource(doc, field.id, { kind: 'notes' })
              )
          },
          {
            label: 'Options: notes in folder…',
            hint: field.optionsSource?.kind === 'folder' ? '●' : undefined,
            onSelect: () => setSourcePrompt({ fieldId: field.id, kind: 'folder' })
          },
          {
            label: 'Options: notes with tag…',
            hint: field.optionsSource?.kind === 'tag' ? '●' : undefined,
            onSelect: () => setSourcePrompt({ fieldId: field.id, kind: 'tag' })
          }
        ] as ContextMenuItem[])
      : []),
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
      {hasPicks && !editingPicks && (
        <DatabasePicksStrip
          count={pickedRowCount(doc, view)}
          onEdit={startEditPicks}
          onShowAll={showAllRows}
        />
      )}
      {editingPicks ? (
        <div
          data-db-selection-bar
          className="flex shrink-0 items-center gap-1 border-b border-paper-300/70 bg-accent/5 px-3 py-1 text-xs"
        >
          <span className="mr-2 font-medium text-ink-700">
            Editing picks: {selected.size} selected
          </span>
          <Button
            variant="primary"
            size="sm"
            disabled={selected.size === 0}
            title={selected.size === 0 ? 'Select at least one row, or use Show all rows' : undefined}
            onClick={pickSelected}
          >
            Update picks
          </Button>
          <Button variant="ghost" size="sm" onClick={cancelEditPicks}>
            Cancel
          </Button>
        </div>
      ) : anySelected && (
        <div
          data-db-selection-bar
          className="flex shrink-0 items-center gap-3 border-b border-paper-300/70 bg-paper-100 px-3 py-1.5 text-xs"
        >
          <span className="font-medium text-ink-700">{selected.size} selected</span>
          <Button variant="ghost" size="sm" onClick={pickSelected}>
            Show only these in this view
          </Button>
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
                onClick={addRowHere}
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

      {sourcePrompt && (
        <PromptModal
          options={{
            title:
              sourcePrompt.kind === 'folder' ? 'Options from folder' : 'Options from tag',
            description:
              sourcePrompt.kind === 'folder'
                ? 'The select popover will suggest notes inside this folder as options.'
                : 'The select popover will suggest notes carrying this tag as options.',
            placeholder: sourcePrompt.kind === 'folder' ? 'inbox/projects' : 'project',
            suggestions: sourcePromptSuggestions,
            autoHighlightFirst: true
          }}
          onSubmit={(value) => {
            const v = value.trim().replace(/^#/, '').replace(/\/+$/, '')
            if (v) {
              updateDatabaseSchema(
                csvPath,
                setFieldOptionsSource(
                  doc,
                  sourcePrompt.fieldId,
                  sourcePrompt.kind === 'folder'
                    ? { kind: 'folder', path: v }
                    : { kind: 'tag', tag: v }
                )
              )
            }
            setSourcePrompt(null)
          }}
          onCancel={() => setSourcePrompt(null)}
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

  if (field.type === 'note' || field.type === 'noteMulti') {
    return (
      <NoteCell field={field} value={value} editing={editing} onStartEdit={onStartEdit} onEndEdit={onEndEdit} onCommit={onCommit} />
    )
  }

  if (editing) {
    if (field.type === 'text') {
      return <TextCellInput value={value} onCommit={onCommit} onEndEdit={onEndEdit} />
    }
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

// Portal panels to the body so the table's overflow doesn't clip them; flip
// above the cell when there isn't room below.
function cellPanelStyle(rect: DOMRect | null): CSSProperties {
  if (!rect) return {}
  const placeAbove = rect.bottom > window.innerHeight - 280
  return {
    position: 'fixed',
    left: Math.max(8, Math.min(rect.left, window.innerWidth - SELECT_PANEL_WIDTH - 8)),
    width: Math.max(rect.width, SELECT_PANEL_WIDTH),
    ...(placeAbove ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 })
  }
}

function SelectCell({ field, value, editing, onStartEdit, onEndEdit, onCommit }: CellProps): JSX.Element {
  const multi = field.type === 'multiSelect'
  const selected = multi ? splitMultiSelect(value) : value ? [value] : []
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const [draft, setDraft] = useState('')
  // -1 = the typed draft is selected (Enter adds it as an option, as always);
  // 0..n highlights a row. Same semantic as PromptModal's suggestions.
  const [activeIdx, setActiveIdx] = useState(-1)

  useEffect(() => {
    setRect(editing && triggerRef.current ? triggerRef.current.getBoundingClientRect() : null)
    if (!editing) setDraft('')
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

  // The draft doubles as a filter over existing options, and — when the field
  // has an options source — as the query for live note discovery (#500). A
  // picked note commits its title through the normal option-minting path, so
  // boards, filters, and older builds keep seeing ordinary select values.
  const q = draft.trim().toLowerCase()
  const options = (field.options ?? []).filter(
    (opt) =>
      !q ||
      opt.value.toLowerCase().includes(q) ||
      (opt.label ?? '').toLowerCase().includes(q)
  )
  const noteSuggestions = useNoteSuggestions(draft, {
    enabled: editing && !!field.optionsSource,
    source: field.optionsSource,
    limit: 6
  }).filter((c) => !(field.options ?? []).some((o) => o.value === c.label))
  const rowCount = options.length + noteSuggestions.length
  useEffect(() => {
    setActiveIdx(-1)
  }, [draft, editing])

  const pickRow = (idx: number): void => {
    if (idx < 0) return
    if (idx < options.length) return toggle(options[idx].value)
    const candidate = noteSuggestions[idx - options.length]
    if (candidate) toggle(candidate.label)
  }

  // Keep the active row visible as arrows move it (rows live in two groups).
  useEffect(() => {
    panelRef.current
      ?.querySelector<HTMLElement>(`[data-db-suggest-idx="${activeIdx}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx])

  const chips = (
    <div className="flex flex-wrap gap-1">
      {selected.length === 0 ? (
        <span className="text-ink-400">None</span>
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
            style={cellPanelStyle(rect)}
            className="z-popover overflow-hidden rounded-lg border border-paper-300 bg-paper-100 py-1 shadow-float"
          >
            <div className="max-h-60 overflow-y-auto">
              {options.map((opt, i) => (
                <button
                  key={opt.id}
                  type="button"
                  data-db-suggest-idx={i}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => toggle(opt.value)}
                  className={[
                    'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm',
                    i === activeIdx ? 'bg-paper-200 text-ink-900' : 'hover:bg-paper-200'
                  ].join(' ')}
                >
                  <span className="truncate text-ink-900">{opt.label ?? opt.value}</span>
                  {selected.includes(opt.value) && <span className="text-accent">✓</span>}
                </button>
              ))}
              {noteSuggestions.length > 0 && (
                <div className="mt-1 border-t border-paper-300/60 pt-1">
                  <div className="px-3 py-0.5 text-2xs font-medium uppercase tracking-wide text-ink-400">
                    Notes
                  </div>
                  <NoteSuggestRows
                    items={noteSuggestions}
                    activeIndex={activeIdx}
                    indexOffset={options.length}
                    onPick={(c) => toggle(c.label)}
                    checkedValues={new Set(selected)}
                  />
                </div>
              )}
              {rowCount === 0 && (
                <div className="px-3 py-2 text-xs text-ink-500">
                  {field.optionsSource
                    ? draft
                      ? 'No matches. Enter adds it as an option.'
                      : 'Type to search notes or add an option.'
                    : 'No options yet. Add one below.'}
                </div>
              )}
            </div>
            <div className="border-t border-paper-300/60 p-1.5">
              <input
                autoFocus
                value={draft}
                placeholder={field.optionsSource ? 'Search notes or add option…' : 'Add option…'}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (isPaletteNextKey(e)) {
                    e.preventDefault()
                    return setActiveIdx((i) => stepSuggestIndex(i, 1, rowCount))
                  }
                  if (isPalettePreviousKey(e)) {
                    e.preventDefault()
                    return setActiveIdx((i) => stepSuggestIndex(i, -1, rowCount))
                  }
                  if (e.key === 'Enter' && !isImeComposing(e)) {
                    e.preventDefault()
                    if (activeIdx >= 0) {
                      pickRow(activeIdx)
                      setDraft('')
                      return
                    }
                    if (draft.trim()) {
                      toggle(draft.trim().replace(/,/g, ' '))
                      setDraft('')
                    }
                    return
                  }
                  if (e.key === 'Escape') onEndEdit()
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

/**
 * Text cell editor with `[[` note discovery (#500): an unclosed `[[query`
 * before the caret opens the same ranked note list as the editor's wikilink
 * completion, Enter inserts `[[target]]`, and typing continues. Without an
 * open `[[`, commit semantics are the classic ones (Enter/blur commit,
 * Escape cancels).
 */
/** The unclosed `[[query` immediately before position `caret`, if any. */
function wikiOpenAt(text: string, caret: number): { open: number; query: string } | null {
  const before = text.slice(0, caret)
  const open = before.lastIndexOf('[[')
  if (open < 0) return null
  const inside = before.slice(open + 2)
  if (inside.includes(']]') || inside.includes('|') || inside.includes('#')) return null
  return { open, query: inside }
}

function TextCellInput({
  value,
  onCommit,
  onEndEdit
}: {
  value: string
  onCommit: (value: string) => void
  onEndEdit: () => void
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [text, setText] = useState(value)
  // Caret state only drives the suggestion list; every INSERTION reads the
  // live DOM value + selection at event time instead, because select events
  // sync this state asynchronously and a stale caret once re-matched the
  // just-inserted link and mangled the cell.
  const [caret, setCaret] = useState(value.length)
  const [dismissed, setDismissed] = useState(false)
  const [activeIdx, setActiveIdx] = useState(0)
  const pendingCaret = useRef<number | null>(null)
  const selectedOnMount = useRef(false)

  const wiki = useMemo(() => wikiOpenAt(text, caret), [text, caret])

  const suggestions = useNoteSuggestions(wiki?.query ?? '', {
    enabled: !!wiki && !dismissed,
    limit: 8
  })
  const showList = !!wiki && !dismissed && suggestions.length > 0

  useEffect(() => {
    setActiveIdx(0)
  }, [wiki?.query])
  // Escape dismisses the list for THIS `[[`; a fresh `[[` re-opens it.
  useEffect(() => {
    setDismissed(false)
  }, [wiki?.open])

  useEffect(() => {
    if (pendingCaret.current == null) return
    const el = inputRef.current
    if (el) {
      el.focus()
      el.setSelectionRange(pendingCaret.current, pendingCaret.current)
    }
    pendingCaret.current = null
  }, [text])

  /** Insert `[[target]]` over the live `[[query`; false when none is open. */
  const pick = (candidate: { target: string }, el: HTMLInputElement): boolean => {
    const liveText = el.value
    const liveCaret = el.selectionStart ?? liveText.length
    const live = wikiOpenAt(liveText, liveCaret)
    if (!live) return false
    const after = liveText.slice(liveCaret)
    const rest = after.startsWith(']]') ? after.slice(2) : after
    const inserted = `[[${candidate.target}]]`
    const nextCaret = live.open + inserted.length
    pendingCaret.current = nextCaret
    setText(`${liveText.slice(0, live.open)}${inserted}${rest}`)
    setCaret(nextCaret)
    return true
  }

  const syncCaret = (el: HTMLInputElement): void =>
    setCaret(el.selectionStart ?? el.value.length)

  return (
    <>
      <input
        ref={inputRef}
        autoFocus
        type="text"
        value={text}
        onFocus={(e) => {
          // Select-all on the opening focus only; a refocus after a pick must
          // keep the caret where the insertion put it.
          if (!selectedOnMount.current) {
            selectedOnMount.current = true
            e.currentTarget.select()
          }
        }}
        onChange={(e) => {
          setText(e.currentTarget.value)
          syncCaret(e.currentTarget)
        }}
        onSelect={(e) => syncCaret(e.currentTarget)}
        onBlur={() => {
          onCommit(text)
          onEndEdit()
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (showList) {
            if (isPaletteNextKey(e)) {
              e.preventDefault()
              return setActiveIdx((i) => Math.min(i + 1, suggestions.length - 1))
            }
            if (isPalettePreviousKey(e)) {
              e.preventDefault()
              return setActiveIdx((i) => Math.max(i - 1, 0))
            }
            if (e.key === 'Enter' && !isImeComposing(e)) {
              const candidate = suggestions[activeIdx] ?? suggestions[0]
              if (candidate && pick(candidate, e.currentTarget)) {
                e.preventDefault()
                return
              }
              // No live [[ at the caret (stale list): fall through to commit.
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              return setDismissed(true)
            }
          }
          if (e.key === 'Enter' && !isImeComposing(e)) e.currentTarget.blur()
          else if (e.key === 'Escape') onEndEdit()
        }}
        className="w-full bg-paper-50 px-2 py-1.5 text-sm text-ink-900 outline-none ring-1 ring-inset ring-accent"
      />
      {showList &&
        inputRef.current &&
        createPortal(
          <div
            style={cellPanelStyle(inputRef.current.getBoundingClientRect())}
            className="z-popover overflow-hidden rounded-lg border border-paper-300 bg-paper-100 py-1 shadow-float"
          >
            <div className="max-h-60 overflow-y-auto">
              <NoteSuggestRows
                items={suggestions}
                activeIndex={activeIdx}
                onPick={(c) => {
                  if (inputRef.current) pick(c, inputRef.current)
                }}
              />
            </div>
          </div>,
          document.body
        )}
    </>
  )
}

/**
 * Cell editor for `note` / `noteMulti` fields (#500). The cell stores
 * `[[wikilink]]` targets; editing opens a searchable note picker, display
 * chips show resolved titles and follow their link on click (the empty cell
 * area starts the edit). Unresolvable targets render muted, not broken.
 */
function NoteCell({ field, value, editing, onStartEdit, onEndEdit, onCommit }: CellProps): JSX.Element {
  const multi = field.type === 'noteMulti'
  const targets = splitNoteLinks(value)
  const notes = useStore((s) => s.notes)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)

  const suggestions = useNoteSuggestions(query, { enabled: editing, limit: 8 })

  useEffect(() => {
    setRect(editing && triggerRef.current ? triggerRef.current.getBoundingClientRect() : null)
    if (!editing) setQuery('')
  }, [editing])

  useEffect(() => {
    setActiveIdx(0)
  }, [query, editing])

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

  const pick = (candidate: { target: string }): void => {
    const target = candidate.target
    if (multi) {
      const next = targets.includes(target)
        ? targets.filter((t) => t !== target)
        : [...targets, target]
      onCommit(joinNoteLinks(next))
    } else {
      onCommit(targets[0] === target ? '' : joinNoteLinks([target]))
      onEndEdit()
    }
  }

  const chips = (
    <div className="flex flex-wrap gap-1">
      {targets.length === 0 ? (
        <span className="text-ink-400">None</span>
      ) : (
        targets.map((target) => {
          const note = resolveWikilinkTarget(notes, target)
          return (
            <span
              key={target}
              role="link"
              title={note ? `Open ${note.title}` : `No note matches "${target}"`}
              onClick={(e) => {
                e.stopPropagation()
                followLinkTarget(target, { kind: 'wikilink' })
              }}
              className={[
                'cursor-pointer rounded-full px-2 py-0.5 text-2xs font-medium ring-1',
                note
                  ? 'bg-accent/15 text-accent ring-accent/30 hover:bg-accent/25'
                  : 'bg-paper-200/70 text-ink-400 ring-paper-300'
              ].join(' ')}
            >
              {note?.title ?? target}
            </span>
          )
        })
      )}
    </div>
  )

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
            style={cellPanelStyle(rect)}
            className="z-popover overflow-hidden rounded-lg border border-paper-300 bg-paper-100 py-1 shadow-float"
          >
            <div className="border-b border-paper-300/60 p-1.5">
              <input
                autoFocus
                value={query}
                placeholder={multi ? 'Link notes…' : 'Link a note…'}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (isPaletteNextKey(e)) {
                    e.preventDefault()
                    return setActiveIdx((i) => Math.min(i + 1, suggestions.length - 1))
                  }
                  if (isPalettePreviousKey(e)) {
                    e.preventDefault()
                    return setActiveIdx((i) => Math.max(i - 1, 0))
                  }
                  if (e.key === 'Enter' && !isImeComposing(e)) {
                    e.preventDefault()
                    const candidate = suggestions[activeIdx] ?? suggestions[0]
                    if (candidate) pick(candidate)
                    return
                  }
                  if (e.key === 'Escape') onEndEdit()
                }}
                className="w-full rounded border border-paper-300 bg-paper-50 px-2 py-1 text-sm text-ink-900 outline-none focus:border-accent"
              />
            </div>
            <div className="max-h-60 overflow-y-auto">
              <NoteSuggestRows
                items={suggestions}
                activeIndex={activeIdx}
                onPick={pick}
                checkedValues={new Set(targets)}
              />
              {suggestions.length === 0 && (
                <div className="px-3 py-2 text-xs text-ink-500">No matching notes.</div>
              )}
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
