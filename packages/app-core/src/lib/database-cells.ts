/**
 * Renderer-side helpers for CSV databases: per-type cell display, and pure
 * `DatabaseDoc` → `DatabaseDoc` mutations the views dispatch through the store.
 * Rows changes go through `updateDatabaseRows`; schema/field/view changes go
 * through `updateDatabaseSchema`. All cell values are raw CSV strings.
 */
import { defaultGenId } from '@shared/database-csv'
import {
  splitMultiSelect,
  joinMultiSelect,
  isCheckboxTrue
} from '@shared/database-transforms'
import type {
  DatabaseDoc,
  DbField,
  DbRow,
  DbView,
  FieldType,
  SelectOption
} from '@shared/databases'

export { splitMultiSelect, joinMultiSelect, isCheckboxTrue }

const genId = defaultGenId

export function formatDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function optionLabel(field: DbField, value: string): string {
  const opt = field.options?.find((o) => o.value === value)
  return opt?.label ?? opt?.value ?? value
}

export function fieldsById(doc: DatabaseDoc): Map<string, DbField> {
  return new Map(doc.fields.map((f) => [f.id, f]))
}

/** A record's display title: the first non-id field's value (fallback "Untitled"). */
export function recordTitle(doc: DatabaseDoc, row: DbRow): string {
  const titleField = doc.fields.find((f) => f.id !== doc.idFieldId)
  const v = titleField ? (row.cells[titleField.id] ?? '').trim() : ''
  return v || 'Untitled'
}

function yamlScalar(value: string): string {
  if (value === '') return '""'
  if (/[:#"'\n]|^\s|\s$/.test(value)) return JSON.stringify(value)
  return value
}

/**
 * Compose a record "page" note: the record's properties as flat YAML
 * frontmatter followed by `body` (the freeform page). The id field and the
 * title field are omitted — the title is the page's `# heading`, so repeating
 * it as a `Name:` property would be redundant. Empty values render as a blank
 * `key:` rather than `key: ""`.
 */
export function composePageBody(doc: DatabaseDoc, row: DbRow, body: string): string {
  const titleFieldId = doc.fields.find((f) => f.id !== doc.idFieldId)?.id
  const lines = ['---']
  for (const f of doc.fields) {
    if (f.id === doc.idFieldId || f.id === titleFieldId) continue
    const v = row.cells[f.id] ?? ''
    lines.push(v ? `${f.name}: ${yamlScalar(v)}` : `${f.name}:`)
  }
  lines.push('---')
  return `${lines.join('\n')}\n${body.replace(/^\n+/, '')}`
}

// --- row mutations (→ updateDatabaseRows) -------------------------------

export function setCell(doc: DatabaseDoc, rowId: string, fieldId: string, value: string): DatabaseDoc {
  return {
    ...doc,
    rows: doc.rows.map((r) => (r.id === rowId ? { ...r, cells: { ...r.cells, [fieldId]: value } } : r))
  }
}

export function addRow(doc: DatabaseDoc): DatabaseDoc {
  const id = genId()
  const cells: Record<string, string> = {}
  for (const f of doc.fields) cells[f.id] = ''
  cells[doc.idFieldId] = id
  const row: DbRow = { id, cells }
  return { ...doc, rows: [...doc.rows, row] }
}

export function deleteRow(doc: DatabaseDoc, rowId: string): DatabaseDoc {
  return { ...doc, rows: doc.rows.filter((r) => r.id !== rowId) }
}

// --- schema / view mutations (→ updateDatabaseSchema) -------------------

function uniqueFieldName(doc: DatabaseDoc, base: string): string {
  const taken = new Set(doc.fields.map((f) => f.name))
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base} ${n}`)) n++
  return `${base} ${n}`
}

export function addField(doc: DatabaseDoc, type: FieldType = 'text', name = 'New field'): DatabaseDoc {
  const field: DbField = {
    id: genId(),
    name: uniqueFieldName(doc, name),
    type,
    ...(type === 'select' || type === 'multiSelect' ? { options: [] } : {})
  }
  return {
    ...doc,
    fields: [...doc.fields, field],
    views: doc.views.map((v) =>
      v.type === 'table' ? { ...v, columnOrder: [...(v.columnOrder ?? doc.fields.map((f) => f.id)), field.id] } : v
    )
  }
}

export function renameField(doc: DatabaseDoc, fieldId: string, name: string): DatabaseDoc {
  const trimmed = name.trim()
  if (!trimmed) return doc
  return {
    ...doc,
    fields: doc.fields.map((f) =>
      f.id === fieldId ? { ...f, name: uniqueFieldName({ ...doc, fields: doc.fields.filter((x) => x.id !== fieldId) }, trimmed) } : f
    )
  }
}

export function retypeField(doc: DatabaseDoc, fieldId: string, type: FieldType): DatabaseDoc {
  return {
    ...doc,
    fields: doc.fields.map((f) => {
      if (f.id !== fieldId) return f
      const next: DbField = { ...f, type }
      if ((type === 'select' || type === 'multiSelect') && !next.options) next.options = []
      return next
    })
  }
}

export function deleteField(doc: DatabaseDoc, fieldId: string): DatabaseDoc {
  if (fieldId === doc.idFieldId) return doc // never delete the id field
  return {
    ...doc,
    fields: doc.fields.filter((f) => f.id !== fieldId),
    rows: doc.rows.map((r) => {
      const { [fieldId]: _drop, ...cells } = r.cells
      void _drop
      return { ...r, cells }
    }),
    views: doc.views.map((v) => ({
      ...v,
      columnOrder: v.columnOrder?.filter((id) => id !== fieldId),
      hiddenFieldIds: v.hiddenFieldIds?.filter((id) => id !== fieldId),
      sorts: v.sorts.filter((s) => s.fieldId !== fieldId),
      filters: v.filters.filter((f) => f.fieldId !== fieldId),
      groupByFieldId: v.groupByFieldId === fieldId ? undefined : v.groupByFieldId
    }))
  }
}

export function ensureSelectOption(doc: DatabaseDoc, fieldId: string, rawValue: string): DatabaseDoc {
  const value = rawValue.trim().replace(/,/g, ' ') // option values may not contain commas
  if (!value) return doc
  return {
    ...doc,
    fields: doc.fields.map((f) => {
      if (f.id !== fieldId) return f
      const options = f.options ?? []
      if (options.some((o) => o.value === value)) return f
      const opt: SelectOption = { id: genId(), value }
      return { ...f, options: [...options, opt] }
    })
  }
}

export function setActiveView(doc: DatabaseDoc, viewId: string): DatabaseDoc {
  return doc.views.some((v) => v.id === viewId) ? { ...doc, activeViewId: viewId } : doc
}

export function updateView(doc: DatabaseDoc, viewId: string, patch: Partial<DbView>): DatabaseDoc {
  return {
    ...doc,
    views: doc.views.map((v) => (v.id === viewId ? ({ ...v, ...patch } as DbView) : v))
  }
}

export function renameView(doc: DatabaseDoc, viewId: string, name: string): DatabaseDoc {
  const trimmed = name.trim()
  if (!trimmed) return doc
  return updateView(doc, viewId, { name: trimmed })
}

export function removeView(doc: DatabaseDoc, viewId: string): DatabaseDoc {
  if (doc.views.length <= 1) return doc // keep at least one view
  const views = doc.views.filter((v) => v.id !== viewId)
  const activeViewId = doc.activeViewId === viewId ? views[0].id : doc.activeViewId
  return { ...doc, views, activeViewId }
}

export function addView(doc: DatabaseDoc, type: 'table' | 'board'): DatabaseDoc {
  const id = genId()
  const base = { id, name: type === 'board' ? 'Board' : 'Table', filters: [], sorts: [] }
  const view: DbView =
    type === 'board'
      ? {
          ...base,
          type: 'board',
          groupByFieldId: doc.fields.find((f) => f.type === 'select')?.id,
          cardFieldIds: doc.fields.filter((f) => f.id !== doc.idFieldId).map((f) => f.id)
        }
      : {
          ...base,
          type: 'table',
          columnOrder: doc.fields.map((f) => f.id),
          hiddenFieldIds: doc.fields.filter((f) => f.hidden).map((f) => f.id)
        }
  return { ...doc, views: [...doc.views, view], activeViewId: id }
}
