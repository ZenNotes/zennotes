/**
 * The browser's side of @zennotes/portable-vault: OPFS behind
 * VaultFileSystem (opfs-fs.ts, through the OPFS worker), IndexedDB behind
 * HostStorage and SecretStorage (idb-storage.ts), fetch behind HttpTransport
 * (http-fetch.ts), and the page's own events behind AppLifecycle.
 *
 * Capabilities are the phones' minus a self-hosted remote workspace and the
 * folder pickers, with Harper on. Cloud sync stays off until Phase 4 (sign-in
 * and sync in the browser, docs/ideas/cloud-in-browser.md); the Try vault
 * lives only in this browser.
 */
import type { ZenAppInfo } from '@zennotes/bridge-contract/bridge'
import type { LocalVaultEntry, VaultInfo } from '@zennotes/bridge-contract/ipc'
import { openPortableVault, describeCurrentVault } from '@zennotes/portable-vault/bridge'
import type { AppLifecycle, HostCloudConfig, HostShell, HostVaults, PortableHost } from '@zennotes/portable-vault/host'
import appPackage from '../../package.json'
import { fetchTransport } from './http-fetch'
import { idbHostStorage, idbSecretStorage } from './idb-storage'
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

// Cloud is off in this build (supportsCloudSync false below), so nothing reads
// this yet. Phase 4 adds 'web' to the platform unions in shared-domain's
// cloud-auth-flow.ts and the package's HostCloudConfig, and drops the cast.
const cloud: HostCloudConfig = {
  platform: 'web' as unknown as HostCloudConfig['platform'],
  deviceName: 'ZenNotes in your browser',
  developmentBaseUrl: import.meta.env.VITE_ZENNOTES_CLOUD_DEV_URL as string | undefined,
  allowInsecureLoopback: import.meta.env.DEV,
  accountKeyScheme: 'hashed'
}

const shell: HostShell = {
  appInfo,
  platform: browserPlatform(),
  capabilities: {
    supportsRemoteWorkspace: false,
    supportsLocalFilesystemPickers: false,
    supportsCloudSync: false,
    supportsHarper: true
  },
  listSystemFonts: async () => [...BROWSER_FONTS],
  updatesMessage: 'ZenNotes in your browser updates itself. When a new version is ready it asks you to reload.',
  unavailableWhere: 'in the browser',
  drawingsViewOnly: () => false,
  writeClipboard: async (text) => {
    await navigator.clipboard.writeText(text)
  },
  openExternal: async (url) => {
    window.open(url, '_blank', 'noopener,noreferrer')
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
  cloud
}

const activeListeners: Array<(active: boolean) => void> = []

const lifecycle: AppLifecycle = {
  // Phase 4 answers the sign-in callback route here.
  async onOpenUrl() {},
  async launchUrl() {
    return null
  },
  async onActiveChange(listener) {
    activeListeners.push(listener)
  },
  // A hidden tab keeps running in the browser; Phase 4 starts the final push
  // from here.
  leftApp() {},
  returnedToApp() {}
}

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

function describeRoot(): string {
  return 'In this browser'
}

export function createBrowserHost(openDefault: () => Promise<void>): PortableHost {
  const vaults: HostVaults = {
    openDefault,
    async list(): Promise<LocalVaultEntry[]> {
      if (!current) return []
      return [{ root: `${BROWSER_ROOT_PREFIX}${current.spec.key}`, name: current.spec.name, lastOpenedAt: Date.now() }]
    },
    async open(root: string): Promise<VaultInfo> {
      if (current && root === `${BROWSER_ROOT_PREFIX}${current.spec.key}`) {
        return (await describeCurrentVault()) ?? current.info
      }
      throw new Error('This browser has one vault open at a time for now.')
    },
    pick: async () => null,
    async select(): Promise<VaultInfo> {
      throw new Error('Vaults in this browser are opened from ZenNotes Cloud.')
    },
    async browse(path: string) {
      return {
        currentPath: path || BROWSER_ROOT_PREFIX,
        parentPath: null,
        entries: current ? [{ name: current.spec.name, path: `${BROWSER_ROOT_PREFIX}${current.spec.key}` }] : [],
        shortcuts: []
      }
    },
    describeRoot,
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
    http: fetchTransport,
    storage: idbHostStorage('storage'),
    preferences: idbHostStorage('preferences'),
    secrets: idbSecretStorage(),
    vaults
  }
}
