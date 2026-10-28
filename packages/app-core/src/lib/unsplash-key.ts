/**
 * Whether an Unsplash access key is set, shared by the cover picker and
 * Settings. The renderer never holds the key: the host keeps it (desktop
 * main in the system's secure storage, the web client in its browser) and
 * answers only whether there is one. This keeps that answer, in memory and
 * nowhere else, so a picker opened again knows at once.
 */
import { useEffect, useSyncExternalStore } from 'react'
import type {
  UnsplashKeyCheck,
  UnsplashKeySaveResult,
  UnsplashKeyStatus,
  UnsplashKeyStore
} from '@zennotes/bridge-contract/unsplash'
import { UNSPLASH_DEMO_HOURLY_LIMIT } from '@shared/unsplash'
import { useStore } from '../store'
import { requestSettingsTarget } from './settings-navigation'

let status: UnsplashKeyStatus | null = null
let asking: Promise<void> | null = null
const listeners = new Set<() => void>()

/** Whether this host takes an Unsplash key (the desktop app and the web
 *  client; the phone shells have no Unsplash tab). */
export function unsplashKeySupported(): boolean {
  return typeof window.zen?.getUnsplashKeyStatus === 'function'
}

export function setUnsplashKeyStatus(next: UnsplashKeyStatus | null): void {
  status = next
  for (const listener of listeners) listener()
}

/** Ask the host again: on opening, and after a search says there is no key. */
export function refreshUnsplashKeyStatus(): Promise<void> {
  const get = window.zen?.getUnsplashKeyStatus
  if (!get) return Promise.resolve()
  asking ??= get()
    .then(setUnsplashKeyStatus, () => {})
    .finally(() => {
      asking = null
    })
  return asking
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const snapshot = (): UnsplashKeyStatus | null => status

/** The key's status, null until the host first answers. */
export function useUnsplashKeyStatus(): UnsplashKeyStatus | null {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot)
  useEffect(() => {
    if (unsplashKeySupported()) void refreshUnsplashKeyStatus()
  }, [])
  return current
}

/** Settings, landing on the Unsplash access key field (the picker's setup
 *  panel and Change key, the palette). */
export function openUnsplashKeySettings(): void {
  requestSettingsTarget('unsplash')
  useStore.getState().setSettingsOpen(true)
}

export function unsplashKeyPlace(store: UnsplashKeyStore | undefined): string {
  return store === 'browser' ? 'this browser' : 'your system’s secure storage'
}

/** What a spent allowance means: a new Unsplash app gets 50 requests an
 *  hour until Unsplash approves it for production. */
export function unsplashRateLimitSentence(limit: number | null): string {
  return limit && limit > UNSPLASH_DEMO_HOURLY_LIMIT
    ? `Your Unsplash app has used its ${limit.toLocaleString()} requests for this hour.`
    : `Your Unsplash app has used this hour’s requests: a new Unsplash app allows ${UNSPLASH_DEMO_HOURLY_LIMIT} an hour until Unsplash approves it for production.`
}

export interface UnsplashKeyMessage {
  tone: 'ok' | 'warn' | 'error'
  text: string
}

function allowanceLeft(check: Extract<UnsplashKeyCheck, { ok: true }>): string {
  return check.remaining != null && check.limit != null
    ? `: ${check.remaining.toLocaleString()} of ${check.limit.toLocaleString()} requests left this hour`
    : ''
}

/** What Settings says after Test, or after a save that kept the key. */
export function unsplashKeyCheckMessage(check: UnsplashKeyCheck, after: 'save' | 'test'): UnsplashKeyMessage {
  const saved = after === 'save'
  if (check.ok) {
    return { tone: 'ok', text: saved ? `Saved. Unsplash accepted the key${allowanceLeft(check)}.` : `The key works${allowanceLeft(check)}.` }
  }
  switch (check.reason) {
    case 'rate-limited':
      return { tone: 'warn', text: `${saved ? 'Saved. ' : ''}${unsplashRateLimitSentence(check.limit)}` }
    case 'offline':
      return {
        tone: 'warn',
        text: saved
          ? 'Saved, but Unsplash could not be reached to check it. The Unsplash tab says so if Unsplash refuses it.'
          : 'Unsplash could not be reached. Check your connection and try again.'
      }
    case 'invalid-key':
      return { tone: 'error', text: 'Unsplash did not accept this key. Paste the Access Key again from your app at unsplash.com/oauth/applications.' }
    case 'no-key':
      return { tone: 'warn', text: 'No key is saved yet.' }
    default:
      return {
        tone: 'warn',
        text: saved
          ? 'Saved, but Unsplash did not answer as expected, so the key is not checked yet.'
          : 'Unsplash did not answer as expected. Try again in a moment.'
      }
  }
}

/** What Settings says when a pasted key was not saved. */
export function unsplashKeyRefusalMessage(
  reason: Extract<UnsplashKeySaveResult, { saved: false }>['reason'],
  store: UnsplashKeyStore | undefined,
  linux = false
): UnsplashKeyMessage {
  switch (reason) {
    case 'malformed':
      return {
        tone: 'error',
        text: 'That does not look like an Unsplash Access Key, so it was not saved. The key is one word of letters, digits, - and _.'
      }
    case 'invalid-key':
      return {
        tone: 'error',
        text: 'Unsplash did not accept that key, so it was not saved. Check that you copied the Access Key, not the Secret Key.'
      }
    case 'cannot-store':
      return {
        tone: 'error',
        text:
          store === 'browser'
            ? 'This browser would not keep the key: its site storage may be turned off.'
            : `ZenNotes could not store the key securely: this system has no secure storage it can use.${
                linux ? ' If a Secret Service keyring is running, launch ZenNotes with --password-store=gnome-libsecret.' : ''
              }`
      }
  }
}
