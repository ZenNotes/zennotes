/**
 * ZenNotes in your browser (app.zennotes.org): the second bootstrap of
 * apps/web, built by vite.cloud.config.ts into dist-cloud/. The self-hosted
 * build (../main.tsx) talks to a ZenNotes server; this one keeps the vault in
 * the browser's private file storage (OPFS) through
 * @zennotes/portable-vault, the layer the phones run.
 *
 * Boot order:
 * 1. Refuse any origin but the configured one (and loopback for local runs):
 *    the release files are also reachable under zennotes.org/vendor/..., an
 *    origin shared with the website, where a vault must never live.
 * 2. Firefox private windows have no OPFS: say so and stop.
 * 3. Take control by the service worker, or `/_vault/...` attachment URLs
 *    would reach the network.
 * 4. The PDF export window (`?exportNote=`) reads the vault without owning it.
 * 5. Take the vault's Web Lock, or show "open in another tab" with Use here.
 * 6. Install the bridge, open (and on first visit seed) the vault, render.
 *
 * Phase 2 has one vault, Try mode's, at /try. Cloud sign-in (Phase 4) adds
 * the signed-in vaults at /.
 */
import '@renderer/styles/index.css'
import './cloud.css'
import { installZenBridge, type ZenBridge } from '@zennotes/bridge-contract/bridge'
import { DEMO_TOUR_START_PATH } from '@zennotes/shared-domain/demo-tour'
import { bootPortableVault, createPortableBridge, activePortableVault } from '@zennotes/portable-vault/bridge'
import { requestOpenNote } from '@zennotes/portable-vault/events'
import {
  closeBrowserVault,
  createBrowserHost,
  currentBrowserVault,
  openBrowserVault
} from './browser-host'
import { buildVaultArchive, saveBlob, archiveFolderName } from './download-folder'
import { idbHostStorage } from './idb-storage'
import { clearScreen, showBootError, showNoStorage, showVaultTaken } from './screens'
import { ensureServiceWorkerControl, warmServiceWorkerCache, watchForUpdates } from './sw-register'
import { renderTryBanner } from './try-banner'
import { takeVaultHere, tryAcquireVault, vaultLocksSupported, type HeldVault } from './vault-lock'

const TRY_VAULT = { key: 'try', name: 'Try ZenNotes' } as const
const YIELDED_FLAG = 'zn:vault-yielded:'

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

function takeYieldedFlag(vaultKey: string): boolean {
  try {
    const set = sessionStorage.getItem(YIELDED_FLAG + vaultKey) === '1'
    sessionStorage.removeItem(YIELDED_FLAG + vaultKey)
    return set
  } catch {
    return false
  }
}

function setYieldedFlag(vaultKey: string): void {
  try {
    sessionStorage.setItem(YIELDED_FLAG + vaultKey, '1')
  } catch {
    // storage blocked: the reload shows the lock screen anyway
  }
}

async function downloadCurrentVault(): Promise<void> {
  const open = currentBrowserVault()
  if (!open) throw new Error('No vault is open.')
  const { useToastStore } = await import('@renderer/lib/toast')
  const { blob, fileCount } = await buildVaultArchive(open.fs, open.spec.name)
  const fileName = `${archiveFolderName(open.spec.name)}.zip`
  saveBlob(blob, fileName)
  useToastStore
    .getState()
    .addToast(`Downloaded ${fileName} (${fileCount} ${fileCount === 1 ? 'file' : 'files'}). Unzip it and open the folder as a vault in the app.`, 'success')
}

let rendererReady = false
const afterReady: Array<() => void> = []

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
    }
  }
}

let yielding = false

/** Another tab pressed Use here, or took the lock: save, stop, step aside. */
async function yieldVault(held: HeldVault | null, saveFirst: boolean): Promise<void> {
  if (yielding) return
  yielding = true
  if (saveFirst) {
    try {
      const { useStore } = await import('@renderer/store')
      await useStore.getState().flushDirtyNotes()
    } catch (error) {
      console.warn('[zen] saving before handing the vault over failed', error)
    }
  }
  closeBrowserVault()
  held?.release()
  setYieldedFlag(TRY_VAULT.key)
  location.reload()
}

async function openTryVault(held: HeldVault): Promise<void> {
  await openBrowserVault({ key: TRY_VAULT.key, name: TRY_VAULT.name, generation: held.generation })
  // The tour is seeded once per browser, through the same generateDemoTour
  // the apps' "Generate Demo Tour" command runs; deleting it later sticks.
  const preferences = idbHostStorage('preferences')
  const seededKey = `zn-browser:seeded:${TRY_VAULT.key}`
  if (await preferences.read(seededKey)) return
  const vault = activePortableVault()
  if ((await vault.listNotes()).length === 0) {
    await vault.generateDemoTour()
    whenWorkspaceReady(() => requestOpenNote(DEMO_TOUR_START_PATH))
  }
  await preferences.write(seededKey, new Date().toISOString())
}

async function startApp(held: HeldVault): Promise<void> {
  const host = createBrowserHost(() => openTryVault(held))
  installZenBridge(browserBridge(createPortableBridge(host)))
  await bootPortableVault()
  held.onUseHereRequest(() => void yieldVault(held, true))
  // Stolen after the timeout: whatever was in flight is fenced off already.
  void held.lost.then(() => yieldVault(null, false))

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

  renderTryBanner(bannerRoot, async () => {
    try {
      await downloadCurrentVault()
    } catch (error) {
      const { useToastStore } = await import('@renderer/lib/toast')
      useToastStore.getState().addToast(error instanceof Error ? error.message : 'Could not download the vault.', 'error')
    }
  })
  const { renderZenNotesApp } = await import('@zennotes/app-core/main')
  renderZenNotesApp(appRoot)
  // After the app is up, never in its way.
  setTimeout(warmServiceWorkerCache, 5000)

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
      const { useStore } = await import('@renderer/store')
      await useStore.getState().flushDirtyNotes()
      return !Object.values(useStore.getState().noteDirty).some(Boolean)
    }
  )
}

async function boot(): Promise<void> {
  if (!originAllowed()) {
    showBootError(appRoot, 'ZenNotes in your browser runs at app.zennotes.org.')
    return
  }
  // Phase 2 serves Try mode only; the signed-in app joins it at / in Phase 4.
  if (location.pathname !== '/try') {
    location.replace(`/try${location.search}${location.hash}`)
    return
  }
  const storage = await probeStorage()
  if (storage !== 'ok') {
    showNoStorage(appRoot, storage)
    return
  }
  await ensureServiceWorkerControl()

  const params = new URLSearchParams(location.search)
  const exportNotePath = params.get('exportNote')
  if (exportNotePath) {
    const [{ createExportBridge }, { renderExportNoteWindow }] = await Promise.all([
      import('./export-bridge'),
      import('../export-window')
    ])
    installZenBridge(await createExportBridge(TRY_VAULT.key, TRY_VAULT.name))
    renderExportNoteWindow(appRoot, exportNotePath)
    return
  }

  const movedAway = takeYieldedFlag(TRY_VAULT.key)
  const held = movedAway ? null : await tryAcquireVault(TRY_VAULT.key)
  if (held) {
    await startApp(held)
    return
  }
  showVaultTaken(appRoot, movedAway, async () => {
    const taken = await takeVaultHere(TRY_VAULT.key)
    clearScreen()
    await startApp(taken)
  })
}

boot().catch((error: unknown) => {
  console.error('[zen] boot failed', error)
  clearScreen()
  showBootError(appRoot, error instanceof Error ? error.message : String(error))
})
