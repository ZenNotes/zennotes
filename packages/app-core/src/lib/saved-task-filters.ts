/**
 * Saved Tasks filters (#731): a name the user picks, and the filter query it
 * stands for. The map lives in the portable prefs and mirrors to config.toml
 * as the `[saved_filters]` table, so it is hand-editable and travels with
 * dotfiles. Names are matched case-insensitively wherever a user types one
 * (`:filter <name>`, the picker), while the stored spelling is what the
 * chips show. Insertion order is the display order, and the helpers below
 * keep it through a rename or an overwrite so a chip does not jump to the
 * end when its query is updated.
 */

export type SavedTaskFilters = Record<string, string>

export const MAX_SAVED_TASK_FILTERS = 50
export const MAX_SAVED_TASK_FILTER_NAME_LENGTH = 60
export const MAX_SAVED_TASK_FILTER_QUERY_LENGTH = 200

/** Validate an untrusted value (config.toml, localStorage) into a clean map. */
export function normalizeSavedTaskFilters(value: unknown): SavedTaskFilters {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const normalized: SavedTaskFilters = {}
  for (const [rawName, rawQuery] of Object.entries(value as Record<string, unknown>)) {
    if (typeof rawQuery !== 'string') continue
    const name = rawName.trim()
    const query = rawQuery.trim()
    if (!name || !query) continue
    if (name.length > MAX_SAVED_TASK_FILTER_NAME_LENGTH) continue
    if (findSavedTaskFilterName(normalized, name)) continue
    normalized[name] = query.slice(0, MAX_SAVED_TASK_FILTER_QUERY_LENGTH)
    if (Object.keys(normalized).length >= MAX_SAVED_TASK_FILTERS) break
  }
  return normalized
}

/** The stored spelling of `name`, matched case-insensitively, or null. */
export function findSavedTaskFilterName(filters: SavedTaskFilters, name: string): string | null {
  const wanted = name.trim().toLowerCase()
  if (!wanted) return null
  for (const stored of Object.keys(filters)) {
    if (stored.toLowerCase() === wanted) return stored
  }
  return null
}

/** The query saved under `name` (case-insensitive), or null. */
export function savedTaskFilterQuery(filters: SavedTaskFilters, name: string): string | null {
  const stored = findSavedTaskFilterName(filters, name)
  return stored === null ? null : filters[stored]
}

/**
 * The saved filter whose query is `query` (trimmed, case-insensitive, since
 * matching ignores case), or null. Drives the highlighted chip.
 */
export function savedTaskFilterNameForQuery(
  filters: SavedTaskFilters,
  query: string
): string | null {
  const wanted = query.trim().toLowerCase()
  if (!wanted) return null
  for (const [name, saved] of Object.entries(filters)) {
    if (saved.trim().toLowerCase() === wanted) return name
  }
  return null
}

/**
 * `filters` with `name` set to `query`. A name already present (in any
 * casing) keeps its position and takes the new spelling and query; a new
 * name goes last.
 */
export function withSavedTaskFilter(
  filters: SavedTaskFilters,
  name: string,
  query: string
): SavedTaskFilters {
  const cleanName = name.trim().slice(0, MAX_SAVED_TASK_FILTER_NAME_LENGTH)
  const cleanQuery = query.trim().slice(0, MAX_SAVED_TASK_FILTER_QUERY_LENGTH)
  if (!cleanName || !cleanQuery) return filters
  const existing = findSavedTaskFilterName(filters, cleanName)
  const next: SavedTaskFilters = {}
  for (const [stored, saved] of Object.entries(filters)) {
    if (stored === existing) next[cleanName] = cleanQuery
    else next[stored] = saved
  }
  if (existing === null) {
    if (Object.keys(next).length >= MAX_SAVED_TASK_FILTERS) return filters
    next[cleanName] = cleanQuery
  }
  return next
}

/** `filters` without `name` (case-insensitive); unchanged when absent. */
export function withoutSavedTaskFilter(filters: SavedTaskFilters, name: string): SavedTaskFilters {
  const stored = findSavedTaskFilterName(filters, name)
  if (stored === null) return filters
  const next: SavedTaskFilters = {}
  for (const [key, saved] of Object.entries(filters)) {
    if (key !== stored) next[key] = saved
  }
  return next
}

/**
 * `filters` with `from` renamed to `to`, keeping its position and query.
 * Unchanged when `from` is unknown, `to` is blank, or `to` already names a
 * different filter.
 */
export function renameSavedTaskFilter(
  filters: SavedTaskFilters,
  from: string,
  to: string
): SavedTaskFilters {
  const stored = findSavedTaskFilterName(filters, from)
  const cleanTo = to.trim().slice(0, MAX_SAVED_TASK_FILTER_NAME_LENGTH)
  if (stored === null || !cleanTo) return filters
  const taken = findSavedTaskFilterName(filters, cleanTo)
  if (taken !== null && taken !== stored) return filters
  const next: SavedTaskFilters = {}
  for (const [key, saved] of Object.entries(filters)) {
    next[key === stored ? cleanTo : key] = saved
  }
  return next
}
