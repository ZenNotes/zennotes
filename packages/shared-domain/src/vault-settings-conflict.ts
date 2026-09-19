/**
 * Comparing two vault.json files section by section.
 *
 * Cloud sync parks the cloud's vault.json beside this device's when both
 * changed, and the app asks which to keep. A whole-file answer forces a
 * choice between "my favorites" and "their folder icons" when the user wants
 * both, so the question is asked per top-level section instead: this module
 * says which sections differ, down to the leaf that differs, and builds the
 * settings that result from a per-section answer. It is pure and shared so
 * every runtime asks the same question of the same bytes.
 *
 * Both sides are expected already normalized by the runtime's own vault
 * settings normalizer. Comparing a raw file against a normalized one reports
 * every default the normalizer filled in as a difference.
 */

import type { VaultSettings } from '@zennotes/bridge-contract/ipc'

export type VaultSettingsSection = keyof VaultSettings

// The type error a new VaultSettings key raises here is deliberate: the
// section list is what the settings conflict prompt offers, so a new section
// must be added (or knowingly left out) rather than silently never shown.
const SECTIONS: Record<VaultSettingsSection, true> = {
  primaryNotesLocation: true,
  dailyNotes: true,
  weeklyNotes: true,
  monthlyNotes: true,
  drawingsLocation: true,
  databasesLocation: true,
  tasksLocation: true,
  view: true,
  folderIcons: true,
  folderColors: true,
  favorites: true,
  systemFolderPaths: true,
  tasks: true,
  typstPreambles: true,
  harper: true
}

export const VAULT_SETTINGS_SECTIONS = Object.keys(SECTIONS) as VaultSettingsSection[]

export function isVaultSettingsSection(key: string): key is VaultSettingsSection {
  return Object.prototype.hasOwnProperty.call(SECTIONS, key)
}

export type VaultSettingsSide = 'local' | 'cloud'

/**
 * One value that differs, addressed by its path from the section root
 * (`['dailyNotes', 'directory']`, `['folderIcons', 'inbox:Projects']`). A list
 * is one leaf, order included: favorites and board columns are ordered by the
 * user, so a reordered list is a different setting, not the same set.
 */
export interface VaultSettingsFieldDifference {
  path: string[]
  local: unknown
  cloud: unknown
}

export interface VaultSettingsSectionDifference {
  section: VaultSettingsSection
  local: unknown
  cloud: unknown
  fields: VaultSettingsFieldDifference[]
}

/**
 * Bookkeeping the app maintains on the user's behalf rather than a choice the
 * user made. Two devices almost always disagree on it once one of them changed
 * the pattern it records, and asking about it would only bury the pattern
 * change that matters. The chosen side's value still travels with its section
 * when the answer is applied.
 */
const IGNORED_PATHS = new Set([
  'dailyNotes.legacyPatterns',
  'weeklyNotes.legacyPatterns',
  'monthlyNotes.legacyPatterns'
])

/** Sections that differ between the two sides, each with the leaves that differ. */
export function diffVaultSettings(
  local: VaultSettings,
  cloud: VaultSettings
): VaultSettingsSectionDifference[] {
  const localRecord = local as unknown as Record<string, unknown>
  const cloudRecord = cloud as unknown as Record<string, unknown>
  const differences: VaultSettingsSectionDifference[] = []
  for (const section of VAULT_SETTINGS_SECTIONS) {
    const fields: VaultSettingsFieldDifference[] = []
    collectDifferences([section], localRecord[section], cloudRecord[section], fields)
    if (fields.length === 0) continue
    differences.push({
      section,
      local: localRecord[section],
      cloud: cloudRecord[section],
      fields
    })
  }
  return differences
}

/**
 * The settings that result from answering per section. Sections without an
 * answer, or answered `local`, keep this device's value; a section answered
 * `cloud` takes the cloud's value, or disappears when the cloud has none, so
 * the runtime's normalizer fills in its default exactly as it would for the
 * cloud's own file.
 */
export function mergeVaultSettings(
  local: VaultSettings,
  cloud: VaultSettings,
  choices: Partial<Record<VaultSettingsSection, VaultSettingsSide>>
): VaultSettings {
  const merged: Record<string, unknown> = { ...(local as unknown as Record<string, unknown>) }
  const cloudRecord = cloud as unknown as Record<string, unknown>
  for (const section of VAULT_SETTINGS_SECTIONS) {
    if (choices[section] !== 'cloud') continue
    if (cloudRecord[section] === undefined) delete merged[section]
    else merged[section] = cloudRecord[section]
  }
  return merged as unknown as VaultSettings
}

/**
 * Top-level keys of a raw vault.json this runtime has no section for: settings
 * a newer or different client wrote. They cannot be compared or chosen here,
 * and the prompt says so rather than pretending the files are otherwise equal.
 */
export function unknownVaultSettingsKeys(raw: unknown): string[] {
  if (!isPlainObject(raw)) return []
  return Object.keys(raw)
    .filter((key) => !isVaultSettingsSection(key))
    .sort()
}

/** Structural equality: key order is not a difference, absent and undefined are the same. */
export function vaultSettingsValueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => vaultSettingsValueEqual(item, b[index]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...definedKeys(a), ...definedKeys(b)])
    for (const key of keys) {
      if (!vaultSettingsValueEqual(a[key], b[key])) return false
    }
    return true
  }
  return false
}

function collectDifferences(
  path: string[],
  local: unknown,
  cloud: unknown,
  out: VaultSettingsFieldDifference[]
): void {
  if (IGNORED_PATHS.has(path.join('.'))) return
  // An object on one side and nothing on the other is compared field by
  // field against an empty object, so the prompt can name the fields that
  // would appear or disappear rather than one opaque "view" leaf.
  const localObject = isPlainObject(local) ? local : local === undefined ? {} : null
  const cloudObject = isPlainObject(cloud) ? cloud : cloud === undefined ? {} : null
  if (localObject && cloudObject && (isPlainObject(local) || isPlainObject(cloud))) {
    const keys = [...new Set([...definedKeys(localObject), ...definedKeys(cloudObject)])].sort()
    for (const key of keys) {
      collectDifferences([...path, key], localObject[key], cloudObject[key], out)
    }
    return
  }
  if (vaultSettingsValueEqual(local, cloud)) return
  out.push({ path, local, cloud })
}

function definedKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).filter((key) => value[key] !== undefined)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
