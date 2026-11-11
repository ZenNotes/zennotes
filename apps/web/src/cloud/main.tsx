/**
 * ZenNotes in your browser (app.zennotes.org): the second bootstrap of
 * apps/web, built by vite.cloud.config.ts into dist-cloud/. The self-hosted
 * build (../main.tsx) talks to a ZenNotes server; this one keeps each vault in
 * the browser's private file storage (OPFS) through
 * @zennotes/portable-vault, the layer the phones run, and syncs it with
 * ZenNotes Cloud as a `web` device.
 *
 * Routes (the website serves the shell at exactly these, CloudWebApp::APP_PATHS):
 * - `/`: the signed-in app. Opens this browser's Cloud vault (the one asked
 *   for with `?vault=`, else the last one), or asks to sign in, or to choose
 *   a Cloud vault to open here.
 * - `/try`: Try mode, a local vault seeded with the tour, in this browser
 *   only until it is kept in ZenNotes Cloud.
 * - `/auth/callback`: the website's answer to a sign-in, with the code in
 *   the fragment.
 *
 * Boot order:
 * 1. Refuse any origin but the configured one (and loopback for local runs).
 * 2. Take the sign-in callback out of the address bar before anything runs.
 * 3. Firefox private windows have no OPFS: say so and stop.
 * 4. A shared computer's copy left by a session that was closed without
 *    signing out is wiped, before anything reads it or is drawn.
 * 5. Take control by the service worker, or `/_vault/...` URLs would reach
 *    the network.
 * 6. The PDF export window (`?exportNote=`) reads a vault without owning it.
 * 7. Install the bridge and Cloud sign-in, then finish a callback, or open a
 *    vault under its Web Lock (or show "open in another tab" with Use here),
 *    and render the app. An end-to-end encrypted vault opens only once this
 *    tab holds its key: signed out or locked, it asks first.
 */
import '@renderer/styles/index.css'
import './cloud.css'
import { installZenBridge, type BrowserEncryptionPrefs, type ZenBridge } from '@zennotes/bridge-contract/bridge'
import type { CloudAccount, CloudAccountStatus, CloudEncryptionSecretInput, CloudSyncRunSummary } from '@zennotes/bridge-contract/cloud-sync'
import { DEMO_TOUR_START_PATH } from '@zennotes/shared-domain/demo-tour'
import { bootPortableVault, createPortableBridge, activePortableVault } from '@zennotes/portable-vault/bridge'
import {
  authenticatedClient,
  CloudSignInRefusedError,
  completeMobileCloudSignIn,
  configureMobileCloudAuth,
  connectMobileCloudAccount,
  getMobileCloudAccountStatus,
  listMobileCloudVaults,
  logoutMobileCloudAccount,
  refreshMobileCloudAccountStatus
} from '@zennotes/portable-vault/cloud-auth'
import {
  createAndLinkMobileCloudVault,
  evictMobileCloudAttachments,
  getMobileCloudVaultLink,
  hydrateAllMobileCloudStubs,
  hydrateMobileCloudStub,
  isMobileCloudVaultSyncing,
  linkMobileCloudVault,
  listMobileCloudStubs,
  syncMobileCloudVault
} from '@zennotes/portable-vault/cloud-sync'
import { stopMobileCloudRequests } from '@zennotes/portable-vault/cloud-sync-client'
import { isMobileCloudEncryptionUnlocked, unlockMobileCloudEncryption } from '@zennotes/portable-vault/cloud-encryption'
import { onVaultChange, requestOpenNote } from '@zennotes/portable-vault/events'
import { CLOUD_SIGN_IN_EXPIRED_MESSAGE, describeCloudError } from '@zennotes/shared-domain/cloud-error-copy'
import appPackage from '../../package.json'
import {
  closeBrowserVault,
  createBrowserHost,
  currentBrowserVault,
  openBrowserVault,
  type BrowserHostHooks
} from './browser-host'
import {
  encryptionNoticeSeen,
  forgetKeptAccountKeys,
  loadLockOnClose,
  locksOnClose,
  markEncryptionNoticeSeen,
  setLockOnClose
} from './browser-keys'
import { runningRelease } from './browser-release'
import {
  browserStorageStatus,
  bytesOverPressure,
  evictionOrder,
  keepsAttachments,
  loadKeepAttachments,
  persistAfterFirstSync,
  recordAttachmentOpened,
  requestPersistence,
  setKeepAttachments
} from './browser-storage'
import {
  chooseHomeVault,
  cloudVaultKey,
  currentBrowserVaultKey,
  findBrowserVault,
  isVaultUnsynced,
  listBrowserVaults,
  saveBrowserVault,
  setCurrentBrowserVaultKey,
  touchBrowserVault,
  TRY_VAULT_KEY,
  TRY_VAULT_NAME,
  vaultsOfAccount,
  type BrowserVaultEntry
} from './browser-vaults'
import {
  announceAccount,
  captureAuthCallback,
  CLOUD_WEB_NOT_ENABLED_MESSAGE,
  onAccountAnnouncement,
  SIGN_IN_ELSEWHERE_MESSAGE,
  type CallbackCapture
} from './cloud-account'
import {
  showAccountSwitch,
  showRemoved,
  showRemovalStuck,
  showSharedDiscard,
  showSharedEnded,
  showNotAvailable,
  showSharedOpenElsewhere,
  showSignedInElsewhere,
  showSignIn,
  showSignInFailed,
  showSigningIn,
  showUnlock,
  showVaultPicker,
  type PickableCloudVault,
  type SharedEndedReason
} from './cloud-screens'
import {
  clearForSharedSession,
  clearLocalState,
  finishLocalScrub,
  wipeBrowserCloudData,
  wipeEverythingInBrowser
} from './cloud-session'
import { buildVaultArchive, saveBlob, archiveFolderName } from './download-folder'
import { idbDelete, idbGet, idbPut } from './idb'
import { idbHostStorage } from './idb-storage'
import { clearScreen, showBootError, showNoStorage, showVaultTaken } from './screens'
import { renderSharedBanner } from './shared-banner'
import { forgetAfterSignIn, rememberAfterSignIn, settleAfterSignIn, stampAfterSignIn, takeAfterSignIn } from './after-sign-in'
import { applyTryVimDefault, dropTryVimDefault, vimModeChosenInTry } from './try-vim'
import { UnsyncedChanges } from './unsynced'
import { claimRemoval, claimSignOut, removalUnderway } from './departure'
import { attemptRemoval, readPendingRemoval, type PendingRemoval, type RemovalOutcome, type TabStorage } from './removal-retry'
import {
  beginSharedSession,
  forgetSharedSessionRecord,
  isSharedSession,
  leaveSharedSession,
  markSharedSessionClean,
  readSharedSessionRecord,
  rememberSharedIntent,
  settleSharedSession,
  sharedIntent,
  sharedSessionStarting
} from './shared-session'
import { ensureServiceWorkerControl, serveVaultToWorker, warmServiceWorkerCache, watchForUpdates } from './sw-register'
import { renderTryBanner, removeTryBanner } from './try-banner'
import { takeVaultHere, tryAcquireVault, vaultLocksSupported, type HeldVault } from './vault-lock'

const YIELDED_FLAG = 'zn:vault-yielded:'
const REMOVED_FLAG = 'zn:cloud-removed'
const WIPING_KEY = 'zn-browser:wiping'
/** The Cloud vault Try mode's notes go into. */
const KEPT_TRY_VAULT_NAME = 'My Notes'
/** Why a shared computer's session ended, as the next page shows it. */
const SHARED_ENDED_FLAGS: Record<string, SharedEndedReason> = {
  'shared-signed-out': 'signed-out',
  'shared-signed-out-offline': 'signed-out-offline',
  'shared-expired': 'expired'
}

const root = document.getElementById('root')
const bannerHost = document.getElementById('zn-host-banner')
if (!root || !bannerHost) throw new Error('The page is missing its #root or #zn-host-banner element')
const appRoot: HTMLElement = root
const bannerRoot: HTMLElement = bannerHost

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function originAllowed(): boolean {
  const configured = (import.meta.env.VITE_ZENNOTES_APP_ORIGIN as string | undefined) ?? 'https://app.zennotes.org'
  if (location.origin === configured) return true
  // A run on this machine (dev:cloud, preview:cloud) shares an origin with
  // nothing else of ZenNotes.
  return LOOPBACK_HOSTS.has(location.hostname) || location.hostname.endsWith('.localhost')
}

type StorageProbe = 'ok' | 'firefox-private' | 'unsupported'

async function probeStorage(): Promise<StorageProbe> {
  const firefox = /Firefox\//.test(navigator.userAgent)
  if (typeof navigator.storage?.getDirectory !== 'function') return 'unsupported'
  try {
    await navigator.storage.getDirectory()
  } catch {
    // Firefox private windows throw SecurityError here (spike F2).
    return firefox ? 'firefox-private' : 'unsupported'
  }
  if (typeof Worker === 'undefined' || typeof indexedDB === 'undefined' || !vaultLocksSupported()) {
    return 'unsupported'
  }
  return 'ok'
}

function sessionFlag(key: string, take = false): string | null {
  try {
    const value = sessionStorage.getItem(key)
    if (take) sessionStorage.removeItem(key)
    return value
  } catch {
    return null
  }
}

function setSessionFlag(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value)
  } catch {
    // storage blocked: the reload shows the default screen
  }
}

async function toast(message: string, tone: 'success' | 'error' | 'info' = 'info'): Promise<void> {
  const { useToastStore } = await import('@renderer/lib/toast')
  useToastStore.getState().addToast(message, tone)
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

// ---------------------------------------------------------------------------
// The tab's vault
// ---------------------------------------------------------------------------

interface VaultTarget {
  entry: BrowserVaultEntry
  held: HeldVault
  /** A Cloud vault opened here for the first time: link the new local copy. */
  joinVaultId?: string
}

let target: VaultTarget | null = null
let wiping = false
let yielding = false
let rendererReady = false
let releaseWorkerService: (() => void) | null = null
const afterReady: Array<() => void> = []

let syncing = 0
/** Whether the open vault holds changes Cloud has not received (unsynced.ts). */
let unsynced: UnsyncedChanges | null = null

function whenRendererReady(run: () => void): void {
  if (rendererReady) run()
  else afterReady.push(run)
}

/**
 * Runs once the app has a vault and has restored its workspace. A note asked
 * for earlier waits in App's queue, which drops it if the store's vault
 * object changes before the workspace is back; asked for now, App opens it
 * at once.
 */
function whenWorkspaceReady(run: () => void): void {
  whenRendererReady(() => {
    void import('@renderer/store').then(({ useStore }) => {
      const ready = (): boolean => {
        const state = useStore.getState()
        return !!state.vault && state.workspaceRestored && !state.workspaceTransitioning
      }
      if (ready()) {
        run()
        return
      }
      const stop = useStore.subscribe(() => {
        if (!ready()) return
        stop()
        run()
      })
    })
  })
}

async function flushEditors(): Promise<void> {
  if (!rendererReady) return
  try {
    const { useStore } = await import('@renderer/store')
    await useStore.getState().flushDirtyNotes()
  } catch (error) {
    console.warn('[zen] saving open notes failed', error)
  }
}

async function hasUnsavedText(): Promise<boolean> {
  if (!rendererReady) return false
  const { useStore } = await import('@renderer/store')
  return Object.values(useStore.getState().noteDirty).some(Boolean)
}

/** Whether the open vault is linked to the signed-in account. */
async function openVaultIsSynced(): Promise<boolean> {
  try {
    const status = await getMobileCloudAccountStatus()
    if (status.state !== 'connected' || !status.account) return false
    const link = await getMobileCloudVaultLink(activePortableVault())
    return !!link && link.base_url === status.account.base_url
  } catch {
    return false
  }
}

/** One sync run of the open vault, outside app-core's status: the final
 *  push when the tab hides or signs out. Bounded, best effort. */
async function finalPush(timeoutMs: number): Promise<void> {
  if (!target || wiping) return
  await flushEditors()
  if (!(await openVaultIsSynced())) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const run = (): Promise<CloudSyncRunSummary> => syncMobileCloudVault(activePortableVault())
  await Promise.race([
    (async () => {
      syncing += 1
      try {
        // Joined to a run the edit started, it goes once more, fresh.
        if (unsynced) await unsynced.pushUntilSettled(run)
        else await run()
      } finally {
        syncing -= 1
      }
    })().catch((error: unknown) => {
      console.warn('[zen] the final push did not finish', error)
    }),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    })
  ])
  if (timer) clearTimeout(timer)
}

async function trackedSync(run: () => Promise<CloudSyncRunSummary>): Promise<CloudSyncRunSummary> {
  syncing += 1
  try {
    return unsynced ? await unsynced.track(run) : await run()
  } finally {
    syncing -= 1
  }
}

async function afterSyncRun(summary: CloudSyncRunSummary): Promise<void> {
  void summary
  // Ask to be kept once the vault is here, and make room when the browser
  // is short of it.
  void persistAfterFirstSync()
  const over = await bytesOverPressure()
  if (over > 0 && !keepsAttachments()) await evictForSpace(over).catch(() => undefined)
}

async function evictForSpace(targetBytes?: number): Promise<{ stubbed: number; freedBytes: number }> {
  if (!target) return { stubbed: 0, freedBytes: 0 }
  const key = target.entry.key
  return evictMobileCloudAttachments(activePortableVault(), {
    ...(targetBytes !== undefined ? { targetBytes } : {}),
    order: (candidates) => evictionOrder(key, candidates)
  })
}

async function cloudOnlyAttachmentCount(): Promise<number> {
  if (!target) return 0
  try {
    return (await listMobileCloudStubs(activePortableVault())).length
  } catch {
    return 0
  }
}

async function downloadCurrentVault(): Promise<void> {
  const open = currentBrowserVault()
  if (!open) throw new Error('No vault is open.')
  const { blob, fileCount, leftOut } = await buildVaultArchive(open.fs, open.spec.name)
  const fileName = `${archiveFolderName(open.spec.name)}.zip`
  saveBlob(blob, fileName)
  await toast(
    leftOut.length > 0
      ? `Downloaded ${fileName} without ${leftOut.length} ${leftOut.length === 1 ? 'attachment that is' : 'attachments that are'} only in ZenNotes Cloud. “Not included.txt” in the zip names them.`
      : `Downloaded ${fileName} (${fileCount} ${fileCount === 1 ? 'file' : 'files'}). Unzip it and open the folder as a vault in the app.`,
    leftOut.length > 0 ? 'info' : 'success'
  )
}

/** The website, when no account is left to say which one. */
function cloudSiteUrl(): string {
  const development = (import.meta.env.VITE_ZENNOTES_CLOUD_DEV_URL as string | undefined)?.trim().replace(/\/+$/, '')
  return development || 'https://zennotes.org'
}

/** Where the security page explains what unlocking in a browser trusts. */
async function securityPageUrl(): Promise<string> {
  const status = await getMobileCloudAccountStatus().catch(() => null)
  return `${status?.account?.base_url ?? 'https://zennotes.org'}/security#browser`
}

async function browserEncryptionPrefs(): Promise<BrowserEncryptionPrefs> {
  return {
    lockOnClose: locksOnClose(),
    noticeSeen: await encryptionNoticeSeen(),
    securityUrl: await securityPageUrl(),
    ...(isSharedSession() ? { sharedComputer: true } : {})
  }
}

/** An encrypted vault lost its key while open (locked or signed out): the
 *  tab goes back through the gate instead of staying on the notes. */
function leaveLockedVault(): void {
  if (!target?.entry.encrypted || wiping) return
  yielding = true
  location.replace(`/?vault=${encodeURIComponent(target.entry.key)}`)
}

/** The portable bridge, with what a browser does its own way. */
function browserBridge(base: ZenBridge): ZenBridge {
  return {
    ...base,
    // The print view opens in a window of its own, as in the self-hosted
    // build; it reads the vault without owning it (export-bridge.ts).
    exportNotePdf: async (relPath) => {
      const url = new URL(location.href)
      url.search = ''
      url.hash = ''
      url.searchParams.set('exportNote', relPath)
      if (target) url.searchParams.set('vault', target.entry.key)
      const exportWindow = window.open(url.toString(), 'zennotes-pdf-export')
      if (!exportWindow) {
        throw new Error('ZenNotes could not open the PDF export window. Allow pop-ups for this site and try again.')
      }
      exportWindow.focus()
      return null
    },
    downloadVaultArchive: () => downloadCurrentVault(),
    notifyRendererReady: () => {
      base.notifyRendererReady()
      rendererReady = true
      for (const run of afterReady.splice(0)) run()
    },
    syncCloudVault: async () => {
      const summary = await trackedSync(() => base.syncCloudVault())
      void afterSyncRun(summary)
      return summary
    },
    logoutCloudAccount: async () => {
      if (isSharedSession()) return leaveSharedComputer()
      // Push what is waiting while the sign-in still works; the copy stays.
      await finalPush(15_000)
      const status = await base.logoutCloudAccount()
      announceAccount({ type: 'signed-out' })
      leaveLockedVault()
      return status
    },
    linkCloudVault: async (vaultId) => {
      const vault = (await base.listCloudVaults()).find((candidate) => candidate.id === vaultId)
      const link = await base.linkCloudVault(vaultId)
      await rememberCloudLink(link.vault_id, vault?.name, !!vault?.encryption)
      return link
    },
    createAndLinkCloudVault: async (name, options) => {
      const link = await base.createAndLinkCloudVault(name, options)
      await rememberCloudLink(link.vault_id, name, options?.encrypted === true)
      return link
    },
    unlockCloudEncryption: async (secret) => {
      await base.unlockCloudEncryption!(secret)
      await markEncryptionNoticeSeen()
    },
    finishCloudEncryptionSetup: async (setupId) => {
      await base.finishCloudEncryptionSetup!(setupId)
      await markEncryptionNoticeSeen()
    },
    lockCloudEncryption: async () => {
      // Pushed while the key can still seal it; what cannot go waits here.
      await finalPush(15_000)
      await base.lockCloudEncryption!()
      announceAccount({ type: 'locked' })
      leaveLockedVault()
    },
    getBrowserEncryptionPrefs: browserEncryptionPrefs,
    setBrowserLockOnClose: async (lock) => {
      await setLockOnClose(lock)
      return browserEncryptionPrefs()
    },
    getBrowserRelease: () => runningRelease(),
    isSharedComputerSession: () => isSharedSession(),
    openBrowserUnlock: async () => {
      await flushEditors()
      location.assign(`/?unlock=1${target ? `&vault=${encodeURIComponent(target.entry.key)}` : ''}`)
    },
    getBrowserStorageStatus: async () => browserStorageStatus(await cloudOnlyAttachmentCount()),
    requestBrowserStoragePersistence: async () => {
      await requestPersistence()
      return browserStorageStatus(await cloudOnlyAttachmentCount())
    },
    setBrowserKeepAttachments: async (keep) => {
      if (isSharedSession()) return browserStorageStatus(await cloudOnlyAttachmentCount())
      await setKeepAttachments(keep)
      // Kept from now on: what is still only in Cloud comes down too.
      if (keep && target) void hydrateAllMobileCloudStubs(activePortableVault()).catch(() => undefined)
      return browserStorageStatus(await cloudOnlyAttachmentCount())
    },
    downloadBrowserAttachments: async () => {
      if (isSharedSession()) throw new Error('On a shared computer, attachments download when you open them.')
      if (!target) throw new Error('No vault is open.')
      const result = await hydrateAllMobileCloudStubs(activePortableVault())
      return { changed: result.hydrated, failed: result.failed.length, status: await browserStorageStatus(await cloudOnlyAttachmentCount()) }
    },
    freeBrowserSpace: async () => {
      const result = await evictForSpace()
      if (result.stubbed > 0) await activePortableVault().rescan()
      return {
        changed: result.stubbed,
        failed: 0,
        freedBytes: result.freedBytes,
        status: await browserStorageStatus(await cloudOnlyAttachmentCount())
      }
    },
    chooseCloudVaultInBrowser: async () => {
      await flushEditors()
      location.assign('/?choose=1')
    },
    ...(target?.entry.kind === 'try' ? { keepVaultInCloud: () => keepTryVaultInCloud() } : {})
  }
}

/** A vault linked from app-core's Cloud settings becomes one of this
 *  browser's Cloud vaults, under the account that linked it. */
async function rememberCloudLink(vaultId: string, name: string | undefined, encrypted: boolean): Promise<void> {
  if (!target) return
  const status = await getMobileCloudAccountStatus()
  if (status.state !== 'connected' || !status.account) return
  const entry: BrowserVaultEntry = {
    ...target.entry,
    kind: 'cloud',
    vaultId,
    name: name ?? target.entry.name,
    account: accountOf(status.account),
    encrypted: encrypted || undefined,
    lastOpenedAt: Date.now()
  }
  target.entry = entry
  await saveBrowserVault(entry)
}

function accountOf(account: CloudAccount): { baseUrl: string; email: string } {
  return { baseUrl: account.base_url, email: account.user.email }
}

// ---------------------------------------------------------------------------
// Leaving the tab, handing it over, being removed
// ---------------------------------------------------------------------------

function takeYieldedFlag(vaultKey: string): boolean {
  return sessionFlag(YIELDED_FLAG + vaultKey, true) === '1'
}

/** Another tab pressed Use here, or took the lock: save, stop, step aside. */
async function yieldVault(held: HeldVault | null, saveFirst: boolean): Promise<void> {
  if (yielding || wiping) return
  yielding = true
  const key = target?.entry.key
  if (saveFirst) await flushEditors()
  releaseWorkerService?.()
  closeBrowserVault()
  held?.release()
  if (key) setSessionFlag(YIELDED_FLAG + key, '1')
  location.reload()
}

let leaveTimer: ReturnType<typeof setTimeout> | null = null

const hooks: BrowserHostHooks = {
  async beforeLeavingForSignIn(authorizationUrl) {
    await flushEditors()
    // "Keep it in ZenNotes Cloud" waits for this sign-in only.
    await stampAfterSignIn(authorizationUrl).catch(() => undefined)
  },
  leftApp() {
    // A hidden tab may be closed without another chance: push now. Typing
    // into a note keeps it visible, so this runs only on leaving.
    if (leaveTimer) clearTimeout(leaveTimer)
    leaveTimer = setTimeout(() => {
      leaveTimer = null
      void finalPush(30_000)
    }, 300)
  },
  returnedToApp() {
    if (leaveTimer) clearTimeout(leaveTimer)
    leaveTimer = null
  },
  revoked() {
    void removeThisBrowser('revoked')
  },
  webNotEnabled() {
    void browserNotAvailable()
  },
  signInEnded() {
    sharedSignInEnded = true
    // In the app, its own refusal handling signs out. A host screen has none.
    if (isSharedSession() && !rendererReady) void leaveSharedComputer()
  },
  deviceRevocationAnswered(revoked) {
    deviceRevocationReached = revoked
  },
  switchTo(entry) {
    void flushEditors().then(() => location.assign(`/?vault=${encodeURIComponent(entry.key)}`))
  }
}

/** Stops everything this tab does with the vault, before its files go. */
async function closeForWipe(): Promise<void> {
  wiping = true
  forgetKeptAccountKeys()
  stopMobileCloudRequests()
  try {
    const { stopCloudAutoSync } = await import('@renderer/lib/cloud-auto-sync')
    stopCloudAutoSync()
  } catch {
    // the app never started
  }
  releaseWorkerService?.()
  closeBrowserVault()
  target?.held.release()
}

let removing = false

/** Cloud removed this browser from the account: the copy goes, now. Every
 *  request in flight hears the same answer; the first starts the wipe. The
 *  caller's refusal handling signs out on the same answer, and stands aside
 *  (departure.ts). */
async function removeThisBrowser(reason: 'revoked'): Promise<void> {
  if (removing || wiping || !claimRemoval()) return
  removing = true
  const shared = isSharedSession()
  const outcome = await wipeForRemoval({ reason, shared }, closeForWipe)
  finishRemoval(outcome, reason, rendererReady ? null : appRoot)
}

function tabStorage(): TabStorage | null {
  try {
    return sessionStorage
  } catch {
    return null
  }
}

/** One try at the removal's wipe (removal-retry.ts). WIPING_KEY goes either
 *  way, so other tabs never wait out a wipe that failed. */
async function wipeForRemoval(
  removal: Pick<PendingRemoval, 'reason' | 'shared'>,
  closeOpenVault: () => void | Promise<void>
): Promise<RemovalOutcome> {
  await idbPut('preferences', WIPING_KEY, String(Date.now())).catch(() => undefined)
  try {
    return await attemptRemoval(tabStorage(), removal, () =>
      removal.shared
        ? wipeEverythingInBrowser({ closeOpenVault })
        : wipeBrowserCloudData({ closeOpenVault }, { reason: removal.reason })
    )
  } finally {
    await idbDelete('preferences', WIPING_KEY).catch(() => undefined)
  }
}

/** Removed: the reload says so. A failed try reloads, and the next load tries
 *  again before it opens anything; after a few, the tab stops and says so. */
function finishRemoval(outcome: RemovalOutcome, reason: 'revoked', stuckRoot: HTMLElement | null): void {
  if (outcome === 'stop') {
    showRemovalStuck(stuckRoot)
    return
  }
  if (outcome === 'removed') setSessionFlag(REMOVED_FLAG, reason)
  location.replace('/')
}

/** A removal this tab could not finish: its wipe goes first on this load,
 *  before anything else reads the vaults or opens one. */
async function retryPendingRemoval(pending: PendingRemoval): Promise<void> {
  removing = true
  claimRemoval()
  const outcome = await wipeForRemoval(pending, () => {})
  finishRemoval(outcome, pending.reason, appRoot)
}

// A shared computer's sign-out: what is waiting goes to Cloud first, or the
// person is asked; then this browser leaves the account and everything goes.

/** Cloud answered this sign-in with a plain 401: it ended, so nothing can
 *  push any more. */
let sharedSignInEnded = false
/** Whether the sign-out reached Cloud; null until it was tried. */
let deviceRevocationReached: boolean | null = null
let leavingShared: Promise<CloudAccountStatus> | null = null

async function unsyncedVaultNames(): Promise<string[]> {
  const names: string[] = []
  for (const entry of await listBrowserVaults()) {
    if (entry.kind === 'cloud' && (await isVaultUnsynced(entry.key))) names.push(entry.name)
  }
  return names
}

/** In the app, its own dialog. On a host screen (the vault picker, the
 *  unlock screen), a screen; staying goes back to where the person was. */
async function confirmDiscardingChanges(vaults: string[]): Promise<boolean> {
  if (!rendererReady) {
    return new Promise((resolve) => {
      showSharedDiscard(appRoot, { vaults, onDiscard: async () => resolve(true), onStay: () => location.reload() })
    })
  }
  const { confirmApp } = await import('@renderer/lib/confirm-requests')
  const names = vaults.join(', ')
  return confirmApp(
    sharedSignInEnded
      ? {
          title: 'Your sign-in ended',
          description: `${names} ${vaults.length === 1 ? 'has' : 'have'} changes that never reached ZenNotes Cloud. Download the vault first if you need them.`,
          confirmLabel: 'Remove them',
          cancelLabel: 'Keep this open',
          danger: true
        }
      : {
          title: 'Sign out without these changes?',
          description: `${names} ${vaults.length === 1 ? 'has' : 'have'} changes that never reached ZenNotes Cloud. Signing out removes them.`,
          confirmLabel: 'Remove them and sign out',
          cancelLabel: 'Stay signed in',
          danger: true
        }
  )
}

async function endSharedSession(): Promise<CloudAccountStatus> {
  if (sharedSignInEnded) await flushEditors()
  else await finalPush(15_000)
  // Cloud removed this browser while the push ran: its removal wipes, and
  // reloads into the screen that says so.
  if (removalUnderway()) return await new Promise<CloudAccountStatus>(() => {})
  const unsynced = await unsyncedVaultNames()
  if (unsynced.length > 0 && !(await confirmDiscardingChanges(unsynced))) return getMobileCloudAccountStatus()

  // From here a late "removed from your account" answer is this sign-out's own.
  if (!claimSignOut()) return await new Promise<CloudAccountStatus>(() => {})
  removing = true
  const expired = sharedSignInEnded
  await logoutMobileCloudAccount().catch((error: unknown) => {
    console.warn('[zen] signing out of Cloud failed', error)
  })
  await idbPut('preferences', WIPING_KEY, String(Date.now())).catch(() => undefined)
  try {
    await wipeEverythingInBrowser({ closeOpenVault: closeForWipe })
    setSessionFlag(
      REMOVED_FLAG,
      expired ? 'shared-expired' : deviceRevocationReached === true ? 'shared-signed-out' : 'shared-signed-out-offline'
    )
  } catch (error) {
    // The session's record is still there, and the sign-in is gone: the next
    // load starts the wipe over before it draws anything.
    console.warn('[zen] removing this browser\'s copy did not finish', error)
  }
  location.replace('/')
  return await new Promise<CloudAccountStatus>(() => {})
}

function leaveSharedComputer(): Promise<CloudAccountStatus> {
  // The sign-out a refused request asks for, after Cloud removed this browser:
  // the removal is already wiping, and its screen says why.
  if (removalUnderway()) return new Promise<CloudAccountStatus>(() => {})
  leavingShared ??= endSharedSession().finally(() => {
    leavingShared = null
  })
  return leavingShared
}

/**
 * Cloud no longer lets this account use ZenNotes in the browser (403
 * CLOUD_WEB_NOT_ENABLED on any call). Not a removal: this browser signs out
 * and keeps its copy, never a wipe, so signing in again later carries on
 * where it was. The screen goes over the running app; "Open my notes here"
 * takes it away and the notes stay usable here, signed out. On a shared
 * computer the copy stays only while this tab is open: closing it removes
 * the copy, as every closed shared session's is.
 */
let notAvailableShown = false

async function browserNotAvailable(): Promise<void> {
  if (notAvailableShown || removing || wiping) return
  notAvailableShown = true
  await flushEditors()
  stopMobileCloudRequests()
  try {
    const { stopCloudAutoSync } = await import('@renderer/lib/cloud-auto-sync')
    stopCloudAutoSync()
  } catch {
    // the app never started
  }
  // Signing out still works for a browser that is not allowed: it ends this
  // device on the service, and the credential leaves this browser.
  await logoutMobileCloudAccount().catch(() => undefined)
  announceAccount({ type: 'signed-out' })
  const shared = isSharedSession()
  let close = (): void => {}
  close = showNotAvailable(rendererReady ? null : appRoot, {
    keptHere: !shared,
    onOpenHere: rendererReady && !shared ? () => close() : null,
    onSignIn: async (asShared) => {
      close()
      await signIn(asShared)
    }
  })
}

/** A wipe another tab started finishes before this one reads the registry. */
async function waitForWipe(): Promise<void> {
  for (let waited = 0; waited < 30_000; waited += 250) {
    const started = Number(await idbGet<string>('preferences', WIPING_KEY).catch(() => undefined))
    if (!Number.isFinite(started) || started <= 0 || Date.now() - started > 120_000) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

async function waitForSharedRecordGone(): Promise<void> {
  for (let waited = 0; waited < 30_000; waited += 250) {
    if (!(await readSharedSessionRecord().catch(() => null))) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

let listeningForAccount = false

function listenForAccountChanges(): void {
  if (listeningForAccount) return
  listeningForAccount = true
  onAccountAnnouncement((message) => {
    if (message.type === 'wiped') {
      if (wiping) return
      void closeForWipe().then(() => {
        if (message.reason === 'shared-ended') {
          // Not this tab's sign-out to report: it starts over.
          leaveSharedSession()
          location.reload()
          return
        }
        setSessionFlag(REMOVED_FLAG, message.reason)
        location.replace('/')
      })
      return
    }
    // A key this tab held only in memory goes with the other tab's lock.
    if (message.type !== 'signed-in') forgetKeptAccountKeys()
    void refreshMobileCloudAccountStatus().catch(() => undefined)
    if (message.type !== 'signed-in' && target?.entry.encrypted) void flushEditors().then(leaveLockedVault)
  })
}

function installLeaveGuard(): void {
  window.addEventListener('beforeunload', (event) => {
    if (wiping || yielding) return
    // Unsaved text in an editor, or a sync pushing right now: the browser
    // asks in its own words. Saved changes stay in this browser either way.
    const dirty = rendererReady && (window as unknown as { __znDirty?: boolean }).__znDirty === true
    // On a shared computer closing also removes changes still waiting to sync.
    if (dirty || syncing > 0 || (isSharedSession() && unsynced?.pending === true)) {
      event.preventDefault()
      event.returnValue = ''
    }
  })
  // The guard is read synchronously; keep a cheap flag of unsaved text.
  whenRendererReady(() => {
    void import('@renderer/store').then(({ useStore }) => {
      const update = (): void => {
        ;(window as unknown as { __znDirty?: boolean }).__znDirty = Object.values(useStore.getState().noteDirty).some(Boolean)
      }
      update()
      useStore.subscribe(update)
    })
  })
}

// ---------------------------------------------------------------------------
// Opening a vault
// ---------------------------------------------------------------------------

async function openTarget(): Promise<void> {
  const current = target
  if (!current) throw new Error('No vault was chosen for this tab.')
  const { entry, held } = current
  await openBrowserVault({ key: entry.key, name: entry.name, generation: held.generation })
  const open = currentBrowserVault()!
  open.fs.setStubHydrator(async (path) => {
    const hydrated = await hydrateMobileCloudStub(activePortableVault(), path)
    if (hydrated) recordAttachmentOpened(entry.key, path)
    return hydrated
  })
  open.fs.setQuotaPressureHandler(async () => {
    if (keepsAttachments()) return
    await evictForSpace(await bytesOverPressure() || 64 * 1024 * 1024).catch(() => undefined)
  })
  if (current.joinVaultId) {
    await linkMobileCloudVault(activePortableVault(), current.joinVaultId)
    await saveBrowserVault(entry)
    current.joinVaultId = undefined
  }
  if (entry.kind === 'try') await seedTryVault()
}

async function seedTryVault(): Promise<void> {
  // The tour is seeded once per browser, through the same generateDemoTour
  // the apps' "Generate Demo Tour" command runs; deleting it later sticks.
  const preferences = idbHostStorage('preferences')
  const seededKey = `zn-browser:seeded:${TRY_VAULT_KEY}`
  if (await preferences.read(seededKey)) return
  const vault = activePortableVault()
  if ((await vault.listNotes()).length === 0) {
    await vault.generateDemoTour()
    whenWorkspaceReady(() => requestOpenNote(DEMO_TOUR_START_PATH))
  }
  await preferences.write(seededKey, new Date().toISOString())
}

async function startApp(entry: BrowserVaultEntry, held: HeldVault, joinVaultId?: string): Promise<void> {
  target = { entry, held, ...(joinVaultId ? { joinVaultId } : {}) }
  held.onUseHereRequest(() => void yieldVault(held, true))
  // Stolen after the timeout: whatever was in flight is fenced off already.
  void held.lost.then(() => {
    if (!wiping) void yieldVault(null, false)
  })

  installZenBridge(browserBridge(createPortableBridge(createBrowserHost(openTarget, hooks))))
  await configureMobileCloudAuth(appPackage.version)
  await bootPortableVault()
  releaseWorkerService = serveVaultToWorker(entry.key, {
    // The service worker serves an encrypted vault's files only while this
    // tab holds its key (vault-access.ts).
    unlocked: async () => !entry.encrypted || (!yielding && (await isMobileCloudEncryptionUnlocked().catch(() => false))),
    hydrate: async (path) => {
      const vault = activePortableVault()
      const hydrated = await hydrateMobileCloudStub(vault, path)
      if (hydrated) recordAttachmentOpened(entry.key, path)
      return hydrated || (await vault.fs.statVerified(path)) === 'file'
    },
    opened: (path) => recordAttachmentOpened(entry.key, path)
  })
  unsynced = new UnsyncedChanges(entry.key, undefined, () => {
    try {
      return isMobileCloudVaultSyncing(activePortableVault())
    } catch {
      return false
    }
  })
  await unsynced.restore()
  onVaultChange((event) => {
    if (event.scope === 'resync') return
    unsynced?.changed()
  })
  await setCurrentBrowserVaultKey(entry.key)
  await touchBrowserVault(entry.key)

  // Excalidraw loads its fonts from this base (the self-hosted build's #324 fix).
  ;(window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = `${import.meta.env.BASE_URL}excalidraw-assets/`

  const params = new URLSearchParams(location.search)
  const requestedNote = params.get('note')
  if (requestedNote && params.get('floating') !== '1') {
    // openNoteWindow opens notes in this tab; a `?note=` link does the same.
    params.delete('note')
    history.replaceState(null, '', `${location.pathname}${params.toString() ? `?${params}` : ''}${location.hash}`)
    whenWorkspaceReady(() => requestOpenNote(requestedNote))
  }

  if (isSharedSession()) {
    renderSharedBanner(bannerRoot, async () => {
      await leaveSharedComputer()
    })
  } else if (entry.kind === 'try') {
    renderTryBanner(bannerRoot, {
      onDownload: async () => {
        try {
          await downloadCurrentVault()
        } catch (error) {
          await toast(errorText(error, 'Could not download the vault.'), 'error')
        }
      },
      onKeep: () => keepTryVaultInCloud()
    })
  }
  installLeaveGuard()
  listenForAccountChanges()
  if (entry.kind === 'cloud') {
    await skipOnboardingForCloudVault()
    if (dropTryVimDefault()) await setVimModeIfLoaded(true)
  } else if (applyTryVimDefault()) {
    await setVimModeIfLoaded(false)
    // Changed by hand in Try, Vim mode is the person's own choice from then on.
    void import('@renderer/store').then(({ useStore }) => {
      let last = useStore.getState().vimMode
      const stop = useStore.subscribe((state) => {
        if (state.vimMode === last) return
        last = state.vimMode
        vimModeChosenInTry()
        stop()
      })
    })
  }

  const { renderZenNotesApp } = await import('@zennotes/app-core/main')
  renderZenNotesApp(appRoot)
  // After the app is up, never in its way.
  setTimeout(warmServiceWorkerCache, 5000)
  if (entry.kind === 'try' && (await takeAfterSignIn()) === 'keep-try') {
    whenWorkspaceReady(() => void keepTryVaultInCloud())
  }

  watchForUpdates(
    {
      offer(apply) {
        void import('@renderer/lib/toast').then(({ useToastStore }) => {
          useToastStore.getState().addToast('A new version of ZenNotes is ready.', 'info', {
            label: 'Reload to update',
            onClick: () => void apply()
          }, 30_000)
        })
      }
    },
    async () => {
      await flushEditors()
      // Never under a running sync, and never with text unsaved.
      return syncing === 0 && !(await hasUnsavedText())
    }
  )
}

/** The store may already have read the preference (a chunk the host screens
 *  share loads it): it is told too. */
async function setVimModeIfLoaded(on: boolean): Promise<void> {
  const { useStore } = await import('@renderer/store')
  if (useStore.getState().vimMode !== on) useStore.setState({ vimMode: on })
}

/**
 * A Cloud vault arrives with its own layout (its vault.json syncs), so the
 * onboarding wizard's one step for a profile with a vault, "Vault layout",
 * would only rewrite it, and every device would get the change. A new browser
 * profile opening a Cloud vault starts as onboarded; Try mode keeps the
 * wizard.
 */
async function skipOnboardingForCloudVault(): Promise<void> {
  const key = 'zen:prefs:v2'
  try {
    const raw = localStorage.getItem(key)
    const prefs = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    if (prefs.hasCompletedOnboarding !== true) {
      localStorage.setItem(key, JSON.stringify({ ...prefs, hasCompletedOnboarding: true }))
    }
  } catch {
    // storage blocked: the store is told below, for this tab
  }
  // A built app can load the store with a chunk the host screens share, so
  // it may have read the preference before the line above wrote it.
  const { useStore } = await import('@renderer/store')
  if (!useStore.getState().hasCompletedOnboarding) useStore.setState({ hasCompletedOnboarding: true })
}

/** Opens `entry` under its lock, or offers Use here when another tab has it. */
async function openEntry(entry: BrowserVaultEntry, joinVaultId?: string): Promise<void> {
  const movedAway = takeYieldedFlag(entry.key)
  const held = movedAway ? null : await tryAcquireVault(entry.key)
  if (held) {
    clearScreen()
    await startApp(entry, held, joinVaultId)
    return
  }
  showVaultTaken(appRoot, movedAway, async () => {
    const taken = await takeVaultHere(entry.key)
    clearScreen()
    await startApp(entry, taken, joinVaultId)
  })
}

// ---------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------

/** The host and Cloud sign-in, for the screens before a vault is open. */
async function installAccountOnly(): Promise<void> {
  installZenBridge(browserBridge(createPortableBridge(createBrowserHost(async () => {
    throw new Error('No vault was chosen for this tab.')
  }, hooks))))
  await configureMobileCloudAuth(appPackage.version)
}

async function signIn(shared: boolean): Promise<void> {
  rememberSharedIntent(shared)
  await connectMobileCloudAccount(undefined, shared ? { shared: true } : undefined)
}

function signInFailureMessage(error: unknown): string {
  if (error instanceof CloudSignInRefusedError && error.code === 'CLOUD_WEB_NOT_ENABLED') return CLOUD_WEB_NOT_ENABLED_MESSAGE
  const message = errorText(error, 'ZenNotes Cloud did not finish the sign-in.')
  // No pending sign-in for this state: started in another browser (or its
  // 45 minutes ran out). The shared flow's words name five minutes.
  if (message === CLOUD_SIGN_IN_EXPIRED_MESSAGE) return SIGN_IN_ELSEWHERE_MESSAGE
  return message
}

/** The state of the sign-in a callback answers. */
function callbackState(url: string): string | null {
  try {
    return new URLSearchParams(new URL(url).hash.replace(/^#/, '')).get('state')
  } catch {
    return null
  }
}

/**
 * One account per browser, and a shared computer's session starts empty:
 * before anything opens with this sign-in, the vaults it must not see leave
 * (another account's, or for a shared sign-in every earlier Cloud vault). It
 * asks first when some of them hold changes Cloud never got. Runs after the
 * exchange and again on any load that finds the switch unsettled (a reload or
 * a closed tab on the question), so no load opens another account's vault.
 * Resolves true once settled; false when the person kept the earlier copy
 * (the new sign-in was ended) or the page is leaving.
 */
async function settleAccountHere(account: CloudAccount): Promise<boolean> {
  const shared = isSharedSession()
  const vaultsHere = await listBrowserVaults()
  const leaving = shared
    ? (await sharedSessionStarting())
      ? vaultsHere.filter((entry) => entry.kind === 'cloud')
      : []
    : vaultsOfAccount(vaultsHere, accountOf(account)).others
  if (leaving.length === 0) {
    if (shared && (await sharedSessionStarting())) {
      await clearForSharedSession({ closeOpenVault: closeForWipe })
      wiping = false
      await markSharedSessionClean()
    }
    return true
  }
  const unsyncedNames: string[] = []
  for (const entry of leaving) if (await isVaultUnsynced(entry.key)) unsyncedNames.push(entry.name)
  const replace = async (): Promise<void> => {
    await idbPut('preferences', WIPING_KEY, String(Date.now())).catch(() => undefined)
    try {
      if (shared) await clearForSharedSession({ closeOpenVault: closeForWipe })
      else await wipeBrowserCloudData({ closeOpenVault: closeForWipe }, { entries: leaving, reason: 'account-switch' })
    } finally {
      await idbDelete('preferences', WIPING_KEY).catch(() => undefined)
    }
    wiping = false
    if (shared) await markSharedSessionClean()
  }
  if (unsyncedNames.length === 0) {
    await replace()
    return true
  }
  return new Promise<boolean>((resolve) => {
    showAccountSwitch(appRoot, {
      previousEmail: leaving[0]!.account?.email ?? 'the previous account',
      nextEmail: account.user.email,
      unsyncedVaults: unsyncedNames,
      sharedComputer: shared,
      onReplace: async () => {
        await replace()
        resolve(true)
      },
      onCancel: async () => {
        // The earlier copy stays as it was; the new sign-in ends here.
        await logoutMobileCloudAccount()
        if (shared) {
          leaveSharedSession()
          await forgetSharedSessionRecord()
        }
        announceAccount({ type: 'signed-out' })
        location.replace('/')
        resolve(false)
      }
    })
  })
}

/** The website sent the browser back with a code (or without one). */
async function finishSignIn(callback: CallbackCapture): Promise<void> {
  showSigningIn(appRoot)
  await installAccountOnly()
  if (!callback.hasCode) {
    showSignInFailed(appRoot, 'The sign-in was cancelled or did not finish. Sign in again to open your notes here.', signIn, sharedIntent())
    return
  }
  let account: CloudAccount
  try {
    const status = await completeMobileCloudSignIn(callback.url)
    if (status.state !== 'connected' || !status.account) throw new Error('ZenNotes Cloud did not finish the sign-in.')
    account = status.account
  } catch (error) {
    // Another tab may have finished this same sign-in a moment ago.
    const status = await getMobileCloudAccountStatus().catch(() => null)
    if (status?.state === 'connected') {
      showSignedInElsewhere(appRoot)
      return
    }
    showSignInFailed(appRoot, signInFailureMessage(error), signIn, sharedIntent())
    return
  }

  // A shared computer's session begins now, before anything else is decided:
  // its sign-in is already in this tab and must never sit here unrecorded.
  const shared = account.device.shared === true
  if (shared) {
    await beginSharedSession({ clean: false })
    // Nobody's "Keep it in ZenNotes Cloud" carries into a shared session.
    await forgetAfterSignIn()
  }
  const keepTry = shared ? false : await settleAfterSignIn(callbackState(callback.url))
  if (!(await settleAccountHere(account))) return
  announceAccount({ type: 'signed-in', email: account.user.email })
  location.replace(keepTry ? '/try' : '/')
}

// ---------------------------------------------------------------------------
// Try mode, kept in Cloud
// ---------------------------------------------------------------------------

/** "Keep it in ZenNotes Cloud": sign in if needed, then the Try vault goes
 *  into a new Cloud vault and becomes one of this browser's Cloud vaults. */
async function keepTryVaultInCloud(): Promise<void> {
  if (!target || target.entry.kind !== 'try') return
  const status = await getMobileCloudAccountStatus()
  if (status.state !== 'connected' || !status.account) {
    await flushEditors()
    await rememberAfterSignIn('keep-try')
    await connectMobileCloudAccount()
    return
  }
  try {
    await flushEditors()
    const link = await createAndLinkMobileCloudVault(activePortableVault(), KEPT_TRY_VAULT_NAME)
    const entry: BrowserVaultEntry = {
      ...target.entry,
      kind: 'cloud',
      name: KEPT_TRY_VAULT_NAME,
      vaultId: link.vault_id,
      account: accountOf(status.account),
      lastOpenedAt: Date.now()
    }
    target.entry = entry
    await saveBrowserVault(entry)
    removeTryBanner(bannerRoot)
    history.replaceState(null, '', `/?vault=${encodeURIComponent(entry.key)}`)
    const { requestCloudAutoSync } = await import('@renderer/lib/cloud-auto-sync')
    requestCloudAutoSync('vault-link')
    await toast(`Your notes are going into ZenNotes Cloud as “${KEPT_TRY_VAULT_NAME}”. Open them on any device you sign in on.`, 'success')
  } catch (error) {
    await toast(errorText(error, 'ZenNotes could not keep this vault in Cloud.'), 'error')
  }
}

// ---------------------------------------------------------------------------
// Home: the signed-in app
// ---------------------------------------------------------------------------

async function loadPickableVaults(): Promise<PickableCloudVault[]> {
  const here = new Set((await listBrowserVaults()).map((entry) => entry.vaultId).filter(Boolean))
  const unlocked = await isMobileCloudEncryptionUnlocked()
  return (await listMobileCloudVaults()).map((vault) => ({
    id: vault.id,
    name: vault.name,
    encrypted: !!vault.encryption,
    locked: !!vault.encryption && !unlocked,
    here: here.has(vault.id)
  }))
}

/** Unlocks with the passphrase or the recovery key, keeping the key where
 *  the person chose. Argon2id runs in its own worker (argon2-client.ts). */
async function unlockHere(secret: CloudEncryptionSecretInput, lockOnClose: boolean): Promise<void> {
  try {
    if (lockOnClose !== locksOnClose()) await setLockOnClose(lockOnClose)
    await unlockMobileCloudEncryption(secret)
  } catch (error) {
    throw new Error(describeCloudError(error, "That didn't work. Try again.").message)
  }
  await markEncryptionNoticeSeen()
}

async function signOutFromScreen(): Promise<void> {
  if (isSharedSession()) {
    await leaveSharedComputer()
    return
  }
  await logoutMobileCloudAccount()
  announceAccount({ type: 'signed-out' })
  location.replace('/')
}

/** Shows the unlock screen; resolves once this tab holds the key. */
async function askToUnlock(account: CloudAccount, vaultName: string | null): Promise<void> {
  const noticeUrl = (await encryptionNoticeSeen()) ? null : await securityPageUrl()
  await new Promise<void>((resolve) => {
    showUnlock(appRoot, {
      vaultName,
      email: account.user.email,
      noticeUrl,
      lockOnClose: locksOnClose(),
      sharedComputer: isSharedSession(),
      onUnlock: async (secret, lockOnClose) => {
        await unlockHere(secret, lockOnClose)
        resolve()
      },
      onOtherVaults: () => location.assign('/?choose=1'),
      onSignOut: signOutFromScreen
    })
  })
}

/**
 * Whether an encrypted vault may open in this tab: signed in and holding the
 * key, asking for whichever is missing first. Its copy here is plain files,
 * so this keeps it off the screen, not out of the browser's storage.
 */
async function passEncryptionGate(entry: BrowserVaultEntry): Promise<boolean> {
  await installAccountOnly()
  listenForAccountChanges()
  const status = await getMobileCloudAccountStatus()
  if (status.state !== 'connected' || !status.account) {
    showSignIn(appRoot, signIn, `“${entry.name}” is end-to-end encrypted. Sign in to unlock it.`)
    onAccountAnnouncement((message) => {
      if (message.type === 'signed-in') showSignedInElsewhere(appRoot)
    })
    return false
  }
  if (await isMobileCloudEncryptionUnlocked()) return true
  // Another tab signing out or locking meanwhile starts this over.
  const stop = onAccountAnnouncement((message) => {
    if (message.type !== 'signed-in') location.reload()
  })
  try {
    await askToUnlock(status.account, entry.name)
  } finally {
    stop()
  }
  return true
}

async function openCloudVault(vault: { id: string; name: string; encrypted?: boolean }, account: CloudAccount): Promise<void> {
  const key = cloudVaultKey(vault.id)
  const existing = await findBrowserVault(key)
  if (existing) {
    location.assign(`/?vault=${encodeURIComponent(key)}`)
    return
  }
  const entry: BrowserVaultEntry = {
    key,
    name: vault.name,
    kind: 'cloud',
    vaultId: vault.id,
    account: accountOf(account),
    encrypted: vault.encrypted || undefined,
    lastOpenedAt: Date.now()
  }
  history.replaceState(null, '', `/?vault=${encodeURIComponent(key)}`)
  await openEntry(entry, vault.id)
}

async function openHome(): Promise<void> {
  await waitForWipe()
  const removed = sessionFlag(REMOVED_FLAG, true)
  // Signed in, nothing opens until the vaults here are this account's: an
  // account switch left unsettled (a reload or a closed tab on the question)
  // is asked again rather than opened with the new sign-in.
  await installAccountOnly()
  const signedIn = await getMobileCloudAccountStatus()
  const account = signedIn.state === 'connected' ? signedIn.account : null
  if (account && !(await settleAccountHere(account))) return
  const entries = await listBrowserVaults()
  const params = new URLSearchParams(location.search)
  const wanted = params.get('vault')
  // "Unlock Encryption in This Browser": the screen, then back where it was.
  if (params.get('unlock') === '1') {
    history.replaceState(null, '', wanted ? `/?vault=${encodeURIComponent(wanted)}` : '/')
    await installAccountOnly()
    const account = (await getMobileCloudAccountStatus()).account
    if (account && !(await isMobileCloudEncryptionUnlocked())) {
      await askToUnlock(account, null)
      clearScreen()
    }
  }
  // "Open a ZenNotes Cloud Vault Here": the list, not the last vault.
  const choosing = params.get('choose') === '1'
  if (choosing) history.replaceState(null, '', '/')
  const lastKey = await currentBrowserVaultKey()
  const entry = choosing
    ? undefined
    : chooseHomeVault({ entries, wanted, lastKey, account: account ? accountOf(account) : null })
  if (entry) {
    // Signed in or not: a copy that was signed out (an expired sign-in) opens
    // as it is, and app-core asks to connect again. An encrypted one asks first.
    if (entry.encrypted && !(await passEncryptionGate(entry))) return
    await openEntry(entry)
    return
  }
  await installAccountOnly()
  listenForAccountChanges()
  if (removed === 'revoked' || removed === 'account-switch') {
    clearLocalState()
    showRemoved(appRoot, removed, signIn)
    return
  }
  const sharedEnded = removed ? SHARED_ENDED_FLAGS[removed] : undefined
  if (sharedEnded) {
    clearLocalState({ everything: true })
    showSharedEnded(appRoot, sharedEnded, signIn)
    return
  }
  const status = await getMobileCloudAccountStatus()
  if (status.state !== 'connected' || !status.account) {
    showSignIn(appRoot, signIn, null, sharedIntent())
    // A sign-in this tab started can finish in another (the verification
    // link opens one): that tab says so here.
    onAccountAnnouncement((message) => {
      if (message.type === 'signed-in') showSignedInElsewhere(appRoot)
    })
    return
  }
  const pickerAccount = status.account
  const showPicker = (): void => {
    showVaultPicker(appRoot, {
      email: pickerAccount.user.email,
      load: loadPickableVaults,
      onOpen: async (vault) => {
        if (!vault.locked) {
          await openCloudVault(vault, pickerAccount)
          return
        }
        await askToUnlock(pickerAccount, null)
        // Names can be read now. One encrypted vault is the one asked for;
        // with several, the placeholder gave no way to choose, so the list
        // comes back with the real names.
        const encrypted = (await listMobileCloudVaults()).filter((candidate) => candidate.encryption)
        const only = encrypted.length === 1 ? encrypted[0] : undefined
        if (only) await openCloudVault({ id: only.id, name: only.name, encrypted: true }, pickerAccount)
        else showPicker()
      },
      onCreate: async (name) => {
        const created = (await (await authenticatedClient()).createVault(name)).data
        await openCloudVault({ id: created.id, name: created.name || name }, pickerAccount)
      },
      onSignOut: signOutFromScreen
    })
  }
  showPicker()
}

async function openTry(): Promise<void> {
  await waitForWipe()
  const existing = await findBrowserVault(TRY_VAULT_KEY)
  if (existing?.kind === 'cloud') {
    // Try's vault was kept in Cloud: it opens with the signed-in app now.
    location.replace(`/?vault=${encodeURIComponent(TRY_VAULT_KEY)}`)
    return
  }
  const entry: BrowserVaultEntry = existing ?? { key: TRY_VAULT_KEY, name: TRY_VAULT_NAME, kind: 'try', lastOpenedAt: Date.now() }
  if (!existing) await saveBrowserVault(entry)
  await openEntry(entry)
}

function openedByThisApp(): boolean {
  try {
    return !!window.opener && (window.opener as Window).location.origin === location.origin
  } catch {
    return false
  }
}

async function boot(): Promise<void> {
  if (!originAllowed()) {
    showBootError(appRoot, 'ZenNotes in your browser runs at app.zennotes.org.')
    return
  }
  // First, before any await: the code leaves the address bar and history.
  const callback = captureAuthCallback()
  if (!callback && location.pathname !== '/' && location.pathname !== '/try') {
    location.replace(`/${location.search}${location.hash}`)
    return
  }
  const storage = await probeStorage()
  if (storage !== 'ok') {
    showNoStorage(appRoot, storage)
    return
  }
  const pendingRemoval = readPendingRemoval(tabStorage())
  if (pendingRemoval) {
    await retryPendingRemoval(pendingRemoval)
    return
  }
  await finishLocalScrub()
  const sharedSession = await settleSharedSession(async () => {
    await idbPut('preferences', WIPING_KEY, String(Date.now())).catch(() => undefined)
    await wipeEverythingInBrowser({ closeOpenVault: () => {} })
  })
  if (sharedSession === 'open-elsewhere') {
    showSharedOpenElsewhere(appRoot)
    // Once the person signs out over there, this tab is free to start over.
    const stop = onAccountAnnouncement((message) => {
      if (message.type !== 'wiped') return
      stop()
      void waitForSharedRecordGone().then(() => location.reload())
    })
    return
  }
  await ensureServiceWorkerControl()
  await loadKeepAttachments()
  await loadLockOnClose()

  const params = new URLSearchParams(location.search)
  const exportNotePath = params.get('exportNote')
  if (exportNotePath && !callback) {
    const key = params.get('vault') ?? (location.pathname === '/try' ? TRY_VAULT_KEY : await currentBrowserVaultKey()) ?? TRY_VAULT_KEY
    const exported = await findBrowserVault(key)
    // A locked vault stays off the screen: only the tab that has it open
    // opens its print window.
    if (exported?.encrypted && !openedByThisApp()) {
      showBootError(appRoot, 'Open this note in ZenNotes to export it.')
      return
    }
    const name = exported?.name ?? TRY_VAULT_NAME
    const [{ createExportBridge }, { renderExportNoteWindow }] = await Promise.all([
      import('./export-bridge'),
      import('../export-window')
    ])
    installZenBridge(await createExportBridge(key, name))
    renderExportNoteWindow(appRoot, exportNotePath)
    // The note on screen is part of what signing out removes.
    if (isSharedSession()) {
      onAccountAnnouncement((message) => {
        if (message.type === 'wiped') window.close()
      })
    }
    return
  }

  if (callback) {
    await finishSignIn(callback)
    return
  }
  if (location.pathname === '/try') {
    await openTry()
    return
  }
  await openHome()
}

boot().catch((error: unknown) => {
  console.error('[zen] boot failed', error)
  clearScreen()
  showBootError(appRoot, error instanceof Error ? error.message : String(error))
})

