import { useMemo, useState } from 'react'
import type { DatabaseDoc, DbField, DbView } from '@shared/databases'
import { EMPTY_GROUP } from '@shared/databases'
import { boardColumns, filterRows } from '@shared/database-transforms'
import { useStore } from '../store'
import {
  setCell,
  ensureSelectOption,
  updateView,
  fieldsById,
  formatDate,
  optionLabel,
  splitMultiSelect,
  isCheckboxTrue
} from '../lib/database-cells'
import { PlusIcon, ArrowUpRightIcon } from './icons'
import { IconButton } from './ui/Button'

interface Props {
  csvPath: string
  doc: DatabaseDoc
  view: DbView
}

/**
 * Board view: columns are the options of a `select` group-by field (+ an
 * "(empty)" column). Dragging a card to a column sets that field on the row.
 * Uses native HTML5 drag-and-drop.
 */
export function DatabaseBoardView({ csvPath, doc, view }: Props): JSX.Element {
  const updateDatabaseRows = useStore((s) => s.updateDatabaseRows)
  const updateDatabaseSchema = useStore((s) => s.updateDatabaseSchema)
  const openRecordPage = useStore((s) => s.openRecordPage)

  const selectFields = doc.fields.filter((f) => f.type === 'select')
  const groupField =
    doc.fields.find((f) => f.id === view.groupByFieldId && f.type === 'select') ?? selectFields[0]

  const map = useMemo(() => fieldsById(doc), [doc])
  const visibleRows = useMemo(
    () => filterRows(doc.rows, view.filters, map),
    [doc.rows, view.filters, map]
  )

  const titleField = doc.fields.find((f) => f.id !== doc.idFieldId)
  const cardFields = (view.cardFieldIds ?? doc.fields.map((f) => f.id))
    .map((id) => map.get(id))
    .filter((f): f is DbField => !!f && !f.hidden && f.id !== doc.idFieldId && f.id !== titleField?.id && f.id !== groupField?.id)

  const [dragRow, setDragRow] = useState<string | null>(null)
  const [overCol, setOverCol] = useState<string | null>(null)
  const [addingOption, setAddingOption] = useState(false)
  const [optionDraft, setOptionDraft] = useState('')

  if (!groupField) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-ink-500">
        <p>Group the board by a Select field.</p>
        <p className="text-xs text-ink-500">Add a Select field in the Table view, then come back.</p>
      </div>
    )
  }

  const optionOrder = view.boardColumnOrder ?? groupField.options?.map((o) => o.value) ?? []
  const columns = boardColumns(visibleRows, groupField, optionOrder)

  const moveTo = (rowId: string, columnKey: string): void => {
    const value = columnKey === EMPTY_GROUP ? '' : columnKey
    updateDatabaseRows(csvPath, setCell(doc, rowId, groupField.id, value))
  }

  const columnLabel = (key: string): string =>
    key === EMPTY_GROUP ? 'No ' + groupField.name.toLowerCase() : optionLabel(groupField, key)

  return (
    <div className="flex h-full min-h-0 flex-col">
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

      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-4 pb-4">
        {columns.map((col) => (
          <div
            key={col.key}
            onDragOver={(e) => {
              e.preventDefault()
              setOverCol(col.key)
            }}
            onDragLeave={() => setOverCol((c) => (c === col.key ? null : c))}
            onDrop={() => {
              if (dragRow) moveTo(dragRow, col.key)
              setDragRow(null)
              setOverCol(null)
            }}
            className={[
              'flex w-72 shrink-0 flex-col rounded-lg border bg-paper-100/60',
              overCol === col.key ? 'border-accent/60' : 'border-paper-300/60'
            ].join(' ')}
          >
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-paper-300/45 px-3 py-2">
              <span className="truncate text-xs font-semibold uppercase tracking-wide text-ink-600">
                {columnLabel(col.key)}
              </span>
              <span className="text-xs text-ink-500">{col.rows.length}</span>
            </div>
            <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
              {col.rows.length === 0 ? (
                <div className="rounded-md border border-dashed border-paper-300/60 px-2 py-3 text-center text-xs text-ink-500">
                  empty
                </div>
              ) : (
                col.rows.map((row) => (
                  <div
                    key={row.id}
                    draggable
                    onDragStart={() => setDragRow(row.id)}
                    onDragEnd={() => setDragRow(null)}
                    className={[
                      'group/card cursor-grab rounded-md border border-paper-300/60 bg-paper-100/85 px-2.5 py-1.5 active:cursor-grabbing',
                      dragRow === row.id ? 'opacity-50' : 'hover:bg-paper-200/60'
                    ].join(' ')}
                  >
                    <div className="flex items-start justify-between gap-1">
                      <div className="min-w-0 flex-1 truncate text-sm text-ink-900">
                        {titleField ? row.cells[titleField.id] || '—' : '—'}
                      </div>
                      <IconButton
                        size="sm"
                        variant="ghost"
                        className="shrink-0 opacity-0 group-hover/card:opacity-100"
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
                          else content = v
                          if (!content) return null
                          return (
                            <span key={f.id} className="truncate">
                              {content}
                            </span>
                          )
                        })}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        ))}

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
                if (e.key === 'Enter') e.currentTarget.blur()
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
    </div>
  )
}
