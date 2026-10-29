/**
 * `zn base ...` subcommands (#556): list, inspect, and edit CSV databases
 * from the command line, on a local vault or through a self-hosted server.
 *
 * Everything routes through the backend's databaseOps() — the same
 * @shared/database-ops composition the web and desktop remote clients use —
 * and applies the same pure record mutations as the app's grid
 * (@shared/database-records). A CLI edit is therefore byte-identical to a
 * grid edit: select values mint options, note-link cells hold [[wikilinks]],
 * and a record page re-mirrors its frontmatter while its body is preserved.
 * The running app's watcher picks the writes up like any external edit.
 */

import {
  addRowInView,
  composePageBody,
  ensureSelectOption,
  recordTitle,
  setCell
} from '@shared/database-records'
import { splitMultiSelect } from '@shared/database-transforms'
import { parseFrontmatter } from '@shared/template-files'
import { formDirFromCsvPath, type DatabaseDoc, type DbField, type DbRow } from '@shared/databases'
import type { DatabaseOps } from '@shared/database-ops'
import type { NoteFolder } from '../../mcp/vault-ops.js'
import type { VaultBackend } from '../backend.js'
import { getBool, getMany, getString, readStdin, type ParsedArgs } from '../args.js'
import { emitJson, emitLine, emitOk, truncate } from '../format.js'

/** Resolve a database by title (case-insensitive) or path (`inbox/X.base`,
 *  with or without `/data.csv`). */
async function resolveDatabase(
  ops: DatabaseOps,
  ref: string | undefined
): Promise<{ path: string; title: string }> {
  if (!ref) throw new Error('Name the database: a title like "Meetings" or a path like inbox/Meetings.base')
  const all = await ops.listDatabases()
  const norm = ref.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const hit = all.find(
    (d) =>
      d.path === norm ||
      formDirFromCsvPath(d.path) === norm ||
      d.title.toLowerCase() === norm.toLowerCase()
  )
  if (hit) return hit
  const available = all.map((d) => d.title).join(', ') || '(none)'
  throw new Error(`No database matches "${ref}". Databases in this vault: ${available}`)
}

/** Resolve a row by id, or by its title-field value when that is unambiguous. */
function resolveRow(doc: DatabaseDoc, ref: string | undefined): DbRow {
  if (!ref) throw new Error('Name the row: an id from `zn base rows`, or its title value.')
  const byId = doc.rows.find((r) => r.id === ref)
  if (byId) return byId
  const needle = ref.trim().toLowerCase()
  const byTitle = doc.rows.filter((r) => recordTitle(doc, r).trim().toLowerCase() === needle)
  if (byTitle.length === 1) return byTitle[0]
  if (byTitle.length > 1) {
    throw new Error(
      `"${ref}" matches ${byTitle.length} rows; use an id: ${byTitle.map((r) => r.id).join(', ')}`
    )
  }
  throw new Error(`No row matches "${ref}". List them with: zn base rows ${JSON.stringify(doc.title)}`)
}

function fieldByName(doc: DatabaseDoc, name: string): DbField {
  const needle = name.trim().toLowerCase()
  const hit = doc.fields.find((f) => f.name.toLowerCase() === needle)
  if (hit) return hit
  const names = doc.fields.filter((f) => f.id !== doc.idFieldId).map((f) => f.name)
  throw new Error(`No field named "${name}". Fields: ${names.join(', ')}`)
}

/** `--set Field=Value` pairs, order preserved. */
function parseAssignments(args: ParsedArgs): { name: string; value: string }[] {
  const sets = getMany(args, 'set')
  if (sets.length === 0) return []
  return sets.map((raw) => {
    const eq = raw.indexOf('=')
    if (eq <= 0) throw new Error(`--set takes Field=Value (got "${raw}")`)
    return { name: raw.slice(0, eq).trim(), value: raw.slice(eq + 1) }
  })
}

/** Apply assignments with the grid's semantics: select values mint options
 *  (schema write), everything else is a plain cell write. */
function applyAssignments(
  doc: DatabaseDoc,
  rowId: string,
  assignments: { name: string; value: string }[]
): { doc: DatabaseDoc; schemaChanged: boolean } {
  let next = doc
  let schemaChanged = false
  for (const { name, value } of assignments) {
    const field = fieldByName(next, name)
    if (field.id === next.idFieldId) throw new Error('The id field cannot be set.')
    if (field.type === 'select' || field.type === 'multiSelect') {
      const values = field.type === 'multiSelect' ? splitMultiSelect(value) : value ? [value] : []
      for (const v of values) {
        const before = next
        next = ensureSelectOption(next, field.id, v)
        if (next !== before) schemaChanged = true
      }
    }
    next = setCell(next, rowId, field.id, value)
  }
  return { doc: next, schemaChanged }
}

/** Persist a doc: through the schema route when options were minted or the
 *  pages map changed, else the cheaper rows route. */
async function persist(
  ops: DatabaseOps,
  csvPath: string,
  doc: DatabaseDoc,
  schemaChanged: boolean
): Promise<DatabaseDoc> {
  if (schemaChanged) {
    const { path: _p, title: _t, rows, pageHasContent: _c, ...sidecar } = doc
    void _p
    void _t
    void _c
    return await ops.writeDatabaseSchema(csvPath, sidecar, rows)
  }
  return await ops.writeDatabaseRows(csvPath, doc.rows)
}

/** Re-mirror a row's properties into its page's frontmatter, keeping the
 *  body — exactly what the app does when it opens a record page. */
async function remirrorPage(vault: VaultBackend, doc: DatabaseDoc, row: DbRow): Promise<string | null> {
  const pagePath = doc.pages?.[row.id]
  if (!pagePath) return null
  try {
    const note = await vault.readNote(pagePath)
    const { body } = parseFrontmatter(note.body)
    await vault.writeNote(pagePath, composePageBody(doc, row, body))
    return pagePath
  } catch {
    return null // page vanished; the app recreates it on next open
  }
}

function rowView(doc: DatabaseDoc, row: DbRow): Record<string, unknown> {
  const cells: Record<string, string> = {}
  for (const f of doc.fields) {
    if (f.id === doc.idFieldId) continue
    cells[f.name] = row.cells[f.id] ?? ''
  }
  return {
    id: row.id,
    title: recordTitle(doc, row),
    cells,
    ...(doc.pages?.[row.id] ? { page: doc.pages[row.id] } : {})
  }
}

export async function cmdBaseList(vault: VaultBackend, args: ParsedArgs): Promise<void> {
  const all = await vault.databaseOps().listDatabases()
  if (getBool(args, 'json')) {
    emitJson(all)
    return
  }
  if (all.length === 0) {
    emitLine('No databases in this vault.')
    return
  }
  for (const d of all) emitLine(`${d.title}\t${d.path}`)
}

export async function cmdBaseCreate(vault: VaultBackend, args: ParsedArgs): Promise<void> {
  const title = args.positionals[0] ?? getString(args, 'title')
  if (!title) throw new Error('zn base create requires a title.')
  const folderSpec = (getString(args, 'folder') ?? 'inbox').replace(/^\/+|\/+$/g, '')
  const [head, ...rest] = folderSpec.split('/')
  const folders: NoteFolder[] = ['inbox', 'quick', 'archive']
  if (!folders.includes(head as NoteFolder)) {
    throw new Error(`--folder must start with one of ${folders.join(', ')} (got "${head}").`)
  }
  const doc = await vault.databaseOps().createDatabase(head as NoteFolder, rest.join('/'), title)
  if (getBool(args, 'json')) {
    emitJson({ ok: true, title: doc.title, path: doc.path })
    return
  }
  emitOk(`Created database ${doc.title} at ${doc.path}`)
}

export async function cmdBaseRows(vault: VaultBackend, args: ParsedArgs): Promise<void> {
  const ops = vault.databaseOps()
  const { path: csvPath } = await resolveDatabase(ops, args.positionals[0])
  const doc = await ops.openDatabase(csvPath)
  if (getBool(args, 'json')) {
    emitJson(doc.rows.map((r) => rowView(doc, r)))
    return
  }
  if (doc.rows.length === 0) {
    emitLine('No rows.')
    return
  }
  for (const row of doc.rows) {
    const extras = doc.fields
      .filter((f) => f.id !== doc.idFieldId)
      .slice(1)
      .map((f) => ({ f, v: (row.cells[f.id] ?? '').trim() }))
      .filter(({ v }) => v)
      .map(({ f, v }) => `${f.name}=${v}`)
      .join('  ')
    emitLine(`${row.id}\t${recordTitle(doc, row)}${extras ? `\t${truncate(extras, 100)}` : ''}`)
  }
}

export async function cmdBaseGet(vault: VaultBackend, args: ParsedArgs): Promise<void> {
  const ops = vault.databaseOps()
  const { path: csvPath } = await resolveDatabase(ops, args.positionals[0])
  const doc = await ops.openDatabase(csvPath)
  const row = resolveRow(doc, args.positionals[1])
  const view = rowView(doc, row)
  if (getBool(args, 'json')) {
    emitJson(view)
    return
  }
  emitLine(`id: ${row.id}`)
  for (const [name, value] of Object.entries(view.cells as Record<string, string>)) {
    emitLine(`${name}: ${value}`)
  }
  if (view.page) emitLine(`page: ${view.page as string}`)
}

export async function cmdBaseAdd(vault: VaultBackend, args: ParsedArgs): Promise<void> {
  const ops = vault.databaseOps()
  const { path: csvPath } = await resolveDatabase(ops, args.positionals[0])
  const assignments = parseAssignments(args)
  if (assignments.length === 0) {
    throw new Error('zn base add requires at least one --set Field=Value (set the title field).')
  }
  // `--body -` reads stdin EXPLICITLY. Auto-draining a non-TTY stdin (the
  // capture pattern) hangs forever when a spawning process leaves its pipe
  // open, which is precisely how agent tooling runs CLIs.
  const bodyFlag = getString(args, 'body')
  const body = bodyFlag === '-' ? (await readStdin()).trim() || null : bodyFlag ?? null
  const wantPage = body != null || getBool(args, 'page')

  // As + Row does in the grid: when the view the database opens on shows
  // picked rows, the new row joins them, or it would be missing from that
  // view the next time the database is opened. Other views keep their picks.
  const opened = await ops.openDatabase(csvPath)
  const added = addRowInView(opened, opened.activeViewId)
  const pickedIn = added.picksChanged ? opened.views.find((v) => v.id === opened.activeViewId)?.name ?? null : null
  const row = added.doc.rows.find((r) => r.id === added.rowId)!
  const applied = applyAssignments(added.doc, row.id, assignments)
  let doc = applied.doc
  let schemaChanged = applied.schemaChanged || added.picksChanged

  let pagePath: string | null = null
  if (wantPage) {
    const current = doc.rows.find((r) => r.id === row.id)!
    const title = recordTitle(doc, current)
    const pageBody = composePageBody(doc, current, `# ${title}\n\n${body ? `${body}\n` : ''}`)
    pagePath = await ops.createRecordPage(csvPath, title, pageBody)
    doc = { ...doc, pages: { ...(doc.pages ?? {}), [row.id]: pagePath } }
    schemaChanged = true // the pages map lives in the sidecar
  }
  doc = await persist(ops, csvPath, doc, schemaChanged)

  const finalRow = doc.rows.find((r) => r.id === row.id)!
  if (getBool(args, 'json')) {
    emitJson({
      ok: true,
      ...rowView({ ...doc, pages: pagePath ? { [row.id]: pagePath } : doc.pages }, finalRow),
      ...(pickedIn !== null ? { pickedInView: pickedIn } : {})
    })
    return
  }
  emitOk(`Added ${recordTitle(doc, finalRow)} (${row.id})`)
  if (pickedIn !== null) emitLine(`  added to the picked rows of the ${pickedIn} view`)
  if (pagePath) emitLine(`  page: ${pagePath}`)
}

export async function cmdBaseSet(vault: VaultBackend, args: ParsedArgs): Promise<void> {
  const ops = vault.databaseOps()
  const { path: csvPath } = await resolveDatabase(ops, args.positionals[0])
  let doc = await ops.openDatabase(csvPath)
  const row = resolveRow(doc, args.positionals[1])
  const assignments = parseAssignments(args)
  if (assignments.length === 0) throw new Error('zn base set requires --set Field=Value.')

  const applied = applyAssignments(doc, row.id, assignments)
  doc = await persist(ops, csvPath, applied.doc, applied.schemaChanged)
  const finalRow = doc.rows.find((r) => r.id === row.id)!
  const page = await remirrorPage(vault, doc, finalRow)

  if (getBool(args, 'json')) {
    emitJson({ ok: true, ...rowView(doc, finalRow), ...(page ? { page } : {}) })
    return
  }
  emitOk(`Updated ${recordTitle(doc, finalRow)} (${finalRow.id})`)
  for (const { name } of assignments) {
    const field = fieldByName(doc, name)
    emitLine(`  ${field.name}: ${finalRow.cells[field.id] ?? ''}`)
  }
  if (page) emitLine(`  page re-mirrored: ${page}`)
}
