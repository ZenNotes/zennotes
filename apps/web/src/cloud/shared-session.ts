/**
 * Signing in on a shared computer (docs/ideas/cloud-in-browser.md, "Shared
 * computers"): nothing should stay behind once the person is gone.
 *
 * - The sign-in lives in this tab's `sessionStorage` and memory, never in
 *   IndexedDB, so closing the tab forgets it.
 * - The copy in OPFS cannot be made to forget by itself, so it is marked as
 *   belonging to one browser session: a record in IndexedDB names the session,
 *   and the tab carries the same id in `sessionStorage`.
 * - A tab in the session holds a Web Lock for as long as it lives. The next
 *   load that does not carry the id looks at that lock: nobody holding it means
 *   the session was closed without signing out, and the copy is wiped before
 *   anything is drawn. Somebody holding it means the person still has the
 *   session open in another tab, and nothing is touched.
 *
 * The record is the last thing a wipe deletes, so a wipe cut short runs again.
 */
import { idbGet, idbPut, idbDelete } from './idb'

export const SHARED_SESSION_RECORD_KEY = 'zn-browser:shared-session'
const LOCK_PREFIX = 'zennotes:shared-session:'
const MARKER_KEY = 'zn-browser:shared-session'
const CREDENTIAL_KEY = 'zn-browser:shared-credential'
const INTENT_KEY = 'zn-browser:shared-intent'

export interface SharedSessionRecord {
  id: string
  startedAt: number
}

function readSession(key: string): string | null {
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}

function writeSession(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value)
  } catch {
    // Blocked storage: the sign-in lasts as long as this page does.
  }
}

function removeSession(key: string): void {
  try {
    sessionStorage.removeItem(key)
  } catch {
    // Blocked storage held nothing.
  }
}

function parseRecord(raw: unknown): SharedSessionRecord | null {
  if (typeof raw !== 'string') return null
  try {
    const value = JSON.parse(raw) as Partial<SharedSessionRecord> | null
    return value && typeof value.id === 'string' && value.id && typeof value.startedAt === 'number'
      ? { id: value.id, startedAt: value.startedAt }
      : null
  } catch {
    return null
  }
}

/** Also read by the service worker, so it must stay free of page globals. */
export async function readSharedSessionRecord(): Promise<SharedSessionRecord | null> {
  return parseRecord(await idbGet<string>('preferences', SHARED_SESSION_RECORD_KEY))
}

export function sharedSessionLockName(id: string): string {
  return `${LOCK_PREFIX}${id}`
}

// ---------------------------------------------------------------------------
// The sign-in, in this tab only
// ---------------------------------------------------------------------------

let credentialInMemory: string | null = null

/** A credential the service recorded as a shared computer's. */
export function isSharedCredential(raw: string): boolean {
  try {
    const value = JSON.parse(raw) as { account?: { device?: { shared?: unknown } } } | null
    return value?.account?.device?.shared === true
  } catch {
    return false
  }
}

export function readSharedCredential(): string | null {
  credentialInMemory ??= readSession(CREDENTIAL_KEY)
  return credentialInMemory
}

export function writeSharedCredential(value: string): void {
  credentialInMemory = value
  writeSession(CREDENTIAL_KEY, value)
}

export function clearSharedCredential(): void {
  credentialInMemory = null
  removeSession(CREDENTIAL_KEY)
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

let activeId: string | null = null
let releaseLock: (() => void) | null = null

/** This tab is signed in as a shared computer. */
export function isSharedSession(): boolean {
  return activeId !== null
}

/** Resolves once the lock is held, so no other load can find it free. */
async function holdSessionLock(id: string): Promise<void> {
  releaseLock?.()
  await new Promise<void>((granted, refused) => {
    navigator.locks
      .request(sharedSessionLockName(id), { mode: 'shared' }, () => {
        granted()
        return new Promise<void>((release) => {
          releaseLock = release
        })
      })
      .catch(refused)
  })
}

/** Marks everything from here on as this session's. Called after the sign-in
 *  is held in this tab and before any vault is opened. */
export async function beginSharedSession(now: () => number = Date.now): Promise<void> {
  const id = crypto.randomUUID()
  await idbPut('preferences', SHARED_SESSION_RECORD_KEY, JSON.stringify({ id, startedAt: now() } satisfies SharedSessionRecord))
  writeSession(MARKER_KEY, id)
  await holdSessionLock(id)
  activeId = id
  removeSession(INTENT_KEY)
}

export async function forgetSharedSessionRecord(): Promise<void> {
  await idbDelete('preferences', SHARED_SESSION_RECORD_KEY)
}

/** Stops this tab being part of the session; the page is about to reload. */
export function leaveSharedSession(): void {
  activeId = null
  releaseLock?.()
  releaseLock = null
  credentialInMemory = null
  removeSession(MARKER_KEY)
  removeSession(CREDENTIAL_KEY)
}

export type SharedSessionOutcome =
  /** No shared session in this browser. */
  | 'none'
  /** This tab belongs to the live session. */
  | 'member'
  /** The session is live in another tab, which this tab must leave alone. */
  | 'open-elsewhere'
  /** A closed session's copy was just wiped. */
  | 'wiped'

/**
 * What every load does first, before anything reads the vault registry or
 * draws. `wipe` runs under the session's lock, taken exclusively, so a tab
 * cannot join the session while its copy is being removed.
 */
export async function settleSharedSession(wipe: () => Promise<void>): Promise<SharedSessionOutcome> {
  const record = await readSharedSessionRecord()
  const marker = readSession(MARKER_KEY)
  if (!record) {
    // The copy this tab belonged to is already gone (another load wiped it
    // while this tab was discarded): its sign-in goes with it.
    if (marker) leaveSharedSession()
    return 'none'
  }
  if (marker === record.id && readSharedCredential() !== null) {
    await holdSessionLock(record.id)
    activeId = record.id
    return 'member'
  }
  const wiped = await navigator.locks.request(
    sharedSessionLockName(record.id),
    { mode: 'exclusive', ifAvailable: true },
    async (lock) => {
      if (!lock) return false
      await wipe()
      return true
    }
  )
  return wiped ? 'wiped' : 'open-elsewhere'
}

// ---------------------------------------------------------------------------
// The checkbox, across a failed sign-in
// ---------------------------------------------------------------------------

export function rememberSharedIntent(shared: boolean): void {
  if (shared) writeSession(INTENT_KEY, '1')
  else removeSession(INTENT_KEY)
}

/** The box stays ticked when a sign-in fails and is tried again. */
export function sharedIntent(): boolean {
  return readSession(INTENT_KEY) === '1'
}

/** For tests: this page's memory, as another tab has it. Whatever lock this
 *  page held stays held, as the first tab's does. */
export function resetSharedSessionForTests(): void {
  activeId = null
  releaseLock = null
  credentialInMemory = null
}
