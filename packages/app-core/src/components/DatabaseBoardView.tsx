import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { DatabaseDoc, DbField, DbView } from '@shared/databases'
import { EMPTY_GROUP } from '@shared/databases'
import { boardColumns, viewRows } from '@shared/database-transforms'
import { useStore } from '../store'
import {
  setCell,
  ensureSelectOption,
  setSelectOptionColor,
  updateView,
  clearViewPicks,
  pickedRowCount,
  viewHasPicks,
  fieldsById,
  formatDate,
  optionLabel,
  splitMultiSelect,
  splitNoteLinks,
  noteLinkTitle,
  isCheckboxTrue
} from '../lib/database-cells'
import {
  addBoardCard,
  databaseBoardKeyAction,
  resolveBoardCursor,
  stepBoardCursor,
  visibleBoardColumns,
  type BoardCursor
} from '../lib/database-board'
import { useDatabaseViewCommand } from '../lib/database-view-commands'
import { isImeComposing } from '../lib/ime'
import { useKeyboardCursor } from '../lib/keyboard-cursor'
import {
  kanbanColumnColorCss,
  kanbanColumnColorLabel,
  kanbanColumnColorVar,
  selectOptionChipStyle,
  selectOptionColor
} from '../lib/kanban-column-colors'
import { PlusIcon, ArrowUpRightIcon } from './icons'
import { IconButton } from './ui/Button'
import { columnColorMenuItems } from './ColumnColorMenu'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { DatabasePicksStrip } from './DatabasePicksStrip'

interface Props {
  csvPath: string
  doc: DatabaseDoc
  view: DbView
  isActive?: boolean
}

/**
 * Board view: columns are the options of a `select` group-by field (+ a
 * "No status" column while a card has none). Dragging a card to a column
 * sets that field on the row. Uses native HTML5 drag-and-drop. The board
 * also runs its own keyboard (lib/database-board.ts), so a Kanban made with
 * New Kanban (#1038) is as keyboard-driven as the Table.
 */
export function DatabaseBoardView({ csvPath, doc, view, isActive = true }: Props): JSX.Element {
  const updateDatabaseRows = useStore((s) => s.updateDatabaseRows)
  const updateDatabaseSchema = useStore((s) => s.updateDatabaseSchema)
  const deleteDatabaseRows = useStore((s) => s.deleteDatabaseRows)
  const openRecordPage = useStore((s) => s.openRecordPage)
  const setFocusedPanel = useStore((s) => s.setFocusedPanel)
  const focusedPanel = useStore((s) => s.focusedPanel)
  const vimMode = useStore((s) => s.vimMode)

  const selectFields = doc.fields.filter((f) => f.type === 'select')
  const groupField =
    doc.fields.find((f) => f.id === view.groupByFieldId && f.type === 'select') ?? selectFields[0]

  const map = useMemo(() => fieldsById(doc), [doc])
  // The same pipeline as the Table (picks, then filters, then sorts), so a
  // view shows the same records on either surface.
  const visibleRows = useMemo(
    () => viewRows(doc.rows, view, map),
    [doc.rows, view, map]
  )

  const titleField = doc.fields.find((f) => f.id !== doc.idFieldId)
  const cardFields = (view.cardFieldIds ?? doc.fields.map((f) => f.id))
    .map((id) => map.get(id))
    .filter((f): f is DbField => !!f && !f.hidden && f.id !== doc.idFieldId && f.id !== titleField?.id && f.id !== groupField?.id)

  const boardRef = useRef<HTMLDivElement | null>(null)
  const cursorRing = useKeyboardCursor() ? 'group-focus/board:ring-1 group-focus/board:ring-accent/60' : ''
  const [dragRow, setDragRow] = useState<string | null>(null)
  const [overCol, setOverCol] = useState<string | null>(null)
  const [addingOption, setAddingOption] = useState(false)
  const [optionDraft, setOptionDraft] = useState('')
  const [cursor, setCursor] = useState<BoardCursor | null>(null)
  // The column whose Add card field is open, and what is typed in it.
  const [addingCardIn, setAddingCardIn] = useState<string | null>(null)
  const [cardDraft, setCardDraft] = useState('')
  // Which column's field is open, read by its blur: Escape closes the field
  // before the unmount's blur can land, so that blur never adds the card.
  const addCardOpen = useRef<string | null>(null)
  const [cardMenu, setCardMenu] = useState<{ x: number; y: number; rowId: string } | null>(null)
  // A column's header menu, or its colors, once one is open.
  const [columnMenu, setColumnMenu] = useState<{
    x: number
    y: number
    columnKey: string
    picking: boolean
  } | null>(null)
  // Set below, once the columns are known: the palette command's handler has
  // to be registered ahead of the board's early return.
  const colorCursorColumn = useRef<() => void>(() => undefined)

  useDatabaseViewCommand(csvPath, isActive, (command) => {
    if (command === 'column-color') colorCursorColumn.current()
  })

  // The board takes the keyboard whenever its pane's content does, as the
  // Table grid does (DatabaseTableView's claimFocus, which explains the
  // cases): never while another panel owns the keys or a control inside the
  // view has focus.
  useEffect(() => {
    if (!isActive || (focusedPanel !== 'editor' && focusedPanel !== null)) return
    const claimFocus = (): void => {
      const a = document.activeElement as HTMLElement | null
      if (a && a !== document.body && a.closest('input, textarea, select, button, [contenteditable="true"]'))
        return
      boardRef.current?.focus({ preventScroll: true })
    }
    const raf = requestAnimationFrame(claimFocus)
    window.addEventListener('focus', claimFocus)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('focus', claimFocus)
    }
  }, [isActive, csvPath, focusedPanel, view.id])

  if (!groupField) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-ink-500">
        <p>Group the board by a Select field.</p>
        <p className="text-xs text-ink-500">Add a Select field in the Table view, then come back.</p>
      </div>
    )
  }

  const optionOrder = view.boardColumnOrder ?? groupField.options?.map((o) => o.value) ?? []
  const columns = visibleBoardColumns(boardColumns(visibleRows, groupField, optionOrder))
  const at = resolveBoardCursor(columns, cursor)
  const focusedRowId = at.column >= 0 ? (columns[at.column].rows[at.card]?.id ?? null) : null

  // Rapid keys can land before the store's optimistic write re-renders this
  // view, so writes start from the store's doc rather than the prop.
  const latestDoc = (): DatabaseDoc => useStore.getState().databases[csvPath] ?? doc

  const moveTo = (rowId: string, columnKey: string): void => {
    const value = columnKey === EMPTY_GROUP ? '' : columnKey
    updateDatabaseRows(csvPath, setCell(latestDoc(), rowId, groupField.id, value))
  }

  const columnLabel = (key: string): string =>
    key === EMPTY_GROUP ? 'No ' + groupField.name.toLowerCase() : optionLabel(groupField, key)

  // Back to the board after its own field or menu closes, unless that
  // closed it into something else (Open page leaves for the record page).
  const focusBoard = (): void => {
    requestAnimationFrame(() => {
      const board = boardRef.current
      const a = document.activeElement
      if (!board?.isConnected || (a && a !== document.body && !board.contains(a))) return
      board.focus({ preventScroll: true })
    })
  }

  const startAddingCard = (columnKey: string): void => {
    setCardDraft('')
    setAddingCardIn(columnKey)
    addCardOpen.current = columnKey
    setCursor({ columnKey, rowId: null })
  }

  /** Add the typed card to `columnKey`; true when one was added. */
  const commitCard = (columnKey: string): boolean => {
    const title = cardDraft.trim()
    if (!title) return false
    const added = addBoardCard(latestDoc(), view.id, titleField?.id, groupField.id, columnKey, title)
    if (added.picksChanged) updateDatabaseSchema(csvPath, added.doc)
    else updateDatabaseRows(csvPath, added.doc)
    setCardDraft('')
    setCursor({ columnKey, rowId: added.rowId })
    return true
  }

  const closeAddCard = (): void => {
    addCardOpen.current = null
    setAddingCardIn(null)
    setCardDraft('')
  }

  const openCardMenu = (rowId: string): void => {
    const el = boardRef.current?.querySelector<HTMLElement>(`[data-db-board-card="${CSS.escape(rowId)}"]`)
    const rect = el?.getBoundingClientRect()
    setCardMenu({ x: rect ? rect.left + 12 : 0, y: rect ? rect.bottom : 0, rowId })
  }

  /** Open a column's menu, or its colors, below its header. */
  const openColumnMenuAt = (columnKey: string, picking: boolean, point?: { x: number; y: number }): void => {
    const header = boardRef.current?.querySelector<HTMLElement>(
      `[data-db-board-column="${CSS.escape(columnKey)}"] [data-db-board-column-header]`
    )
    const rect = header?.getBoundingClientRect()
    setColumnMenu({
      x: point?.x ?? (rect ? rect.left + 12 : 0),
      y: point?.y ?? (rect ? rect.bottom : 0),
      columnKey,
      picking
    })
  }

  // "No status" gathers cards with no value, so it has no option to color.
  const colorColumn = (columnKey: string): void => {
    if (columnKey !== EMPTY_GROUP) openColumnMenuAt(columnKey, true)
  }
  colorCursorColumn.current = () => {
    if (columns[at.column]) colorColumn(columns[at.column].key)
  }

  const columnColorOf = (columnKey: string) =>
    columnKey === EMPTY_GROUP ? null : selectOptionColor(groupField, columnKey)

  const columnMenuItems = (columnKey: string): ContextMenuItem[] => {
    const color = columnColorOf(columnKey)
    const items: ContextMenuItem[] = [
      {
        label: 'Add card',
        icon: <PlusIcon className="h-3.5 w-3.5" />,
        hint: vimMode ? 'a' : undefined,
        onSelect: () => startAddingCard(columnKey)
      }
    ]
    if (columnKey !== EMPTY_GROUP) {
      items.push({
        label: color ? `Color: ${kanbanColumnColorLabel(color)}…` : 'Color…',
        hint: vimMode ? 'C' : undefined,
        keywords: ['color', 'colour', 'hue', 'accent'],
        onSelect: () => openColumnMenuAt(columnKey, true)
      })
    }
    return items
  }

  const columnColorItems = (columnKey: string): ContextMenuItem[] =>
    columnColorMenuItems(columnColorOf(columnKey), (color) => {
      updateDatabaseSchema(csvPath, setSelectOptionColor(latestDoc(), groupField.id, columnKey, color))
    })

  const cardMenuItems = (rowId: string): ContextMenuItem[] => {
    const row = doc.rows.find((r) => r.id === rowId)
    const here = columns.find((c) => c.rows.some((r) => r.id === rowId))?.key
    return [
      {
        label: 'Open page',
        icon: <ArrowUpRightIcon className="h-3.5 w-3.5" />,
        hint: vimMode ? 'o' : 'Enter',
        onSelect: () => void openRecordPage(csvPath, rowId)
      },
      { kind: 'separator' },
      ...columns
        .filter((c) => c.key !== here)
        .map((c): ContextMenuItem => ({
          label: `Move to ${columnLabel(c.key)}`,
          onSelect: () => {
            moveTo(rowId, c.key)
            setCursor({ columnKey: c.key, rowId })
          }
        })),
      // The one way to a column's colors for a keyboard with Vim mode off, on a
      // column that has cards.
      ...(here && here !== EMPTY_GROUP
        ? ([
            { kind: 'separator' },
            {
              label: 'Column color…',
              hint: vimMode ? 'C' : undefined,
              keywords: ['color', 'colour', 'hue', 'accent'],
              onSelect: () => colorColumn(here)
            }
          ] satisfies ContextMenuItem[])
        : []),
      { kind: 'separator' },
      {
        label: 'Delete card…',
        danger: true,
        disabled: !row,
        onSelect: () => void deleteDatabaseRows(csvPath, [rowId], { confirm: true }).then(focusBoard)
      }
    ]
  }

  const onBoardKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    // Only the board itself: a key typed in the Add card field, the column
    // field, or the open card menu (a portal, whose events still bubble
    // here through React) belongs to that control.
    if (e.target !== e.currentTarget) return
    const action = databaseBoardKeyAction(e, useStore.getState().vimMode)
    if (!action) return
    e.preventDefault()
    switch (action) {
      case 'left':
      case 'right':
      case 'up':
      case 'down':
        setCursor(stepBoardCursor(columns, cursor, action))
        return
      case 'move-left':
      case 'move-right': {
        const target = columns[at.column + (action === 'move-left' ? -1 : 1)]
        if (!focusedRowId || !target) return
        moveTo(focusedRowId, target.key)
        setCursor({ columnKey: target.key, rowId: focusedRowId })
        return
      }
      case 'open':
        if (focusedRowId) void openRecordPage(csvPath, focusedRowId)
        else if (columns[at.column]) startAddingCard(columns[at.column].key)
        return
      case 'add':
        if (columns[at.column]) startAddingCard(columns[at.column].key)
        return
      case 'menu':
        if (focusedRowId) openCardMenu(focusedRowId)
        else if (columns[at.column]) openColumnMenuAt(columns[at.column].key, false)
        return
      case 'color':
        if (columns[at.column]) colorColumn(columns[at.column].key)
        return
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {viewHasPicks(view) && (
        // A board has no row selection, so its picks come from a copied
        // view (or schema.json); here they can only be shown or dropped.
        <DatabasePicksStrip
          count={pickedRowCount(doc, view)}
          onShowAll={() => updateDatabaseSchema(csvPath, clearViewPicks(doc, view.id))}
        />
      )}
      <div className="flex shrink-0 items-center gap-2 px-4 py-2 text-xs text-ink-500">
        <span>Group by</span>
        <select
          value={groupField.id}
          onChange={(e) =>
            updateDatabaseSchema(csvPath, updateView(doc, view.id, { groupByFieldId: e.target.value }))
          }
          className="rounded-md border border-paper-300 bg-paper-50 px-2 py-1 text-xs text-ink-900 outline-none focus:border-accent"
        >
          {selectFields.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </div>

      <div
        ref={boardRef}
        tabIndex={0}
        aria-label="Board"
        data-zen-db-board
        onKeyDown={onBoardKeyDown}
        // The board is this pane's content region, like the Table grid, so
        // Ctrl+W pane moves treat it as the editor.
        onFocus={() => {
          if (useStore.getState().focusedPanel !== 'editor') setFocusedPanel('editor')
        }}
        // The cursor ring follows the board's own :focus. A focus event is
        // not a reliable signal: the board can take focus while the window
        // is in the background, and the ring then never showed.
        className="group/board flex min-h-0 flex-1 gap-3 overflow-x-auto px-4 pb-4 outline-none focus:outline-none"
      >
        {columns.map((col, colIdx) => {
          const columnFocused = colIdx === at.column
          const columnColor = columnColorOf(col.key)
          return (
          <div
            key={col.key}
            data-db-board-column={col.key}
            data-kanban-column-color={columnColor ?? undefined}
            style={
              columnColor
                ? ({ '--kanban-column-hue': kanbanColumnColorVar(columnColor) } as React.CSSProperties)
                : undefined
            }
            onDragOver={(e) => {
              e.preventDefault()
              setOverCol(col.key)
            }}
            onDragLeave={() => setOverCol((c) => (c === col.key ? null : c))}
            onDrop={() => {
              if (dragRow) {
                moveTo(dragRow, col.key)
                setCursor({ columnKey: col.key, rowId: dragRow })
              }
              setDragRow(null)
              setOverCol(null)
            }}
            className={[
              'flex w-72 shrink-0 flex-col rounded-lg border bg-paper-100/60',
              overCol === col.key ? 'border-accent/60' : 'border-paper-300/60'
            ].join(' ')}
          >
            <div
              data-db-board-column-header
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                // The cursor moves here first, so the menu and the keyboard
                // agree on which column is being acted on.
                setCursor({ columnKey: col.key, rowId: null })
                openColumnMenuAt(col.key, false, { x: e.clientX, y: e.clientY })
              }}
              className="flex shrink-0 items-center justify-between gap-2 border-b border-paper-300/45 px-3 py-2"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {columnColor && (
                  <span
                    className="block h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: kanbanColumnColorCss(columnColor) }}
                    aria-hidden="true"
                  />
                )}
                <span className="truncate text-xs font-semibold uppercase tracking-wide text-ink-600">
                  {columnLabel(col.key)}
                </span>
              </span>
              <span className="text-xs text-ink-500">{col.rows.length}</span>
            </div>
            <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
              {col.rows.map((row) => {
                const cardFocused = columnFocused && row.id === focusedRowId
                return (
                  <div
                    key={row.id}
                    data-db-board-card={row.id}
                    draggable
                    onDragStart={() => setDragRow(row.id)}
                    onDragEnd={() => setDragRow(null)}
                    onMouseDown={() => {
                      setCursor({ columnKey: col.key, rowId: row.id })
                      focusBoard()
                    }}
                    onDoubleClick={() => void openRecordPage(csvPath, row.id)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setCursor({ columnKey: col.key, rowId: row.id })
                      setCardMenu({ x: e.clientX, y: e.clientY, rowId: row.id })
                    }}
                    className={[
                      'group/card cursor-grab rounded-md border border-paper-300/60 bg-paper-100/85 px-2.5 py-1.5 active:cursor-grabbing',
                      dragRow === row.id ? 'opacity-50' : 'hover:bg-paper-200/60',
                      cardFocused ? cursorRing : ''
                    ].join(' ')}
                  >
                    <div className="flex items-start justify-between gap-1">
                      <div className="min-w-0 flex-1 truncate text-sm text-ink-900">
                        {titleField ? row.cells[titleField.id] || 'Untitled' : 'Untitled'}
                      </div>
                      <IconButton
                        size="sm"
                        variant="ghost"
                        className="zn-hover-reveal shrink-0 opacity-0 group-hover/card:opacity-100"
                        title="Open as page"
                        onClick={(e) => {
                          e.stopPropagation()
                          void openRecordPage(csvPath, row.id)
                        }}
                      >
                        <ArrowUpRightIcon className="h-3.5 w-3.5" />
                      </IconButton>
                    </div>
                    {cardFields.length > 0 && (
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-2xs text-ink-500">
                        {cardFields.map((f) => {
                          const v = row.cells[f.id] ?? ''
                          if (!v && f.type !== 'checkbox') return null
                          let content: string
                          if (f.type === 'checkbox') content = isCheckboxTrue(v) ? '✓' : ''
                          else if (f.type === 'date') content = formatDate(v)
                          else if (f.type === 'multiSelect') content = splitMultiSelect(v).map((x) => optionLabel(f, x)).join(', ')
                          else if (f.type === 'select') content = optionLabel(f, v)
                          else if (f.type === 'note' || f.type === 'noteMulti') content = splitNoteLinks(v).map(noteLinkTitle).join(', ')
                          else content = v
                          if (!content) return null
                          const chipColor = f.type === 'select' ? selectOptionColor(f, v) : null
                          return (
                            <span
                              key={f.id}
                              className="truncate"
                              style={chipColor ? { color: selectOptionChipStyle(chipColor).color } : undefined}
                            >
                              {content}
                            </span>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}

              {addingCardIn === col.key ? (
                <input
                  autoFocus
                  value={cardDraft}
                  placeholder="Card title"
                  aria-label={`New card in ${columnLabel(col.key)}`}
                  onChange={(e) => setCardDraft(e.target.value)}
                  onBlur={() => {
                    if (addCardOpen.current !== col.key) return
                    commitCard(col.key)
                    closeAddCard()
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    // Enter adds the card and keeps the field open for the next.
                    if (e.key === 'Enter' && !isImeComposing(e)) {
                      e.preventDefault()
                      commitCard(col.key)
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      closeAddCard()
                      focusBoard()
                    }
                  }}
                  className="w-full rounded-md border border-paper-300 bg-paper-50 px-2 py-1.5 text-sm text-ink-900 outline-none focus:border-accent"
                />
              ) : (
                <button
                  type="button"
                  tabIndex={-1}
                  data-db-board-add-card={col.key}
                  onClick={() => startAddingCard(col.key)}
                  className={[
                    'flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-xs text-ink-500 hover:bg-paper-200/40 hover:text-ink-900',
                    col.rows.length === 0 ? 'border border-dashed border-paper-300/60' : '',
                    columnFocused && !focusedRowId ? cursorRing : ''
                  ].join(' ')}
                >
                  <PlusIcon className="h-3.5 w-3.5" /> Add card
                </button>
              )}
            </div>
          </div>
          )
        })}

        {/* Add a new option (= a new column). */}
        <div className="w-56 shrink-0">
          {addingOption ? (
            <input
              autoFocus
              value={optionDraft}
              placeholder="New column…"
              onChange={(e) => setOptionDraft(e.target.value)}
              onBlur={() => {
                if (optionDraft.trim()) {
                  updateDatabaseSchema(csvPath, ensureSelectOption(doc, groupField.id, optionDraft.trim()))
                }
                setOptionDraft('')
                setAddingOption(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !isImeComposing(e)) e.currentTarget.blur()
                else if (e.key === 'Escape') {
                  setOptionDraft('')
                  setAddingOption(false)
                }
              }}
              className="w-full rounded-md border border-paper-300 bg-paper-50 px-2 py-1.5 text-sm text-ink-900 outline-none focus:border-accent"
            />
          ) : (
            <button
              type="button"
              onClick={() => setAddingOption(true)}
              className="flex w-full items-center gap-1 rounded-lg border border-dashed border-paper-300/60 px-3 py-2 text-xs text-ink-500 hover:bg-paper-200/40 hover:text-ink-900"
            >
              <PlusIcon className="h-3.5 w-3.5" /> Add column
            </button>
          )}
        </div>
      </div>

      {columnMenu && (
        <ContextMenu
          key={columnMenu.picking ? 'colors' : 'column'}
          x={columnMenu.x}
          y={columnMenu.y}
          title={columnMenu.picking ? `Color: ${columnLabel(columnMenu.columnKey)}` : undefined}
          items={
            columnMenu.picking
              ? columnColorItems(columnMenu.columnKey)
              : columnMenuItems(columnMenu.columnKey)
          }
          onClose={() => {
            setColumnMenu(null)
            focusBoard()
          }}
        />
      )}

      {cardMenu && (
        <ContextMenu
          x={cardMenu.x}
          y={cardMenu.y}
          items={cardMenuItems(cardMenu.rowId)}
          onClose={() => {
            setCardMenu(null)
            focusBoard()
          }}
        />
      )}
    </div>
  )
}
