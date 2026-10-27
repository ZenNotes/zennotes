import type { ZenAppInfo, ZenBridge, ZenCapabilities } from '@bridge-contract/bridge'
import type { TikzRenderResponse } from '@shared/ipc'
import appPackage from '../package.json'
import { QUICKLOOK_ASSET_PREFIX, type QuickLookPayload } from './payload'

const QUICKLOOK_CAPABILITIES: ZenCapabilities = {
  supportsUpdater: false,
  supportsNativeMenus: false,
  supportsFloatingWindows: false,
  supportsLocalFilesystemPickers: false,
  supportsRemoteWorkspace: false,
  supportsCliInstall: false,
  supportsCustomTemplates: false,
  supportsCloudSync: false,
  supportsCustomCodeLanguages: false
}

const QUICKLOOK_APP_INFO: ZenAppInfo = {
  name: 'zennotes-quicklook',
  productName: 'ZenNotes',
  version: appPackage.version,
  description: 'Quick Look preview for Markdown files',
  homepage: 'https://zennotes.org',
  runtime: 'web'
}

/** A reference's file path: no query or fragment, percent-decoded. */
export function decodeRef(href: string): string {
  const cleaned = href.split('#')[0]?.split('?')[0] ?? href
  try {
    return decodeURIComponent(cleaned)
  } catch {
    return cleaned
  }
}

/** The URL the extension serves a referenced file from, or null: a file it
 *  did not find (or will not serve) is shown as missing, never fetched. */
export function lookupQuickLookAsset(payload: Pick<QuickLookPayload, 'assets'>, href: string): string | null {
  for (const ref of [href, decodeRef(href)]) {
    const url = Object.hasOwn(payload.assets, ref) ? payload.assets[ref] : null
    if (url?.startsWith(QUICKLOOK_ASSET_PREFIX)) return url
  }
  return null
}

/**
 * A minimal `window.zen` for app-core's Preview pipeline: asset references
 * resolve to the files the extension found next to the note, and everything
 * that would change the vault is absent, since a preview is read-only.
 */
export function installQuickLookBridge(payload: QuickLookPayload): void {
  const bridge: Partial<ZenBridge> = {
    getCapabilities: () => QUICKLOOK_CAPABILITIES,
    getConfigSync: () => null,
    getAppInfo: () => QUICKLOOK_APP_INFO,
    platformSync: () => 'darwin' as const,
    platform: async () => 'darwin' as const,
    listCustomCodeLanguages: async () => [],
    readWorkspaceState: async () => null,
    renderTikz: async (): Promise<TikzRenderResponse> => ({
      ok: false,
      error: 'TikZ diagrams render in ZenNotes. Open the note to see this one.'
    }),
    resolveVaultAssetUrl: (_vaultRoot: string, assetPath: string): string | null =>
      lookupQuickLookAsset(payload, assetPath),
    resolveLocalAssetUrl: (_vaultRoot: string, _notePath: string, href: string): string | null =>
      lookupQuickLookAsset(payload, href),
    getPathForFile: () => null,
    clipboardWriteText: (text: string): void => {
      void navigator.clipboard?.writeText(text)
    },
    clipboardReadText: (): string => ''
  }
  window.zen = Object.freeze(bridge) as ZenBridge
}
