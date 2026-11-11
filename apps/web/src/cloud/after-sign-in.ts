/**
 * What the page does once a sign-in it started finishes: today only "Keep it
 * in ZenNotes Cloud" from Try mode. It waits in IndexedDB because the sign-in
 * can finish in another tab (a new user's verification link opens one).
 *
 * It belongs to one sign-in: stamped with that sign-in's `state` as the page
 * leaves for the website, and kept only when a sign-in with the same state
 * finishes. Anyone else's sign-in drops it, so one person's abandoned "Keep
 * it in ZenNotes Cloud" never puts their Try notes into the next person's
 * account. A shared sign-in drops it too.
 */
import { idbDelete, idbGet, idbPut } from './idb'

const AFTER_SIGN_IN_KEY = 'zn-browser:after-sign-in'
/** A sign-in it waits for lasts as long as a sign-in does. */
export const AFTER_SIGN_IN_LIFETIME_MS = 60 * 60 * 1000

type Action = 'keep-try'

interface Intent {
  action: Action
  at: number
  /** The sign-in it belongs to. */
  state?: string
  /** That sign-in finished. */
  ready?: boolean
}

async function read(): Promise<Intent | null> {
  const raw = await idbGet<string>('preferences', AFTER_SIGN_IN_KEY).catch(() => undefined)
  if (typeof raw !== 'string') return null
  try {
    const value = JSON.parse(raw) as Partial<Intent> | null
    return value?.action === 'keep-try' && typeof value.at === 'number' ? (value as Intent) : null
  } catch {
    return null
  }
}

async function write(intent: Intent): Promise<void> {
  await idbPut('preferences', AFTER_SIGN_IN_KEY, JSON.stringify(intent))
}

export async function forgetAfterSignIn(): Promise<void> {
  await idbDelete('preferences', AFTER_SIGN_IN_KEY).catch(() => undefined)
}

function fresh(intent: Intent, now: number): boolean {
  return now - intent.at < AFTER_SIGN_IN_LIFETIME_MS
}

export async function rememberAfterSignIn(action: Action, now = Date.now()): Promise<void> {
  await write({ action, at: now })
}

/** The page is leaving for the website: the intent waits for this sign-in. */
export async function stampAfterSignIn(authorizationUrl: string, now = Date.now()): Promise<void> {
  const intent = await read()
  if (!intent || intent.state || !fresh(intent, now)) return
  let state: string | null = null
  try {
    state = new URL(authorizationUrl).searchParams.get('state')
  } catch {
    state = null
  }
  if (state) await write({ ...intent, state })
  else await forgetAfterSignIn()
}

/** A sign-in finished: keeps the intent only when it was this sign-in's. */
export async function settleAfterSignIn(state: string | null, now = Date.now()): Promise<boolean> {
  const intent = await read()
  if (!intent) return false
  if (!state || intent.state !== state || !fresh(intent, now)) {
    await forgetAfterSignIn()
    return false
  }
  await write({ ...intent, ready: true })
  return true
}

/** Takes the intent of a finished sign-in, once. */
export async function takeAfterSignIn(now = Date.now()): Promise<Action | null> {
  const intent = await read()
  if (!intent || !intent.ready) return null
  await forgetAfterSignIn()
  return fresh(intent, now) ? intent.action : null
}
