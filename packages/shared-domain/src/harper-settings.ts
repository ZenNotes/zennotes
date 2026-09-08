/**
 * Harper (writewithharper.com) settings shared by every runtime: the dialect
 * and rule preferences a device keeps, and the dictionary and ignored
 * suggestions that belong to a vault (stored in vault.json, so they travel
 * with the notes and sync with them). Desktop main, the renderer and the Go
 * server all normalize the vault half through this one module.
 */

export type HarperDialect = 'american' | 'british' | 'australian' | 'canadian' | 'indian'

export const HARPER_DIALECTS: ReadonlyArray<{ value: HarperDialect; label: string }> = [
  { value: 'american', label: 'American' },
  { value: 'british', label: 'British' },
  { value: 'australian', label: 'Australian' },
  { value: 'canadian', label: 'Canadian' },
  { value: 'indian', label: 'Indian' }
]

export const DEFAULT_HARPER_DIALECT: HarperDialect = 'american'

export function isHarperDialect(value: unknown): value is HarperDialect {
  return HARPER_DIALECTS.some((dialect) => dialect.value === value)
}

/** Per-rule overrides handed straight to Harper: `true` on, `false` off,
 *  `null` back to Harper's default. Empty means "Harper's defaults". */
export type HarperLintConfig = Record<string, boolean | null>

export function normalizeHarperLintConfig(value: unknown): HarperLintConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: HarperLintConfig = {}
  for (const [rule, setting] of Object.entries(value as Record<string, unknown>)) {
    if (!rule) continue
    if (setting === true || setting === false || setting === null) result[rule] = setting
  }
  return result
}

/** The Harper data that belongs to a vault rather than a device. */
export interface HarperVaultState {
  /** Words the user added to the dictionary. */
  words: string[]
  /**
   * Harper's context hashes of suggestions the user chose to ignore. They are
   * unsigned 64-bit integers, which JSON.parse in a browser would round, so
   * they are carried as digit strings end to end and never parsed as numbers.
   */
  ignoredLints: string[]
}

export const EMPTY_HARPER_VAULT_STATE: HarperVaultState = { words: [], ignoredLints: [] }

/** Undefined when there is nothing to store, so vault.json stays free of an
 *  empty `harper` block. */
export function normalizeHarperVaultState(value: unknown): HarperVaultState | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as { words?: unknown; ignoredLints?: unknown }
  const words = uniqueStrings(candidate.words)
  const ignoredLints = uniqueStrings(candidate.ignoredLints).filter((hash) => /^\d+$/.test(hash))
  if (words.length === 0 && ignoredLints.length === 0) return undefined
  return { words, ignoredLints }
}

/** Harper exports ignored lints as `{"context_hashes":[<u64>, ...]}`. Pull the
 *  digit runs out as strings without ever parsing the JSON. */
export function harperIgnoredLintHashes(exported: string): string[] {
  return exported.match(/\d+/g) ?? []
}

/** The JSON Harper's `importIgnoredLints` expects, built by concatenation so
 *  the hashes stay exact. Null when there is nothing to import. */
export function harperIgnoredLintsJson(hashes: readonly string[]): string | null {
  const valid = hashes.filter((hash) => /^\d+$/.test(hash))
  if (valid.length === 0) return null
  return `{"context_hashes":[${valid.join(',')}]}`
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const cleaned = entry.trim()
    if (!cleaned || seen.has(cleaned)) continue
    seen.add(cleaned)
    result.push(cleaned)
  }
  return result
}
