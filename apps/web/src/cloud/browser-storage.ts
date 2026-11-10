/**
 * Losing nothing (docs/ideas/cloud-in-browser.md): what this browser keeps,
 * whether it promised to keep it, and the attachments it holds.
 *
 * - Persistence is asked for once, after the first sync of a Cloud vault
 *   (`navigator.storage.persist()` is a page API). Chrome and Safari answer
 *   no on a first visit and yes later, with use or once installed; Firefox
 *   asks the person. "May be cleared" is the normal state.
 * - "Keep attachments in this browser" (a preference here) turns stubbing
 *   off: new attachments download in full, nothing is turned back into a
 *   stub, and the ones still in Cloud only download in the background.
 * - Under storage pressure synced attachments go back to stubs, the ones
 *   opened longest ago first (the time of the last open or download, kept
 *   here per vault).
 * - On a shared computer attachments are always stubs and download per
 *   session, and nothing asks the browser to keep what sign-out removes.
 */
import type { BrowserStorageStatus } from '@zennotes/bridge-contract/bridge'
import { idbGet, idbPut, idbUpdate } from './idb'
import { isSharedSession } from './shared-session'

const KEEP_ATTACHMENTS_KEY = 'zn-browser:keep-attachments'
const PERSIST_ASKED_KEY = 'zn-browser:persist-asked'
const OPENED_PREFIX = 'zn-browser:opened:'
/** Above this share of the quota, synced attachments go back to stubs until
 *  usage is back under the second figure. */
const PRESSURE_HIGH = 0.85
const PRESSURE_LOW = 0.7

let keepAttachments = false
let keepAttachmentsLoaded = false

/** Read once at boot; the stub policy asks synchronously for every revision. */
export async function loadKeepAttachments(): Promise<boolean> {
  try {
    keepAttachments = (await idbGet<string>('preferences', KEEP_ATTACHMENTS_KEY)) === 'on'
  } catch {
    keepAttachments = false
  }
  keepAttachmentsLoaded = true
  return keepAttachments
}

export function keepsAttachments(): boolean {
  return keepAttachmentsLoaded && keepAttachments && !isSharedSession()
}

export async function setKeepAttachments(keep: boolean): Promise<void> {
  await idbPut('preferences', KEEP_ATTACHMENTS_KEY, keep ? 'on' : 'off')
  keepAttachments = keep
  keepAttachmentsLoaded = true
}

export async function storageEstimate(): Promise<{ usage: number | null; quota: number | null }> {
  try {
    const estimate = await navigator.storage?.estimate?.()
    return {
      usage: typeof estimate?.usage === 'number' ? estimate.usage : null,
      quota: typeof estimate?.quota === 'number' ? estimate.quota : null
    }
  } catch {
    return { usage: null, quota: null }
  }
}

export async function isPersisted(): Promise<boolean> {
  try {
    return (await navigator.storage?.persisted?.()) === true
  } catch {
    return false
  }
}

export async function browserStorageStatus(cloudOnlyAttachments: number): Promise<BrowserStorageStatus> {
  const [persisted, estimate] = await Promise.all([isPersisted(), storageEstimate()])
  return {
    persisted,
    canRequestPersistence: typeof navigator.storage?.persist === 'function',
    usageBytes: estimate.usage,
    quotaBytes: estimate.quota,
    keepAttachments: keepsAttachments(),
    cloudOnlyAttachments,
    ...(isSharedSession() ? { sharedComputer: true } : {})
  }
}

/** Asks the browser to keep this site's data. True when it now will. */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (await isPersisted()) return true
    if (typeof navigator.storage?.persist !== 'function') return false
    return (await navigator.storage.persist()) === true
  } catch {
    return false
  }
}

/** After a Cloud vault's first sync: ask once per browser. */
export async function persistAfterFirstSync(): Promise<void> {
  if (isSharedSession()) return
  const asked = await idbGet<string>('preferences', PERSIST_ASKED_KEY).catch(() => undefined)
  if (asked) return
  await idbPut('preferences', PERSIST_ASKED_KEY, new Date().toISOString()).catch(() => undefined)
  await requestPersistence()
}

// ---------------------------------------------------------------------------
// Opened attachments
// ---------------------------------------------------------------------------

type OpenedTimes = Record<string, number>

const pendingOpened = new Map<string, OpenedTimes>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

function parseOpened(raw: unknown): OpenedTimes {
  if (typeof raw !== 'string') return {}
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as OpenedTimes) : {}
  } catch {
    return {}
  }
}

/** Notes that an attachment was opened or downloaded now (kept in batches). */
export function recordAttachmentOpened(vaultKey: string, path: string): void {
  const times = pendingOpened.get(vaultKey) ?? {}
  times[path] = Date.now()
  pendingOpened.set(vaultKey, times)
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushOpened()
  }, 2000)
}

async function flushOpened(): Promise<void> {
  const batches = [...pendingOpened.entries()]
  pendingOpened.clear()
  for (const [vaultKey, times] of batches) {
    await idbUpdate<string>('preferences', `${OPENED_PREFIX}${vaultKey}`, (current) =>
      JSON.stringify({ ...parseOpened(current), ...times })
    ).catch(() => undefined)
  }
}

/** Paths in the order eviction takes them: opened longest ago first, and
 *  never-opened ones (by the file's own time, passed in) by that time. */
export async function evictionOrder(
  vaultKey: string,
  candidates: Array<{ path: string; mtime: number }>
): Promise<string[]> {
  await flushOpened()
  const opened = parseOpened(await idbGet<string>('preferences', `${OPENED_PREFIX}${vaultKey}`).catch(() => undefined))
  const when = (candidate: { path: string; mtime: number }) => Math.max(opened[candidate.path] ?? 0, candidate.mtime)
  return [...candidates].sort((left, right) => when(left) - when(right)).map((candidate) => candidate.path)
}

/** How many bytes to free now, or 0 when the browser has room. */
export async function bytesOverPressure(): Promise<number> {
  const { usage, quota } = await storageEstimate()
  if (usage === null || quota === null || quota <= 0) return 0
  if (usage / quota < PRESSURE_HIGH) return 0
  return Math.max(0, Math.ceil(usage - quota * PRESSURE_LOW))
}
