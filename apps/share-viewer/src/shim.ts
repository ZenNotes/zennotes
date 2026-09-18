import DOMPurify from 'dompurify'
import type { ZenAppInfo, ZenBridge, ZenCapabilities } from '@bridge-contract/bridge'
import type { TikzRenderResponse } from '@shared/ipc'
import appPackage from '../package.json'
import type { SharePagePayload } from './payload'

const VIEWER_CAPABILITIES: ZenCapabilities = {
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

const VIEWER_APP_INFO: ZenAppInfo = {
  name: 'zennotes-share-viewer',
  productName: 'ZenNotes',
  version: appPackage.version,
  description: 'Read-only viewer for shared ZenNotes',
  homepage: 'https://zennotes.org',
  runtime: 'web'
}

/**
 * sha1 hex matching Node's createHash('sha1') output. WebCrypto when
 * available; plain-JS fallback because crypto.subtle only exists in
 * secure contexts and local dev serves over plain http (zennotes.test).
 */
async function sha1Hex(input: string): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input))
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  }
  return sha1HexSync(input)
}

function sha1HexSync(input: string): string {
  const bytes = new TextEncoder().encode(input)
  const byteLength = bytes.length
  const totalLength = Math.ceil((byteLength + 9) / 64) * 64
  const padded = new Uint8Array(totalLength)
  padded.set(bytes)
  padded[byteLength] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(totalLength - 8, Math.floor((byteLength * 8) / 0x100000000))
  view.setUint32(totalLength - 4, (byteLength * 8) >>> 0)

  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0
  const words = new Uint32Array(80)
  const rotl = (x: number, n: number): number => ((x << n) | (x >>> (32 - n))) >>> 0

  for (let offset = 0; offset < totalLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) words[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 80; i += 1) {
      words[i] = rotl(words[i - 3]! ^ words[i - 8]! ^ words[i - 14]! ^ words[i - 16]!, 1)
    }
    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    for (let i = 0; i < 80; i += 1) {
      let f: number
      let k: number
      if (i < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      } else if (i < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = b ^ c ^ d
        k = 0xca62c1d6
      }
      const next = (rotl(a, 5) + (f >>> 0) + e + k + words[i]!) >>> 0
      e = d
      d = c
      c = rotl(b, 30)
      b = a
      a = next
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
  }

  return [h0, h1, h2, h3, h4].map((part) => part.toString(16).padStart(8, '0')).join('')
}

function decodeRef(href: string): string {
  const cleaned = href.split('#')[0]?.split('?')[0] ?? href
  try {
    return decodeURIComponent(cleaned)
  } catch {
    return cleaned
  }
}

function lookupAsset(payload: SharePagePayload, href: string): string | null {
  const direct = Object.hasOwn(payload.assets, href) ? payload.assets[href] : null
  if (direct && /^https?:\/\//i.test(direct)) return direct
  const ref = decodeRef(href)
  const decoded = Object.hasOwn(payload.assets, ref) ? payload.assets[ref] : null
  const value = decoded ?? null
  return value && /^https?:\/\//i.test(value) ? value : null
}

/**
 * Install a minimal `window.zen` so app-core's Preview pipeline renders
 * a shared note exactly like the app does:
 *
 * - `renderTikz` substitutes the pre-rendered (and sanitized) SVG the
 *   publisher uploaded, keyed by sha1 of the fence body.
 * - asset URL resolution maps markdown refs onto the share's public
 *   asset URLs.
 * - everything else is inert; this is a read-only page.
 */
export function installShareViewerBridge(payload: SharePagePayload): void {
  const overrides: Partial<ZenBridge> = {
    getCapabilities: () => VIEWER_CAPABILITIES,
    getConfigSync: () => null,
    getAppInfo: () => VIEWER_APP_INFO,
    platformSync: () => 'linux' as const,
    platform: async () => 'linux' as const,
    listCustomCodeLanguages: async () => [],
    readWorkspaceState: async () => null,

    renderTikz: async (source: string): Promise<TikzRenderResponse> => {
      const svg = payload.tikz[await sha1Hex(source)]
      if (!svg) {
        return { ok: false, error: 'This TikZ diagram is not available on the shared page.' }
      }
      const sanitized = DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true }
      })
      return { ok: true, svg: sanitized }
    },

    resolveVaultAssetUrl: (_vaultRoot: string, assetPath: string): string | null =>
      lookupAsset(payload, assetPath),
    resolveLocalAssetUrl: (_vaultRoot: string, _notePath: string, href: string): string | null =>
      lookupAsset(payload, href),
    getPathForFile: () => null,

    clipboardWriteText: (text: string): void => {
      void navigator.clipboard?.writeText(text)
    },
    clipboardReadText: (): string => ''
  }

  // Only the Preview read/copy surface exists. An unsupported mutation must
  // fail instead of claiming that a write to a public share succeeded.
  window.zen = Object.freeze(overrides) as ZenBridge

}
