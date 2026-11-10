/**
 * The browser's side of @zennotes/portable-vault: OPFS behind
 * VaultFileSystem and SyncFastPath (opfs-fs.ts, through the OPFS worker),
 * IndexedDB behind HostStorage and SecretStorage (idb-storage.ts), fetch
 * behind HttpTransport (http-fetch.ts), and the page's own events behind
 * AppLifecycle.
 *
 * Capabilities are the phones' minus a self-hosted remote workspace and the
 * folder pickers, with Harper on and ZenNotes Cloud on: the browser signs in
 * as a `web` device (cloud-account.ts) and syncs readable and end-to-end
 * encrypted vaults, with large attachments downloaded when they are opened
 * (cloud-sync-stubs.ts in the package). Try mode's vault lives only in this
 * browser until it is kept in Cloud.
 */
import type { ZenAppInfo } from '@zennotes/bridge-contract/bridge'
import type { LocalVaultEntry, VaultInfo } from '@zennotes/bridge-contract/ipc'
import { openPortableVault, describeCurrentVault } from '@zennotes/portable-vault/bridge'
import type {
  AppLifecycle,
  HostCloudConfig,
  HostShell,
  HostVaults,
  HttpTransport,
  PortableHost
} from '@zennotes/portable-vault/host'
import appPackage from '../../package.json'
import { BROWSER_SIGN_IN_LIFETIME_MS, browserDeviceName, cloudCallbackUrl } from './cloud-account'
import { revocationAwareTransport } from './cloud-session'
import { deriveInWorker } from './argon2-client'
import { browserSecrets } from './browser-keys'
import { keepsAttachments } from './browser-storage'
import { listBrowserVaults, type BrowserVaultEntry } from './browser-vaults'
import { fetchTransport } from './http-fetch'
import { idbHostStorage } from './idb-storage'
import { OpfsVaultFileSystem, workerTransport } from './opfs-fs'
import { saveBlob } from './download-folder'

export const BROWSER_ROOT_PREFIX = 'browser://vaults/'

function browserPlatform(): HostShell['platform'] {
  const ua = navigator.userAgent.toLowerCase()
  if (ua.includes('mac') || ua.includes('iphone') || ua.includes('ipad')) return 'darwin'
  if (ua.includes('win')) return 'win32'
  return 'linux'
}

function appInfo(): ZenAppInfo {
  return {
    name: appPackage.name,
    productName: 'ZenNotes',
    version: appPackage.version,
    description: 'ZenNotes in your browser',
    homepage: appPackage.homepage,
    runtime: 'web',
    hostKind: 'browser',
    // The user agent names the browser and the OS, the lines a bug report
    // from a browser needs beside the app version (#814).
    ...(navigator.userAgent ? { engine: navigator.userAgent } : {})
  }
}

/** The families the font picker offers: a page cannot enumerate fonts. */
const BROWSER_FONTS = [
  'Arial',
  'Avenir',
  'Charter',
  'Georgia',
  'Helvetica',
  'Helvetica Neue',
  'Iowan Old Style',
  'JetBrains Mono',
  'Menlo',
  'Monaco',
  'SF Mono',
  'SF Pro Text',
  'Segoe UI',
  'Times New Roman',
  'Verdana'
]

function cloudConfig(): HostCloudConfig {
  return {
    platform: 'web',
    deviceName: browserDeviceName(navigator.userAgent).slice(0, 255),
    callbackUrl: cloudCallbackUrl(),
    authLifetimeMs: BROWSER_SIGN_IN_LIFETIME_MS,
    developmentBaseUrl: import.meta.env.VITE_ZENNOTES_CLOUD_DEV_URL as string | undefined,
    allowInsecureLoopback: import.meta.env.DEV,
    accountKeyScheme: 'hashed'
  }
}

/** What the page decides around the host: main.tsx fills these in. */
export interface BrowserHostHooks {
  /** Before the tab leaves for the website's sign-in page. */
  beforeLeavingForSignIn(): Promise<void>
  /** The tab went to the background: start the final push. */
  leftApp(): void
  returnedToApp(): void
  /** Cloud said this browser was removed from the account. */
  revoked(): void
  /** Open another of this browser's vaults (a page load of its own). */
  switchTo(entry: BrowserVaultEntry): void
}

const activeListeners: Array<(active: boolean) => void> = []

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    const active = document.visibilityState === 'visible'
    for (const listener of activeListeners) listener(active)
  })
}

export interface BrowserVaultSpec {
  key: string
  name: string
  generation: number
}

export interface OpenBrowserVault {
  spec: BrowserVaultSpec
  fs: OpfsVaultFileSystem
  info: VaultInfo
}

let current: OpenBrowserVault | null = null

export function currentBrowserVault(): OpenBrowserVault | null {
  return current
}

/** Opens the vault in its own OPFS worker and makes it the bridge's vault. */
export async function openBrowserVault(spec: BrowserVaultSpec): Promise<OpenBrowserVault> {
  const worker = new Worker(new URL('./opfs-worker.ts', import.meta.url), {
    type: 'module',
    name: `zennotes-vault-${spec.key}`
  })
  const fs = new OpfsVaultFileSystem(spec.key, workerTransport(worker), { generation: spec.generation })
  try {
    const info = await openPortableVault(spec.name, fs)
    current?.fs.close()
    current = { spec, fs, info }
    return current
  } catch (error) {
    fs.close()
    throw error
  }
}

/** Stops the open vault's worker: nothing this tab does can write to it. */
export function closeBrowserVault(): void {
  current?.fs.close()
  current = null
}

export function rootOf(key: string): string {
  return `${BROWSER_ROOT_PREFIX}${key}`
}

function keyOfRoot(root: string): string | null {
  return root.startsWith(BROWSER_ROOT_PREFIX) ? root.slice(BROWSER_ROOT_PREFIX.length) : null
}

/** Uploads a large file by streaming it from OPFS: the worker checks it is
 *  still the bytes sync planned (never a stub) and hands the File over. */
function withOpfsUploads(base: HttpTransport): HttpTransport {
  return {
    ...base,
    async putFile(options) {
      if (options.uri === undefined) throw new Error('ZenNotes in the browser uploads files from the vault only.')
      const open = current
      if (!open) throw new Error('No vault is open in this tab.')
      const file = await open.fs.fileForUpload(options.uri, options.sha256, options.byteLength)
      const response = await fetch(options.url, {
        method: 'PUT',
        headers: options.headers,
        body: file as unknown as Blob,
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error'
      })
      return { status: response.status }
    },
    putsInMemoryBodies: false
  }
}

export function createBrowserHost(openDefault: () => Promise<void>, hooks: BrowserHostHooks): PortableHost {
  const shell: HostShell = {
    appInfo,
    platform: browserPlatform(),
    capabilities: {
      supportsRemoteWorkspace: false,
      supportsLocalFilesystemPickers: false,
      supportsCloudSync: true,
      supportsHarper: true
    },
    listSystemFonts: async () => [...BROWSER_FONTS],
    updatesMessage: 'ZenNotes in your browser updates itself. When a new version is ready it asks you to reload.',
    unavailableWhere: 'in the browser',
    tikzAssetBase: `${import.meta.env.BASE_URL}tikzjax/`,
    drawingsViewOnly: () => false,
    writeClipboard: async (text) => {
      await navigator.clipboard.writeText(text)
    },
    // The only page the package opens is Cloud's sign-in, and a browser
    // signs in in this tab: the website sends it back to /auth/callback.
    openExternal: async (url) => {
      await hooks.beforeLeavingForSignIn()
      location.assign(url)
      // The page is leaving; nothing after this should run.
      await new Promise(() => {})
    },
    async saveDownload({ url, headers, fileName, connectTimeout, readTimeout }) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), connectTimeout + readTimeout)
      try {
        const response = await fetch(url, { headers, credentials: 'omit', signal: controller.signal })
        if (!response.ok) throw new Error(`The download failed (${response.status}).`)
        saveBlob(await response.blob(), fileName)
      } finally {
        clearTimeout(timer)
      }
    },
    cloud: cloudConfig()
  }

  const lifecycle: AppLifecycle = {
    // The callback page completes a sign-in before the app boots (main.tsx).
    async onOpenUrl() {},
    async launchUrl() {
      return null
    },
    async onActiveChange(listener) {
      activeListeners.push(listener)
    },
    // A hidden tab keeps running: leaving starts the final push and Cloud
    // requests go on (the phones stop theirs once the app is suspended).
    leftApp: () => hooks.leftApp(),
    returnedToApp: () => hooks.returnedToApp()
  }

  const vaults: HostVaults = {
    openDefault,
    async list(): Promise<LocalVaultEntry[]> {
      const entries = await listBrowserVaults()
      if (current && !entries.some((entry) => entry.key === current!.spec.key)) {
        return [{ root: rootOf(current.spec.key), name: current.spec.name, lastOpenedAt: Date.now() }]
      }
      return entries
        .sort((left, right) => right.lastOpenedAt - left.lastOpenedAt)
        .map((entry) => ({ root: rootOf(entry.key), name: entry.name, lastOpenedAt: entry.lastOpenedAt }))
    },
    async open(root: string): Promise<VaultInfo> {
      if (current && root === rootOf(current.spec.key)) {
        return (await describeCurrentVault()) ?? current.info
      }
      const key = keyOfRoot(root)
      const entry = key ? (await listBrowserVaults()).find((candidate) => candidate.key === key) : undefined
      if (!entry) throw new Error('That vault is not in this browser.')
      // One vault per tab, each under its own lock: switching is a load.
      hooks.switchTo(entry)
      return await new Promise<VaultInfo>(() => {})
    },
    pick: async () => null,
    async select(): Promise<VaultInfo> {
      throw new Error('Vaults in this browser are opened from ZenNotes Cloud.')
    },
    async browse(path: string) {
      const entries = await listBrowserVaults()
      return {
        currentPath: path || BROWSER_ROOT_PREFIX,
        parentPath: null,
        entries: entries.map((entry) => ({ name: entry.name, path: rootOf(entry.key) })),
        shortcuts: []
      }
    },
    // app-core keys a vault's workspace, recents and per-vault settings by its
    // root, so each browser vault has its own: the one list() hands out.
    describeRoot: (vault) => {
      const key = (vault.fs as { vaultKey?: unknown }).vaultKey
      return typeof key === 'string' ? rootOf(key) : 'In this browser'
    },
    async openAssetExternally(relPath) {
      const url = current?.fs.fileSrc(relPath)
      if (!url) return { ok: false, error: 'That file is not in this vault.' }
      window.open(url, '_blank', 'noopener')
      return { ok: true }
    }
  }

  return {
    shell,
    lifecycle,
    http: revocationAwareTransport(withOpfsUploads(fetchTransport), () => hooks.revoked()),
    storage: idbHostStorage('storage'),
    preferences: idbHostStorage('preferences'),
    secrets: browserSecrets,
    vaults,
    cloudStubs: { enabled: () => !keepsAttachments() },
    passphraseKdf: deriveInWorker
  }
}
