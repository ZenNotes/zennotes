/**
 * Per-store meta for soft-deleted items (notes, folders, forms, assets).
 *
 * Each store — `trash/` and `archive/` — holds a hidden `.meta.json` mapping a
 * UUID to that item's origin + display info. The item itself lives at
 * `<top>/<uuid>/<name>`: a fresh UUID wrapper dir per deletion means two
 * same-named deletions never collide, and the original keeps its real name (and
 * `.base`/`.md` suffix) inside the wrapper so restore is exact.
 *
 * The opaque handle passed across IPC for restore/purge is `${top}/${id}`.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { SoftDeletedEntry, SoftDeleteTop } from '@shared/ipc'

const META_FILE = '.meta.json'

/** On-disk meta for one entry (its `id` is the map key; `top` is the file). */
export interface StoredSoftDeleteMeta {
  kind: SoftDeletedEntry['kind']
  name: string
  originalRel: string
  title: string
  deletedAt: number
}

function metaPath(root: string, top: SoftDeleteTop): string {
  return path.join(root, top, META_FILE)
}

/** Build the opaque IPC handle for an entry. */
export function softDeleteHandle(top: SoftDeleteTop, id: string): string {
  return `${top}/${id}`
}

/** Parse `${top}/${id}` back into its parts, or null when malformed. */
export function parseSoftDeleteHandle(
  handle: string
): { top: SoftDeleteTop; id: string } | null {
  const slash = handle.indexOf('/')
  if (slash < 0) return null
  const top = handle.slice(0, slash)
  const id = handle.slice(slash + 1)
  if ((top !== 'trash' && top !== 'archive') || !id || id.includes('/')) return null
  return { top, id }
}

function isValidMeta(value: unknown): value is StoredSoftDeleteMeta {
  if (!value || typeof value !== 'object') return false
  const e = value as Record<string, unknown>
  return (
    (e.kind === 'note' || e.kind === 'folder' || e.kind === 'database' || e.kind === 'asset') &&
    typeof e.name === 'string' &&
    typeof e.originalRel === 'string' &&
    typeof e.title === 'string' &&
    typeof e.deletedAt === 'number'
  )
}

async function readStore(
  root: string,
  top: SoftDeleteTop
): Promise<Record<string, StoredSoftDeleteMeta>> {
  try {
    const raw = await fs.readFile(metaPath(root, top), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, StoredSoftDeleteMeta> = {}
    for (const [id, meta] of Object.entries(parsed as Record<string, unknown>)) {
      if (id && isValidMeta(meta)) out[id] = meta
    }
    return out
  } catch {
    return {}
  }
}

async function writeStore(
  root: string,
  top: SoftDeleteTop,
  store: Record<string, StoredSoftDeleteMeta>
): Promise<void> {
  const file = metaPath(root, top)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await fs.writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  await fs.rename(tmp, file)
}

/** Record a soft-deletion under `<top>` keyed by `id`. */
export async function addSoftDeleteEntry(
  root: string,
  top: SoftDeleteTop,
  id: string,
  meta: StoredSoftDeleteMeta
): Promise<void> {
  const store = await readStore(root, top)
  store[id] = meta
  await writeStore(root, top, store)
}

export async function getSoftDeleteEntry(
  root: string,
  top: SoftDeleteTop,
  id: string
): Promise<StoredSoftDeleteMeta | null> {
  const store = await readStore(root, top)
  return store[id] ?? null
}

/** Remove the entry; returns it (or null when absent). */
export async function removeSoftDeleteEntry(
  root: string,
  top: SoftDeleteTop,
  id: string
): Promise<StoredSoftDeleteMeta | null> {
  const store = await readStore(root, top)
  const found = store[id] ?? null
  if (found) {
    delete store[id]
    await writeStore(root, top, store)
  }
  return found
}

/** Drop the whole meta for a store (used when emptying it). */
export async function clearSoftDeleteStore(root: string, top: SoftDeleteTop): Promise<void> {
  await writeStore(root, top, {})
}

function entriesFor(store: Record<string, StoredSoftDeleteMeta>, top: SoftDeleteTop): SoftDeletedEntry[] {
  return Object.entries(store).map(([id, meta]) => ({ id, top, ...meta }))
}

/** Every soft-deleted entry across both stores, newest first. */
export async function listSoftDeleted(root: string): Promise<SoftDeletedEntry[]> {
  const [trash, archive] = await Promise.all([readStore(root, 'trash'), readStore(root, 'archive')])
  return [...entriesFor(trash, 'trash'), ...entriesFor(archive, 'archive')].sort(
    (a, b) => b.deletedAt - a.deletedAt
  )
}
