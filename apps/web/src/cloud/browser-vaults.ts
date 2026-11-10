/**
 * The vaults this browser holds, in IndexedDB (`preferences`): Try mode's
 * local vault, and each ZenNotes Cloud vault opened here. One OPFS folder and
 * one Web Lock per vault, keyed by a safe id, never by the vault's name:
 * a Cloud vault's key comes from its Cloud id, so renaming it anywhere keeps
 * this browser's copy and its sync state (`browser/<key>` is the package's
 * syncKey).
 *
 * Each Cloud vault records the account it belongs to. One account per
 * browser profile: signing into another account removes the previous one's
 * vaults (cloud-session.ts), so one account's notes never sit beside
 * another's.
 */
import { idbGet, idbUpdate } from './idb'
import { isValidVaultKey } from './opfs-paths'

export const TRY_VAULT_KEY = 'try'
export const TRY_VAULT_NAME = 'Try ZenNotes'

export interface BrowserVaultAccount {
  baseUrl: string
  email: string
}

export interface BrowserVaultEntry {
  key: string
  name: string
  /** `try`: the local Try vault, in this browser only. `cloud`: a vault this
   *  browser keeps in sync with ZenNotes Cloud (Try's vault becomes one when
   *  it is kept in Cloud). */
  kind: 'try' | 'cloud'
  vaultId?: string
  account?: BrowserVaultAccount
  /** End-to-end encrypted in Cloud: opens only once this tab holds its key. */
  encrypted?: boolean
  lastOpenedAt: number
}

const REGISTRY_KEY = 'zn-browser:vaults'
const CURRENT_KEY = 'zn-browser:current-vault'
const UNSYNCED_PREFIX = 'zn-browser:unsynced:'

function parseRegistry(raw: unknown): BrowserVaultEntry[] {
  if (typeof raw !== 'string') return []
  try {
    const value = JSON.parse(raw) as unknown
    if (!Array.isArray(value)) return []
    return value.filter((entry): entry is BrowserVaultEntry => {
      const candidate = entry as Partial<BrowserVaultEntry> | null
      return !!candidate && typeof candidate.key === 'string' && isValidVaultKey(candidate.key) &&
        typeof candidate.name === 'string' && (candidate.kind === 'try' || candidate.kind === 'cloud') &&
        typeof candidate.lastOpenedAt === 'number'
    })
  } catch {
    return []
  }
}

export async function listBrowserVaults(): Promise<BrowserVaultEntry[]> {
  return parseRegistry(await idbGet<string>('preferences', REGISTRY_KEY))
}

export async function findBrowserVault(key: string): Promise<BrowserVaultEntry | null> {
  return (await listBrowserVaults()).find((entry) => entry.key === key) ?? null
}

async function updateRegistry(change: (entries: BrowserVaultEntry[]) => BrowserVaultEntry[]): Promise<BrowserVaultEntry[]> {
  const next = await idbUpdate<string>('preferences', REGISTRY_KEY, (current) => JSON.stringify(change(parseRegistry(current))))
  return parseRegistry(next)
}

export async function saveBrowserVault(entry: BrowserVaultEntry): Promise<void> {
  await updateRegistry((entries) => [...entries.filter((candidate) => candidate.key !== entry.key), entry])
}

export async function touchBrowserVault(key: string): Promise<void> {
  await updateRegistry((entries) =>
    entries.map((entry) => (entry.key === key ? { ...entry, lastOpenedAt: Date.now() } : entry))
  )
}

export async function removeBrowserVaults(keys: readonly string[]): Promise<void> {
  const drop = new Set(keys)
  await updateRegistry((entries) => entries.filter((entry) => !drop.has(entry.key)))
}

export async function currentBrowserVaultKey(): Promise<string | null> {
  const value = await idbGet<string>('preferences', CURRENT_KEY)
  return typeof value === 'string' && isValidVaultKey(value) ? value : null
}

export async function setCurrentBrowserVaultKey(key: string | null): Promise<void> {
  await idbUpdate<string | undefined>('preferences', CURRENT_KEY, () => key ?? undefined)
}

/** The OPFS folder and lock key of a Cloud vault: its id, made safe. */
export function cloudVaultKey(vaultId: string): string {
  const safe = vaultId.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '')
  const key = `cloud-${safe}`.slice(0, 64)
  if (!isValidVaultKey(key) || safe.length === 0) throw new Error('That ZenNotes Cloud vault id cannot name a folder in this browser.')
  return key
}

/** The Cloud vaults of one account, and of every other account. */
export function vaultsOfAccount(entries: BrowserVaultEntry[], account: BrowserVaultAccount): {
  mine: BrowserVaultEntry[]
  others: BrowserVaultEntry[]
} {
  const same = (entry: BrowserVaultEntry) =>
    entry.kind === 'cloud' && !!entry.account &&
    entry.account.baseUrl === account.baseUrl &&
    entry.account.email.toLowerCase() === account.email.toLowerCase()
  return {
    mine: entries.filter(same),
    others: entries.filter((entry) => entry.kind === 'cloud' && !same(entry))
  }
}

/** Marks a vault as holding changes Cloud has not received (set when it
 *  changes, cleared when a sync run finishes after the last change). */
export async function markVaultUnsynced(key: string, unsynced: boolean): Promise<void> {
  await idbUpdate<string | undefined>('preferences', `${UNSYNCED_PREFIX}${key}`, () => (unsynced ? new Date().toISOString() : undefined))
}

export async function isVaultUnsynced(key: string): Promise<boolean> {
  return typeof (await idbGet<string>('preferences', `${UNSYNCED_PREFIX}${key}`)) === 'string'
}

export function unsyncedPreferenceKey(key: string): string {
  return `${UNSYNCED_PREFIX}${key}`
}
