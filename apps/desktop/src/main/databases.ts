/**
 * Main-process IO for CSV-backed forms. Bridges the pure shared-domain logic
 * (@shared/database-csv) to disk. A form is a self-contained `<Name>.base/`
 * folder holding `data.csv`, `schema.json` (the sidecar), and a `pages/` folder
 * of record-page notes. Because it's one folder, rename/move/trash are plain
 * folder operations and record-page paths are stored relative to the folder.
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
  csvPathForFormDir,
  FORM_DIR_SUFFIX,
  FORM_PAGES_DIR,
  formDirFromCsvPath,
  formTitleFromCsvPath,
  formTitleFromDir,
  isFormDirName,
  type DatabaseDoc,
  type DatabaseSidecar,
  type DatabaseSummary,
  type DbField,
  type DbRow,
  type DbView
} from '@shared/databases'
import type { NoteFolder } from '@shared/ipc'
import {
  databaseDataPath,
  databaseSidecarPath,
  folderRoot,
  sanitizeNoteTitle,
  softDeleteVaultPath,
  uniqueTitle,
  writeFileAtomic
} from './vault'

const SCHEMA_SAMPLE_ROWS = 50

function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

/** Form title = its `.base` folder name (e.g. `a/Books.base/data.csv` → `Books`). */
function titleFromPath(rel: string): string {
  return formTitleFromCsvPath(toPosix(rel))
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT'
}

// Record-page paths are stored RELATIVE to the form folder (e.g. `pages/X.md`)
// so the folder can be renamed/moved without rewriting them. In memory they are
// resolved to full vault-relative paths (e.g. `Books.base/pages/X.md`).
function pagesToFull(csvRel: string, pages: Record<string, string>): Record<string, string> {
  const formDir = formDirFromCsvPath(csvRel)
  if (!formDir) return pages
  const prefix = `${formDir}/`
  return Object.fromEntries(
    Object.entries(pages).map(([id, p]) => [id, p.startsWith(prefix) ? p : `${prefix}${p}`])
  )
}

function pagesToRelative(csvRel: string, pages: Record<string, string>): Record<string, string> {
  const formDir = formDirFromCsvPath(csvRel)
  if (!formDir) return pages
  const prefix = `${formDir}/`
  return Object.fromEntries(
    Object.entries(pages).map(([id, p]) => [id, p.startsWith(prefix) ? p.slice(prefix.length) : p])
  )
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
  const pages =
    obj.pages && typeof obj.pages === 'object'
      ? (Object.fromEntries(
          Object.entries(obj.pages as Record<string, unknown>).filter(
            ([, v]) => typeof v === 'string'
          )
        ) as Record<string, string>)
      : undefined
  const recordPageTemplate =
    typeof obj.recordPageTemplate === 'string' && obj.recordPageTemplate.trim()
      ? obj.recordPageTemplate
      : undefined
  return {
    version: 1,
    idFieldId,
    fields,
    views,
    activeViewId,
    ...(pages ? { pages } : {}),
    ...(recordPageTemplate ? { recordPageTemplate } : {})
  }
}

async function readSidecar(root: string, rel: string): Promise<DatabaseSidecar | null> {
  try {
    const raw = await fs.readFile(databaseSidecarPath(root, rel), 'utf8')
    const sidecar = normalizeSidecar(JSON.parse(raw))
    if (sidecar?.pages) sidecar.pages = pagesToFull(toPosix(rel), sidecar.pages)
    return sidecar
  } catch (err) {
    if (isMissing(err)) return null
    if (err instanceof SyntaxError) return null
    throw err
  }
}

function hydrate(
  rel: string,
  sidecar: DatabaseSidecar,
  rows: DbRow[],
  pageHasContent?: Record<string, boolean>
): DatabaseDoc {
  return {
    ...sidecar,
    path: toPosix(rel),
    title: titleFromPath(rel),
    rows,
    ...(pageHasContent ? { pageHasContent } : {})
  }
}

/** True if a note has body content beyond its frontmatter + a single title heading. */
function noteHasBody(text: string): boolean {
  let body = text
  const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(body)
  if (fm) body = body.slice(fm[0].length)
  body = body.replace(/^\s*#[^\n]*\r?\n?/, '') // drop a single leading heading
  return body.trim().length > 0
}

async function readPageContentFlags(
  root: string,
  pages?: Record<string, string>
): Promise<Record<string, boolean> | undefined> {
  if (!pages || Object.keys(pages).length === 0) return undefined
  const flags: Record<string, boolean> = {}
  await Promise.all(
    Object.entries(pages).map(async ([rowId, notePath]) => {
      try {
        flags[rowId] = noteHasBody(await fs.readFile(databaseDataPath(root, notePath), 'utf8'))
      } catch {
        /* missing note → leave unset (treated as empty) */
      }
    })
  )
  return flags
}

async function persistSidecar(root: string, rel: string, sidecar: DatabaseSidecar): Promise<void> {
  const onDisk: DatabaseSidecar = sidecar.pages
    ? { ...sidecar, pages: pagesToRelative(toPosix(rel), sidecar.pages) }
    : sidecar
  await writeFileAtomic(databaseSidecarPath(root, rel), `${JSON.stringify(onDisk, null, 2)}\n`)
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
    const pageHasContent = await readPageContentFlags(root, existing.pages)
    return hydrate(rel, existing, rows, pageHasContent)
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

/**
 * Create a new empty database (`id` + `Name` fields) under `folder`/`subpath`
 * and return it hydrated. Uses `folderRoot` so a root-mode vault creates at the
 * vault root rather than inventing an `inbox/` directory.
 */
export async function createDatabase(
  root: string,
  folder: NoteFolder,
  subpath: string,
  title?: string
): Promise<DatabaseDoc> {
  const safeTitle = (title ?? 'Untitled Database').trim() || 'Untitled Database'
  const baseName = safeTitle.replace(/[\\/:*?"<>|]/g, '-')
  const topAbs = await folderRoot(root, folder)
  const cleanSub = toPosix(subpath).replace(/^\/+|\/+$/g, '')
  const dirAbs = cleanSub ? path.join(topAbs, cleanSub) : topAbs
  const dirRel = toPosix(path.relative(root, dirAbs))
  const makeFormDir = (name: string): string =>
    dirRel ? `${dirRel}/${name}${FORM_DIR_SUFFIX}` : `${name}${FORM_DIR_SUFFIX}`
  // Resolve a non-colliding `<Name>.base` folder under the directory.
  let formDirRel = makeFormDir(baseName)
  let n = 2
  for (;;) {
    try {
      await fs.access(databaseDataPath(root, formDirRel))
      formDirRel = makeFormDir(`${baseName} ${n++}`)
    } catch {
      break
    }
  }
  const rel = csvPathForFormDir(formDirRel)

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
  // Create the folder (with its empty `pages/`), then the two data files.
  await fs.mkdir(databaseDataPath(root, `${formDirRel}/${FORM_PAGES_DIR}`), { recursive: true })
  await persistSidecar(root, rel, sidecar)
  await writeFileAtomic(databaseDataPath(root, rel), serializeRows([], fields))
  return hydrate(rel, sidecar, [])
}

/**
 * Create a "page" note for a database record inside the form's `pages/` folder
 * (`<Name>.base/pages/<title>.md`) with the given pre-composed body, and return
 * its full vault-relative path. The sidecar stores it relative to the folder.
 */
export async function createRecordPage(
  root: string,
  csvPath: string,
  title: string,
  body: string
): Promise<string> {
  const formDir = formDirFromCsvPath(toPosix(csvPath))
  if (!formDir) throw new Error(`Not a form: ${csvPath}`)
  const pagesDirRel = `${formDir}/${FORM_PAGES_DIR}`
  const dirAbs = databaseDataPath(root, pagesDirRel) // resolveSafe + posix
  await fs.mkdir(dirAbs, { recursive: true })
  const finalTitle = await uniqueTitle(dirAbs, sanitizeNoteTitle(title))
  const noteRel = `${pagesDirRel}/${finalTitle}.md`
  await fs.writeFile(databaseDataPath(root, noteRel), body, 'utf8')
  return noteRel
}

/**
 * Permanently delete a form: remove its entire `<Name>.base` folder (data.csv,
 * schema.json, and the `pages/` record notes) in one shot.
 */
export async function deleteDatabase(root: string, csvRel: string): Promise<void> {
  const formDir = formDirFromCsvPath(toPosix(csvRel))
  if (!formDir) throw new Error(`Not a form: ${csvRel}`)
  await fs.rm(databaseDataPath(root, formDir), { recursive: true, force: true })
}

/**
 * Rename a form in place: just rename its `<oldName>.base` folder to
 * `<newName>.base`. Record-page paths in `schema.json` are stored relative to
 * the folder, so nothing inside needs rewriting. Returns the new `data.csv`
 * vault-relative path (unchanged when the name is effectively the same).
 */
export async function renameDatabase(
  root: string,
  csvRel: string,
  nextName: string
): Promise<string> {
  const posix = toPosix(csvRel)
  const formDir = formDirFromCsvPath(posix)
  if (!formDir) throw new Error(`Not a form: ${csvRel}`)
  const slash = formDir.lastIndexOf('/')
  const dir = slash >= 0 ? formDir.slice(0, slash) : ''
  const oldName = formTitleFromDir(formDir)
  // Mirror createDatabase's filename sanitization.
  const cleanName = nextName.replace(/[\\/:*?"<>|]/g, '-').trim()
  if (!cleanName) throw new Error('Database name is required')
  if (cleanName === oldName) return posix

  const newFormDir = dir
    ? `${dir}/${cleanName}${FORM_DIR_SUFFIX}`
    : `${cleanName}${FORM_DIR_SUFFIX}`
  // Refuse to clobber an existing form at the target name.
  try {
    await fs.access(databaseDataPath(root, newFormDir))
    throw new Error(`A database named "${cleanName}" already exists here.`)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  await fs.rename(databaseDataPath(root, formDir), databaseDataPath(root, newFormDir))
  return csvPathForFormDir(newFormDir)
}

/**
 * Soft-delete a form: move its `<Name>.base` folder (as a single unit) into
 * `trash/` or `archive/` and record its origin for restore. Because a form is
 * itself a folder, this reuses the generic folder soft-delete; the only
 * difference is the recorded `kind` (so the UI shows a form icon). `restore`
 * and `purge` route through the kind-agnostic folder helpers.
 */
export async function softDeleteDatabase(
  root: string,
  csvRel: string,
  target: 'trash' | 'archive'
): Promise<void> {
  const formDir = formDirFromCsvPath(toPosix(csvRel))
  if (!formDir) throw new Error(`Not a form: ${csvRel}`)
  await softDeleteVaultPath(root, formDir, target, 'database', formTitleFromDir(formDir))
}

/** List forms in the vault: every `<Name>.base` folder (skips trash, top-level archive, `.zennotes`). */
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
      if (!entry.isDirectory()) continue
      if (name.startsWith('.') || name === 'trash' || name === 'node_modules') continue
      // Archived forms aren't "active" — skip the top-level archive folder only
      // (a nested user folder literally named "archive" should still be walked).
      if (dirRel === '' && name === 'archive') continue
      const childRel = dirRel ? `${dirRel}/${name}` : name
      if (isFormDirName(name)) {
        // A form is a self-contained unit — emit its data.csv, don't walk inside.
        out.push({ path: csvPathForFormDir(childRel), title: formTitleFromDir(name) })
      } else {
        await walk(childRel)
      }
    }
  }
  await walk('')
  return out.sort((a, b) => a.title.localeCompare(b.title))
}
