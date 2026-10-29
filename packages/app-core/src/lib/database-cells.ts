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
  splitNoteLinks,
  joinNoteLinks,
  isCheckboxTrue
} from '@shared/database-transforms'
import type {
  DatabaseDoc,
  DbField,
  DbRow,
  DbView,
  FieldType,
  SelectOption,
  SelectOptionsSource
} from '@shared/databases'

export { splitMultiSelect, joinMultiSelect, splitNoteLinks, joinNoteLinks, isCheckboxTrue }
// Record-level pure ops moved to shared-domain so the zn CLI shares them (#556).
export {
  addRow,
  composePageBody,
  deleteRow,
  ensureSelectOption,
  fieldsById,
  planRecordPages,
  recordPageToAdopt,
  recordTitle,
  setCell
} from '@shared/database-records'
export type { RecordPagePlan } from '@shared/database-records'
import { addRow as addRowDoc } from '@shared/database-records'

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

/** A table view's full column order: the stored `columnOrder` with fields
 *  added since appended and ids of deleted fields dropped, so it always
 *  names every field of `doc` exactly once. */
export function normalizedColumnOrder(doc: DatabaseDoc, view: DbView): string[] {
  const fieldIds = doc.fields.map((f) => f.id)
  const stored = view.columnOrder ?? fieldIds
  return [...stored, ...fieldIds.filter((id) => !stored.includes(id))].filter((id) =>
    fieldIds.includes(id)
  )
}

/** Reorder a table view's columns by moving `fieldId` one *visible* step left or
 *  right (#317). Works on the view's `columnOrder`, swapping with the nearest
 *  visible neighbor so hidden columns don't absorb the move; a no-op at an edge
 *  or for a non-table view. The stored order is normalized first (missing fields
 *  appended, stale ids dropped) so it stays consistent with `doc.fields`. */
export function moveColumn(
  doc: DatabaseDoc,
  viewId: string,
  fieldId: string,
  direction: 'left' | 'right'
): DatabaseDoc {
  const view = doc.views.find((v) => v.id === viewId)
  if (!view || view.type !== 'table') return doc
  const order = normalizedColumnOrder(doc, view)
  const hidden = new Set(view.hiddenFieldIds ?? [])
  const visible = order.filter((id) => !hidden.has(id))
  const vi = visible.indexOf(fieldId)
  if (vi === -1) return doc
  const vj = direction === 'left' ? vi - 1 : vi + 1
  if (vj < 0 || vj >= visible.length) return doc // already at the edge
  const oi = order.indexOf(fieldId)
  const oj = order.indexOf(visible[vj])
  const next = [...order]
  ;[next[oi], next[oj]] = [next[oj], next[oi]]
  return updateView(doc, viewId, { columnOrder: next })
}

/** Move `fieldId` to sit immediately before `targetFieldId` in a table view's
 *  column order — used by header drag-and-drop (#317). No-op for a non-table
 *  view, unknown ids, or a self-drop. */
export function moveColumnToField(
  doc: DatabaseDoc,
  viewId: string,
  fieldId: string,
  targetFieldId: string
): DatabaseDoc {
  if (fieldId === targetFieldId) return doc
  const view = doc.views.find((v) => v.id === viewId)
  if (!view || view.type !== 'table') return doc
  const order = normalizedColumnOrder(doc, view)
  if (!order.includes(fieldId) || !order.includes(targetFieldId)) return doc
  const without = order.filter((id) => id !== fieldId)
  without.splice(without.indexOf(targetFieldId), 0, fieldId)
  return updateView(doc, viewId, { columnOrder: without })
}


/** Set (or with null, clear) where a select field discovers options. (#500) */
export function setFieldOptionsSource(
  doc: DatabaseDoc,
  fieldId: string,
  source: SelectOptionsSource | null
): DatabaseDoc {
  return {
    ...doc,
    fields: doc.fields.map((f) => {
      if (f.id !== fieldId) return f
      if (!source) {
        const { optionsSource: _drop, ...rest } = f
        void _drop
        return rest
      }
      return { ...f, optionsSource: source }
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

/** `base`, or `base 2`, `base 3`… when a view already goes by that name, so
 *  a database with several table views can tell its tabs apart. */
function uniqueViewName(doc: DatabaseDoc, base: string): string {
  const taken = new Set(doc.views.map((v) => v.name))
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base} ${n}`)) n++
  return `${base} ${n}`
}

export function addView(doc: DatabaseDoc, type: 'table' | 'board'): DatabaseDoc {
  const id = genId()
  const base = {
    id,
    name: uniqueViewName(doc, type === 'board' ? 'Board' : 'Table'),
    filters: [],
    sorts: []
  }
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

/**
 * A copy of a view, right after it in the tabs, made the active view. Every
 * setting travels: filters and how they combine, sorts, column order, hidden
 * columns and widths, the board's grouping, column order and card fields, and
 * the picked rows. The copy is deep, so editing one view's filters can never
 * reach into the other's.
 */
export function duplicateView(doc: DatabaseDoc, viewId: string): DatabaseDoc {
  const index = doc.views.findIndex((v) => v.id === viewId)
  if (index === -1) return doc
  const source = doc.views[index]
  const id = genId()
  const copy: DbView = {
    ...(JSON.parse(JSON.stringify(source)) as DbView),
    id,
    name: uniqueViewName(doc, `${source.name} copy`)
  }
  const views = [...doc.views.slice(0, index + 1), copy, ...doc.views.slice(index + 1)]
  return { ...doc, views, activeViewId: id }
}

// --- columns a view shows (→ updateDatabaseSchema) ----------------------

/** The columns a table view can show or hide, in its column order: every
 *  field except a field hidden by the schema itself (the row id). */
export function viewColumnFields(doc: DatabaseDoc, view: DbView): DbField[] {
  const byId = new Map(doc.fields.map((f) => [f.id, f]))
  return normalizedColumnOrder(doc, view)
    .map((id) => byId.get(id))
    .filter((f): f is DbField => !!f && !f.hidden)
}

/** The ids of the columns a table view draws, in order. */
export function visibleColumnIds(doc: DatabaseDoc, view: DbView): string[] {
  const hidden = new Set(view.hiddenFieldIds ?? [])
  return viewColumnFields(doc, view)
    .filter((f) => !hidden.has(f.id))
    .map((f) => f.id)
}

/** True when `fieldId` is the only column the view still draws, which the
 *  view must keep: a table with no columns has nothing to put a cursor on. */
export function isLastVisibleColumn(doc: DatabaseDoc, view: DbView, fieldId: string): boolean {
  const visible = visibleColumnIds(doc, view)
  return visible.length === 1 && visible[0] === fieldId
}

/** Show or hide one column in one table view (its `hiddenFieldIds`), so each
 *  saved view keeps its own columns. Hiding the last visible column is a
 *  no-op; so is any change to a board view or an unknown field. */
export function setColumnHidden(
  doc: DatabaseDoc,
  viewId: string,
  fieldId: string,
  hidden: boolean
): DatabaseDoc {
  const view = doc.views.find((v) => v.id === viewId)
  if (!view || view.type !== 'table') return doc
  if (!viewColumnFields(doc, view).some((f) => f.id === fieldId)) return doc
  const current = view.hiddenFieldIds ?? []
  if (hidden) {
    if (current.includes(fieldId) || isLastVisibleColumn(doc, view, fieldId)) return doc
    return updateView(doc, viewId, { hiddenFieldIds: [...current, fieldId] })
  }
  if (!current.includes(fieldId)) return doc
  return updateView(doc, viewId, { hiddenFieldIds: current.filter((id) => id !== fieldId) })
}

/** Every column of a table view visible again (the schema-hidden row id
 *  stays out, as it always does). */
export function showAllColumns(doc: DatabaseDoc, viewId: string): DatabaseDoc {
  const view = doc.views.find((v) => v.id === viewId)
  if (!view || view.type !== 'table') return doc
  const userIds = new Set(viewColumnFields(doc, view).map((f) => f.id))
  const keep = (view.hiddenFieldIds ?? []).filter((id) => !userIds.has(id))
  return updateView(doc, viewId, { hiddenFieldIds: keep })
}

/** Hide every column of a table view but one, the start of "pick the few I
 *  want": the record's title column stays (it carries the page icon), or the
 *  first column when the title is not one of the view's columns. */
export function hideAllColumns(doc: DatabaseDoc, viewId: string): DatabaseDoc {
  const view = doc.views.find((v) => v.id === viewId)
  if (!view || view.type !== 'table') return doc
  const columns = viewColumnFields(doc, view)
  if (columns.length === 0) return doc
  const titleId = doc.fields.find((f) => f.id !== doc.idFieldId)?.id
  const keepId = columns.some((f) => f.id === titleId) ? titleId : columns[0].id
  const userIds = new Set(columns.map((f) => f.id))
  const schemaHidden = (view.hiddenFieldIds ?? []).filter((id) => !userIds.has(id))
  return updateView(doc, viewId, {
    hiddenFieldIds: [...schemaHidden, ...columns.filter((f) => f.id !== keepId).map((f) => f.id)]
  })
}

// --- picked rows (→ updateDatabaseSchema) --------------------------------

/** True when the view shows only its picked rows. */
export function viewHasPicks(view: DbView): boolean {
  return Array.isArray(view.pickedRowIds)
}

/** How many of the view's picks name a row that still exists. */
export function pickedRowCount(doc: DatabaseDoc, view: DbView): number {
  if (!view.pickedRowIds) return 0
  const picked = new Set(view.pickedRowIds)
  return doc.rows.filter((r) => picked.has(r.id)).length
}

/** Make `rowIds` the view's picks: only rows that exist, in the database's
 *  row order, each once. */
export function setViewPicks(doc: DatabaseDoc, viewId: string, rowIds: Iterable<string>): DatabaseDoc {
  if (!doc.views.some((v) => v.id === viewId)) return doc
  const wanted = new Set(rowIds)
  const pickedRowIds = doc.rows.filter((r) => wanted.has(r.id)).map((r) => r.id)
  return updateView(doc, viewId, { pickedRowIds })
}

/** Drop the view's picks, so it shows every row its filters let through. */
export function clearViewPicks(doc: DatabaseDoc, viewId: string): DatabaseDoc {
  const view = doc.views.find((v) => v.id === viewId)
  if (!view || !viewHasPicks(view)) return doc
  const { pickedRowIds: _drop, ...rest } = view
  void _drop
  return { ...doc, views: doc.views.map((v) => (v.id === viewId ? rest : v)) }
}

/** Take rows out of the view's picks. Ids of deleted rows go at the same
 *  time; taking the last pick out leaves an empty list (0 picked rows), not
 *  every row, so the view never fills up behind the user's back. */
export function removeFromViewPicks(
  doc: DatabaseDoc,
  viewId: string,
  rowIds: Iterable<string>
): DatabaseDoc {
  const view = doc.views.find((v) => v.id === viewId)
  if (!view || !view.pickedRowIds) return doc
  const drop = new Set(rowIds)
  const kept = new Set(view.pickedRowIds.filter((id) => !drop.has(id)))
  return setViewPicks(doc, viewId, kept)
}

/**
 * Add an empty row while `viewId` is the view on screen. In a view with
 * picks the new row joins them, or it would vanish the moment it was made;
 * `picksChanged` then tells the caller the schema changed too (rows-only
 * writes leave schema.json alone).
 */
export function addRowInView(
  doc: DatabaseDoc,
  viewId: string
): { doc: DatabaseDoc; rowId: string; picksChanged: boolean } {
  const next = addRowDoc(doc)
  const rowId = next.rows[next.rows.length - 1].id
  const view = doc.views.find((v) => v.id === viewId)
  if (!view || !view.pickedRowIds) return { doc: next, rowId, picksChanged: false }
  return {
    doc: updateView(next, viewId, { pickedRowIds: [...view.pickedRowIds, rowId] }),
    rowId,
    picksChanged: true
  }
}
