/**
 * Pure record-level operations on a DatabaseDoc, shared by every surface
 * that edits rows: the app's grid, and the `zn base` CLI commands (#556).
 * Doc-in, doc-out, no IO. These moved here from app-core's database-cells
 * (which re-exports them unchanged) so the CLI and future MCP tools import
 * the one implementation instead of growing copies.
 */
import { defaultGenId } from './database-csv'
import { yamlValue } from './frontmatter'
import { formDirFromCsvPath, type DatabaseDoc, type DbField, type DbRow, type SelectOption } from './databases'

export function fieldsById(doc: DatabaseDoc): Map<string, DbField> {
  return new Map(doc.fields.map((f) => [f.id, f]))
}

/** A record's display title: the first non-id field's value (fallback "Untitled"). */
export function recordTitle(doc: DatabaseDoc, row: DbRow): string {
  const titleField = doc.fields.find((f) => f.id !== doc.idFieldId)
  const v = titleField ? (row.cells[titleField.id] ?? '').trim() : ''
  return v || 'Untitled'
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
    lines.push(v ? `${f.name}: ${yamlValue(v)}` : `${f.name}:`)
  }
  lines.push('---')
  return `${lines.join('\n')}\n${body.replace(/^\n+/, '')}`
}

/**
 * Where a record's page may already be without being mapped to its row: a
 * note named after the record in the database folder, or in its `pages/`
 * subfolder, under each name a page gets. The app names a local page by its
 * note-title rules (sanitizeNoteTitle in its main process), the server path
 * and zn only replace slashes, and a script someone wrote to make the pages
 * likely used the title as it is. Before this, opening a record whose page
 * file was there but unmapped wrote `Title 2.md` beside it.
 */
export function recordPageCandidates(doc: DatabaseDoc, title: string): string[] {
  const formDir = formDirFromCsvPath(doc.path)
  const raw = title.trim()
  if (!formDir || !raw) return []
  const names = new Set<string>()
  names.add(
    raw
      .replace(/[\\/:\u0000-\u001f*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200)
  )
  names.add(raw.replace(/[\\/]/g, '-'))
  if (!/[\\/]/.test(raw)) names.add(raw)
  const out: string[] = []
  for (const dir of [formDir, `${formDir}/pages`]) {
    for (const name of names) if (name) out.push(`${dir}/${name}.md`)
  }
  return out
}

/** The unmapped page file a record should be linked to, or null: the first
 *  of its candidates that exists and no row maps. A record with an empty
 *  title has no name to match a file by. */
export function recordPageToAdopt(
  doc: DatabaseDoc,
  row: DbRow,
  pageExists: (path: string) => boolean,
  taken: ReadonlySet<string> = new Set(Object.values(doc.pages ?? {}))
): string | null {
  const titleField = doc.fields.find((f) => f.id !== doc.idFieldId)
  const title = titleField ? (row.cells[titleField.id] ?? '').trim() : ''
  if (!title) return null
  return recordPageCandidates(doc, title).find((path) => !taken.has(path) && pageExists(path)) ?? null
}

/** What giving every record its page would do: the records that get one, and
 *  how many are left as they are. */
export interface RecordPagePlan {
  /** Records with no page, or whose page is gone, in row order. */
  missing: DbRow[]
  /** Records whose page file is already there, unmapped: linked, not written. */
  adopt: Array<{ row: DbRow; page: string }>
  /** Records whose page is mapped and still there. */
  existing: number
  /** Records with an empty title field, left without a page. */
  untitled: number
}

/**
 * Plan "Create pages for all records". A record is a note links can reach
 * only once it has a page, and a page used to be made only by opening the
 * record, one at a time: a database converted from a CSV of hundreds of rows
 * had none to link to. A record whose page is mapped and still exists keeps
 * it; one whose page was deleted gets a new one, as opening it would; one
 * with an empty title is skipped, since its page would only be "Untitled"
 * and nothing could link to it by name. A record whose page file is already
 * in the folder but not mapped (written by a script, or left by an older
 * map) is linked to that file instead of getting a `Title 2.md` beside it;
 * a file another row maps, or an earlier record took, is never taken twice.
 * `zn base pages` (zennotescli internal/database) mirrors these rules.
 */
export function planRecordPages(
  doc: DatabaseDoc,
  pageExists: (path: string) => boolean
): RecordPagePlan {
  const titleField = doc.fields.find((f) => f.id !== doc.idFieldId)
  const missing: DbRow[] = []
  const adopt: RecordPagePlan['adopt'] = []
  // Every mapped page belongs to its row, even one that is gone for now.
  const taken = new Set(Object.values(doc.pages ?? {}))
  let existing = 0
  let untitled = 0
  for (const row of doc.rows) {
    const page = doc.pages?.[row.id]
    if (page && pageExists(page)) {
      existing++
      continue
    }
    const title = titleField ? (row.cells[titleField.id] ?? '').trim() : ''
    if (!title) {
      untitled++
      continue
    }
    const found = recordPageToAdopt(doc, row, pageExists, taken)
    if (found) {
      taken.add(found)
      adopt.push({ row, page: found })
      continue
    }
    missing.push(row)
  }
  return { missing, adopt, existing, untitled }
}

export function setCell(doc: DatabaseDoc, rowId: string, fieldId: string, value: string): DatabaseDoc {
  return {
    ...doc,
    rows: doc.rows.map((r) => (r.id === rowId ? { ...r, cells: { ...r.cells, [fieldId]: value } } : r))
  }
}

export function addRow(doc: DatabaseDoc): DatabaseDoc {
  const id = defaultGenId()
  const cells: Record<string, string> = {}
  for (const f of doc.fields) cells[f.id] = ''
  cells[doc.idFieldId] = id
  const row: DbRow = { id, cells }
  return { ...doc, rows: [...doc.rows, row] }
}

/**
 * Add an empty row while `viewId` is the view being looked at. In a view with
 * picks the new row joins them, or it would vanish the moment it was made;
 * `picksChanged` then tells the caller the schema changed too (rows-only
 * writes leave schema.json alone). The grid passes the view on screen, and
 * `zn base add` the database's active view.
 */
export function addRowInView(
  doc: DatabaseDoc,
  viewId: string
): { doc: DatabaseDoc; rowId: string; picksChanged: boolean } {
  const next = addRow(doc)
  const rowId = next.rows[next.rows.length - 1].id
  const picked = doc.views.find((v) => v.id === viewId)?.pickedRowIds
  if (!picked) return { doc: next, rowId, picksChanged: false }
  return {
    doc: {
      ...next,
      views: next.views.map((v) => (v.id === viewId ? { ...v, pickedRowIds: [...picked, rowId] } : v))
    },
    rowId,
    picksChanged: true
  }
}

export function deleteRow(doc: DatabaseDoc, rowId: string): DatabaseDoc {
  return { ...doc, rows: doc.rows.filter((r) => r.id !== rowId) }
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
      const opt: SelectOption = { id: defaultGenId(), value }
      return { ...f, options: [...options, opt] }
    })
  }
}
