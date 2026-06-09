import { useMemo, useRef, useState, useEffect } from 'react'
import type { DatabaseDoc, DbField, DbRow, DbView, FieldType } from '@shared/databases'
import { filterRows, sortRows } from '@shared/database-transforms'
import { useStore } from '../store'
import {
  addRow,
  setCell,
  deleteRow,
  renameField,
  retypeField,
  deleteField,
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
import { MoreIcon, TrashIcon, PlusIcon } from './icons'

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
}

export function DatabaseTableView({ csvPath, doc, view }: Props): JSX.Element {
  const updateDatabaseRows = useStore((s) => s.updateDatabaseRows)
  const updateDatabaseSchema = useStore((s) => s.updateDatabaseSchema)

  const [editing, setEditing] = useState<{ rowId: string; fieldId: string } | null>(null)
  const [renamingField, setRenamingField] = useState<string | null>(null)
  const [fieldMenu, setFieldMenu] = useState<{ fieldId: string; x: number; y: number } | null>(null)

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
  }

  const sortIndicator = (fieldId: string): string => {
    const s = view.sorts.find((x) => x.fieldId === fieldId)
    return s ? (s.direction === 'asc' ? ' ↑' : ' ↓') : ''
  }

  const fieldMenuItems = (field: DbField): ContextMenuItem[] => [
    { label: 'Sort ascending', onSelect: () => updateDatabaseSchema(csvPath, updateView(doc, view.id, { sorts: [{ fieldId: field.id, direction: 'asc' }] })) },
    { label: 'Sort descending', onSelect: () => updateDatabaseSchema(csvPath, updateView(doc, view.id, { sorts: [{ fieldId: field.id, direction: 'desc' }] })) },
    { label: 'Clear sort', disabled: view.sorts.length === 0, onSelect: () => updateDatabaseSchema(csvPath, updateView(doc, view.id, { sorts: [] })) },
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
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-paper-100">
          <tr className="border-b border-paper-300/70">
            <th className="w-8 border-r border-paper-300/40" />
            {columns.map((field) => (
              <th
                key={field.id}
                className="group/h min-w-[8rem] border-r border-paper-300/40 px-2 py-1.5 text-left font-medium text-ink-600"
              >
                {renamingField === field.id ? (
                  <input
                    autoFocus
                    defaultValue={field.name}
                    onFocus={(e) => e.currentTarget.select()}
                    onBlur={(e) => {
                      updateDatabaseSchema(csvPath, renameField(doc, field.id, e.currentTarget.value))
                      setRenamingField(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur()
                      else if (e.key === 'Escape') setRenamingField(null)
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
                      <span className="text-ink-400">{sortIndicator(field.id)}</span>
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
          {rows.map((row) => (
            <tr key={row.id} className="group/row border-b border-paper-300/30 hover:bg-paper-200/30">
              <td className="border-r border-paper-300/40 text-center align-middle">
                <IconButton
                  size="sm"
                  variant="ghost"
                  className="opacity-0 group-hover/row:opacity-100"
                  title="Delete row"
                  onClick={() => updateDatabaseRows(csvPath, deleteRow(doc, row.id))}
                >
                  <TrashIcon className="h-3.5 w-3.5" />
                </IconButton>
              </td>
              {columns.map((field) => (
                <td key={field.id} className="border-r border-paper-300/40 p-0 align-top">
                  <Cell
                    field={field}
                    value={row.cells[field.id] ?? ''}
                    editing={editing?.rowId === row.id && editing?.fieldId === field.id}
                    onStartEdit={() => setEditing({ rowId: row.id, fieldId: field.id })}
                    onEndEdit={() => setEditing(null)}
                    onCommit={(v) => commitCell(row.id, field, v)}
                  />
                </td>
              ))}
            </tr>
          ))}
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

      {fieldMenu && (
        <ContextMenu
          x={fieldMenu.x}
          y={fieldMenu.y}
          items={fieldMenuItems(map.get(fieldMenu.fieldId)!)}
          onClose={() => setFieldMenu(null)}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

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
          if (e.key === 'Enter') e.currentTarget.blur()
          else if (e.key === 'Escape') onEndEdit()
        }}
        className="w-full bg-paper-50 px-2 py-1.5 text-sm text-ink-900 outline-none ring-1 ring-inset ring-accent"
      />
    )
  }

  return (
    <button type="button" onClick={onStartEdit} className="block h-full w-full px-2 py-1.5 text-left">
      <span className="block truncate text-ink-900">{field.type === 'date' ? formatDate(value) : value}</span>
    </button>
  )
}

function SelectCell({ field, value, editing, onStartEdit, onEndEdit, onCommit }: CellProps): JSX.Element {
  const multi = field.type === 'multiSelect'
  const selected = multi ? splitMultiSelect(value) : value ? [value] : []
  const ref = useRef<HTMLDivElement | null>(null)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    if (!editing) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onEndEdit()
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
          <span key={v} className="rounded-full bg-accent/15 px-2 py-0.5 text-2xs font-medium text-accent ring-1 ring-accent/30">
            {optionLabel(field, v)}
          </span>
        ))
      )}
    </div>
  )

  if (!editing) {
    return (
      <button type="button" onClick={onStartEdit} className="block h-full w-full px-2 py-1.5 text-left">
        {chips}
      </button>
    )
  }

  return (
    <div ref={ref} className="relative">
      <div className="px-2 py-1.5 ring-1 ring-inset ring-accent">{chips}</div>
      <div className="absolute left-0 top-full z-50 mt-1 w-56 overflow-hidden rounded-lg border border-paper-300 bg-paper-100 py-1 shadow-float">
        <div className="max-h-56 overflow-y-auto">
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
        </div>
        <div className="border-t border-paper-300/60 p-1.5">
          <input
            value={draft}
            placeholder="Add option…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter' && draft.trim()) {
                toggle(draft.trim().replace(/,/g, ' '))
                setDraft('')
              } else if (e.key === 'Escape') {
                onEndEdit()
              }
            }}
            className="w-full rounded border border-paper-300 bg-paper-50 px-2 py-1 text-sm text-ink-900 outline-none focus:border-accent"
          />
        </div>
      </div>
    </div>
  )
}
