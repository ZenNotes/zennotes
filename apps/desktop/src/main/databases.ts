/**
 * Main-process IO for CSV-backed databases. Bridges the pure shared-domain
 * logic (@shared/database-csv) to disk, mirroring the comments/tasks helpers:
 * read/write the `.csv` + co-located `.csv.base.json` sidecar with the atomic
 * writer, and adopt a plain CSV (no sidecar) by inferring its schema.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  inferFields,
  buildDefaultViews,
  parseCsv,
  parseRows,
  serializeRows
} from '@shared/database-csv'
import {
  DATABASE_SIDECAR_SUFFIX,
  type DatabaseDoc,
  type DatabaseSidecar,
  type DatabaseSummary,
  type DbField,
  type DbRow,
  type DbView
} from '@shared/databases'
import { databaseDataPath, databaseSidecarPath, writeFileAtomic } from './vault'

const SCHEMA_SAMPLE_ROWS = 50

function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

function titleFromPath(rel: string): string {
  const base = toPosix(rel).split('/').filter(Boolean).pop() ?? rel
  return base.replace(/\.csv$/i, '')
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT'
}

// ---------------------------------------------------------------------------
// Sidecar (schema + views)
// ---------------------------------------------------------------------------

/** Defensive parse of a sidecar JSON; returns null when missing or unusable. */
function normalizeSidecar(raw: unknown): DatabaseSidecar | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const fields = Array.isArray(obj.fields) ? (obj.fields as DbField[]) : null
  if (!fields || fields.length === 0) return null
  if (!fields.every((f) => f && typeof f.id === 'string' && typeof f.name === 'string')) return null
  const fieldIds = new Set(fields.map((f) => f.id))
  const idFieldId = typeof obj.idFieldId === 'string' && fieldIds.has(obj.idFieldId)
    ? obj.idFieldId
    : fields[0].id
  let views = Array.isArray(obj.views) ? (obj.views as DbView[]) : []
  views = views.filter((v) => v && typeof v.id === 'string' && (v.type === 'table' || v.type === 'board'))
  if (views.length === 0) views = buildDefaultViews(fields).views
  const activeViewId =
    typeof obj.activeViewId === 'string' && views.some((v) => v.id === obj.activeViewId)
      ? obj.activeViewId
      : views[0].id
  return { version: 1, idFieldId, fields, views, activeViewId }
}

async function readSidecar(root: string, rel: string): Promise<DatabaseSidecar | null> {
  try {
    const raw = await fs.readFile(databaseSidecarPath(root, rel), 'utf8')
    return normalizeSidecar(JSON.parse(raw))
  } catch (err) {
    if (isMissing(err)) return null
    if (err instanceof SyntaxError) return null
    throw err
  }
}

function hydrate(rel: string, sidecar: DatabaseSidecar, rows: DbRow[]): DatabaseDoc {
  return {
    ...sidecar,
    path: toPosix(rel),
    title: titleFromPath(rel),
    rows
  }
}

async function persistSidecar(root: string, rel: string, sidecar: DatabaseSidecar): Promise<void> {
  await writeFileAtomic(databaseSidecarPath(root, rel), `${JSON.stringify(sidecar, null, 2)}\n`)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read a database. If no sidecar exists, infer the schema from the CSV and
 * adopt it: write the sidecar and re-materialize the CSV so every row gains a
 * stable `id` (one-time migration when opening a plain CSV as a database).
 */
export async function readDatabase(root: string, rel: string): Promise<DatabaseDoc> {
  const csvAbs = databaseDataPath(root, rel)
  let csvText: string
  try {
    csvText = await fs.readFile(csvAbs, 'utf8')
  } catch (err) {
    if (isMissing(err)) throw new Error(`Database not found: ${rel}`)
    throw err
  }

  const existing = await readSidecar(root, rel)
  if (existing) {
    const rows = parseRows(csvText, existing.fields, existing.idFieldId, randomUUID)
    return hydrate(rel, existing, rows)
  }

  // Adopt a plain CSV: infer + materialize.
  const grid = parseCsv(csvText)
  const headers = grid[0] ?? []
  const { fields, idFieldId } = inferFields(headers, grid.slice(1, 1 + SCHEMA_SAMPLE_ROWS), randomUUID)
  const { views, activeViewId } = buildDefaultViews(fields, randomUUID)
  const sidecar: DatabaseSidecar = { version: 1, idFieldId, fields, views, activeViewId }
  const rows = parseRows(csvText, fields, idFieldId, randomUUID)
  await persistSidecar(root, rel, sidecar)
  await writeFileAtomic(csvAbs, serializeRows(rows, fields)) // canonicalize + persist ids
  return hydrate(rel, sidecar, rows)
}

/** Persist rows to the CSV (schema/header come from the sidecar). */
export async function writeDatabaseRows(
  root: string,
  rel: string,
  rows: DbRow[]
): Promise<DatabaseDoc> {
  const sidecar = await readSidecar(root, rel)
  if (!sidecar) throw new Error(`Database sidecar missing: ${rel}`)
  await writeFileAtomic(databaseDataPath(root, rel), serializeRows(rows, sidecar.fields))
  return hydrate(rel, sidecar, rows.map((r) => ({ ...r })))
}

/**
 * Persist schema + views to the sidecar AND rewrite the CSV under the new
 * header. The caller passes the authoritative in-memory rows (keyed by stable
 * `field.id`), so field renames/reorders/adds/deletes never lose data — unlike
 * re-reading the on-disk CSV, whose header may no longer match a renamed field.
 */
export async function writeDatabaseSchema(
  root: string,
  rel: string,
  sidecar: DatabaseSidecar,
  rows: DbRow[]
): Promise<DatabaseDoc> {
  const normalized = normalizeSidecar(sidecar)
  if (!normalized) throw new Error(`Invalid database schema: ${rel}`)
  await persistSidecar(root, rel, normalized)
  await writeFileAtomic(databaseDataPath(root, rel), serializeRows(rows, normalized.fields))
  return hydrate(rel, normalized, rows.map((r) => ({ ...r })))
}

/** Create a new empty database (`id` + `Name` fields) and return it hydrated. */
export async function createDatabase(
  root: string,
  folder: string,
  title?: string
): Promise<DatabaseDoc> {
  const safeTitle = (title ?? 'Untitled Database').trim() || 'Untitled Database'
  const baseName = safeTitle.replace(/[\\/:*?"<>|]/g, '-')
  // Resolve a non-colliding path under the folder.
  let rel = `${folder}/${baseName}.csv`
  let n = 2
  for (;;) {
    try {
      await fs.access(databaseDataPath(root, rel))
      rel = `${folder}/${baseName} ${n++}.csv`
    } catch {
      break
    }
  }

  const idField: DbField = { id: randomUUID(), name: 'id', type: 'text', hidden: true }
  const nameField: DbField = { id: randomUUID(), name: 'Name', type: 'text' }
  const fields = [idField, nameField]
  const { views, activeViewId } = buildDefaultViews(fields)
  const sidecar: DatabaseSidecar = {
    version: 1,
    idFieldId: idField.id,
    fields,
    views,
    activeViewId
  }
  await persistSidecar(root, rel, sidecar)
  await writeFileAtomic(databaseDataPath(root, rel), serializeRows([], fields))
  return hydrate(rel, sidecar, [])
}

/** List `.csv` databases in the vault (skips sidecars, trash, and `.zennotes`). */
export async function listDatabases(root: string): Promise<DatabaseSummary[]> {
  const out: DatabaseSummary[] = []
  const walk = async (dirRel: string): Promise<void> => {
    const dirAbs = dirRel ? path.join(root, dirRel) : root
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const name = entry.name
      if (name.startsWith('.') || name === 'trash' || name === 'node_modules') continue
      const childRel = dirRel ? `${dirRel}/${name}` : name
      if (entry.isDirectory()) {
        await walk(childRel)
      } else if (
        name.toLowerCase().endsWith('.csv') &&
        !name.toLowerCase().endsWith(`.csv${DATABASE_SIDECAR_SUFFIX}`)
      ) {
        out.push({ path: toPosix(childRel), title: titleFromPath(childRel) })
      }
    }
  }
  await walk('')
  return out.sort((a, b) => a.title.localeCompare(b.title))
}
